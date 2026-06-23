import type { AgentApproval } from "@prisma/client";
import { ApprovalStatus } from "@prisma/client";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import * as incidentRepo from "../repositories/incident.repository.js";
import { errorSummary } from "../utils/retry.js";
import * as agentService from "./agent.service.js";
import * as audit from "./audit.service.js";
import * as glpi from "./glpi.service.js";
import * as slackBot from "./slack-bot.service.js";
import * as telegram from "./telegram.service.js";
import * as trello from "./trello.service.js";

/**
 * Ciclo de aprovação de permissões dos agentes.
 *
 * Quando um agente é bloqueado pelo CLI (ex.: quer escrever arquivo ou rodar
 * um comando e o modo não-interativo nega), registramos uma pendência:
 *  - o chamado vai para PENDENTE no GLPI, com um followup explicando o pedido;
 *  - o card correspondente vai para a lista "Pendente" no Trello;
 *  - o usuário aprova/nega pelo chat, Telegram ou pelo próprio chamado.
 * Ao aprovar, o agente é reexecutado com permissões elevadas.
 */

/** Envia um aviso para a sessão certa (telegram:<id>, slack:<id> ou web). */
export async function notifyChannel(channel: string, text: string): Promise<void> {
  if (channel.startsWith("telegram:")) {
    await telegram.sendMessage(channel.slice("telegram:".length), text);
  } else if (channel.startsWith("slack:")) {
    await slackBot.sendMessage(channel.slice("slack:".length), text);
  }
  // "web": aparece na própria UI (followup + lista de pendências), sem push.
}

/** Marca qual sessão é dona de um chamado (para roteamento de aprovações). */
export async function setTicketOwner(glpiTicketId: number, channel: string): Promise<void> {
  if (!channel || channel === "web") {
    // web não recebe push; ainda assim registramos para não cair no broadcast
  }
  await prisma.ticketChannel.upsert({
    where: { glpiTicketId },
    create: { glpiTicketId, channel },
    update: { channel },
  });
}

/** Cria (ou reaproveita) uma pendência para um chamado e move card/ticket. */
export async function openApproval(input: {
  agentId: string;
  glpiTicketId: number;
  runId?: string;
  summary: string;
  detail?: string;
}): Promise<AgentApproval> {
  // Evita duplicar: se já há pendência aberta para o chamado, atualiza-a
  const existing = await prisma.agentApproval.findFirst({
    where: { glpiTicketId: input.glpiTicketId, status: ApprovalStatus.PENDING },
  });

  const approval = existing
    ? await prisma.agentApproval.update({
        where: { id: existing.id },
        data: { summary: input.summary, detail: input.detail, runId: input.runId ?? existing.runId },
      })
    : await prisma.agentApproval.create({
        data: {
          agentId: input.agentId,
          glpiTicketId: input.glpiTicketId,
          runId: input.runId,
          summary: input.summary,
          detail: input.detail,
        },
      });

  const note = [
    "⏸️ <b>Agente aguardando sua aprovação</b>",
    `O agente precisa de permissão para: <b>${input.summary}</b>.`,
    "Para liberar, responda <b>aprovar</b> neste chamado, ou diga ao Gerente no chat/Telegram " +
      `algo como "aprovar o chamado #${input.glpiTicketId}". Para recusar, diga "negar".`,
  ].join("<br>");

  try {
    await glpi.addFollowup(input.glpiTicketId, note);
    await glpi.updateTicketStatus(input.glpiTicketId, glpi.GLPI_TICKET_STATUS.PENDING);
  } catch (error) {
    logger.error({ err: errorSummary(error), ticketId: input.glpiTicketId }, "Falha ao registrar pendência no GLPI");
  }

  // Move o card para a lista "Pendente"
  try {
    const incident = await incidentRepo.findByGlpiTicketId(input.glpiTicketId);
    if (incident?.trelloCardId && env.TRELLO_LIST_ID_PENDING) {
      await trello.moveCardToList(incident.trelloCardId, env.TRELLO_LIST_ID_PENDING);
      await trello.addComment(
        incident.trelloCardId,
        `⏸️ Agente aguardando aprovação: ${input.summary}`,
      );
    }
  } catch (error) {
    logger.error({ err: errorSummary(error), ticketId: input.glpiTicketId }, "Falha ao mover card para Pendente");
  }

  // Roteia o pedido para a SESSÃO dona do chamado (quem iniciou a ação).
  // Se não soubermos o dono, avisa em todos os canais conhecidos (não perder).
  const aviso = `⏸️ Agente aguardando aprovação no chamado #${input.glpiTicketId}:\n${input.summary}\n\nResponda "aprovar #${input.glpiTicketId}" ou "negar #${input.glpiTicketId}".`;
  const owner = await prisma.ticketChannel.findUnique({ where: { glpiTicketId: input.glpiTicketId } });
  if (owner) {
    await notifyChannel(owner.channel, aviso);
  } else {
    await Promise.allSettled([telegram.broadcast(aviso), slackBot.broadcast(aviso)]);
  }

  logger.info({ approvalId: approval.id, ticketId: input.glpiTicketId }, "Pendência de aprovação registrada");
  return approval;
}

export function listPending(): Promise<AgentApproval[]> {
  return prisma.agentApproval.findMany({
    where: { status: ApprovalStatus.PENDING },
    orderBy: { createdAt: "asc" },
  });
}

export function findPendingByTicket(glpiTicketId: number): Promise<AgentApproval | null> {
  return prisma.agentApproval.findFirst({
    where: { glpiTicketId, status: ApprovalStatus.PENDING },
  });
}

/**
 * Concede a aprovação e reexecuta o agente com permissões elevadas.
 * Retorna o texto de status para devolver a quem aprovou.
 */
export async function grant(approvalId: string, resolvedBy: string): Promise<string> {
  const approval = await prisma.agentApproval.findUnique({
    where: { id: approvalId },
    include: { agent: true },
  });
  if (!approval) throw new Error("Aprovação não encontrada");
  if (approval.status !== ApprovalStatus.PENDING) {
    return `Essa pendência já foi ${approval.status === ApprovalStatus.GRANTED ? "aprovada" : "negada"}.`;
  }

  await prisma.agentApproval.update({
    where: { id: approvalId },
    data: { status: ApprovalStatus.GRANTED, resolvedBy, resolvedAt: new Date() },
  });
  await audit.record(resolvedBy, "approval.grant", "AgentApproval", approvalId, {
    ticketId: approval.glpiTicketId,
  });

  await glpi.addFollowup(
    approval.glpiTicketId,
    `✅ Aprovação concedida por <b>${resolvedBy}</b>. Reexecutando o agente com permissões elevadas.`,
  );

  // Reexecuta o agente no chamado, agora com elevação
  const ticketId = approval.glpiTicketId;
  const context = await glpi.getTicketContext(ticketId);
  const taskId = await glpi.addTask(
    ticketId,
    `Reexecução elevada do agente ${approval.agent.name} após aprovação em ${new Date().toISOString()}.`,
  );
  const run = await agentService.executeAgent({
    agent: approval.agent,
    kind: "TICKET",
    message:
      "Sua solicitação de permissão foi APROVADA. Prossiga e conclua o trabalho permitido pelo seu perfil.",
    ticketContext: context,
    glpiTicketId: ticketId,
    glpiTaskId: taskId,
    elevated: true,
  });

  const conclusion = [
    `Agente: ${approval.agent.name} (execução elevada)`,
    `Status: ${run.status}`,
    "",
    run.output || run.error || "Execução sem saída.",
  ].join("\n").slice(0, 60_000);
  await glpi.completeTask(taskId, conclusion, Math.ceil((run.durationMs ?? 0) / 1000));

  // Se a execução elevada ainda bloqueou em algo novo, reabre pendência
  const block = agentService.detectPermissionBlock(`${run.output ?? ""}\n${run.error ?? ""}`);
  if (block) {
    await openApproval({
      agentId: approval.agentId,
      glpiTicketId: ticketId,
      runId: run.id,
      summary: block,
      detail: (run.output ?? run.error ?? "").slice(-1500),
    });
    return `Reexecutei o agente, mas ele esbarrou em outra permissão: ${block}. Abri nova pendência no chamado #${ticketId}.`;
  }

  // Chamado volta a EM ANDAMENTO (não PENDENTE) para fechar o ciclo
  await glpi.updateTicketStatus(ticketId, glpi.GLPI_TICKET_STATUS.ASSIGNED);
  return `Aprovação aplicada. Reexecutei o agente ${approval.agent.name} no chamado #${ticketId} com status ${run.status}. O chamado está em andamento.`;
}

export async function deny(approvalId: string, resolvedBy: string): Promise<string> {
  const approval = await prisma.agentApproval.findUnique({ where: { id: approvalId } });
  if (!approval) throw new Error("Aprovação não encontrada");
  if (approval.status !== ApprovalStatus.PENDING) {
    return `Essa pendência já foi ${approval.status === ApprovalStatus.GRANTED ? "aprovada" : "negada"}.`;
  }

  await prisma.agentApproval.update({
    where: { id: approvalId },
    data: { status: ApprovalStatus.DENIED, resolvedBy, resolvedAt: new Date() },
  });
  await audit.record(resolvedBy, "approval.deny", "AgentApproval", approvalId, {
    ticketId: approval.glpiTicketId,
  });
  await glpi.addFollowup(
    approval.glpiTicketId,
    `🚫 Aprovação negada por <b>${resolvedBy}</b>. O agente não prosseguirá com essa ação.`,
  );
  return `Pendência do chamado #${approval.glpiTicketId} negada. O agente não vai prosseguir com essa ação.`;
}
