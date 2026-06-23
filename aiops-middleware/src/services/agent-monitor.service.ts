import { env } from "../config/env.js";
import type { Agent } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { errorSummary } from "../utils/retry.js";
import * as agentService from "./agent.service.js";
import * as approval from "./approval.service.js";
import * as chatAccounts from "./chat-account.service.js";
import * as glpi from "./glpi.service.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

async function shouldRun(agentId: string, ticketId: number): Promise<boolean> {
  // Há pendência de aprovação aberta? O agente fica parado até o humano decidir.
  const pending = await approval.findPendingByTicket(ticketId);
  if (pending) return false;

  const latest = await prisma.agentRun.findFirst({
    where: { agentId, glpiTicketId: ticketId, kind: "TICKET" },
    orderBy: { createdAt: "desc" },
  });
  if (!latest) return true;
  const followups = await glpi.getFollowups(ticketId);
  const newest = followups
    .map((followup) => new Date(followup.date).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  return Boolean(newest && newest > (latest.finishedAt ?? latest.createdAt).getTime());
}

async function processTicket(agent: Agent, ticketId: number) {
  const context = await glpi.getTicketContext(ticketId);
  const taskId = await glpi.addTask(
    ticketId,
    `Execução automática do agente ${agent.name} iniciada em ${new Date().toISOString()}.`,
  );
  const run = await agentService.executeAgent({
    agent,
    kind: "TICKET",
    message: "Analise este chamado e realize o trabalho permitido pelo seu perfil.",
    ticketContext: context,
    glpiTicketId: ticketId,
    glpiTaskId: taskId,
  });
  const conclusion = [
    `Agente: ${agent.name}`,
    `Status: ${run.status}`,
    "",
    run.output || run.error || "Execução sem saída.",
  ].join("\n").slice(0, 60_000);
  await glpi.completeTask(taskId, conclusion, Math.ceil((run.durationMs ?? 0) / 1000));

  // O agente foi bloqueado por falta de permissão dentro do CLI?
  // Abre uma pendência de aprovação (card -> Pendente, aguarda aval humano).
  const block = agentService.detectPermissionBlock(`${run.output ?? ""}\n${run.error ?? ""}`);
  if (block) {
    await approval.openApproval({
      agentId: agent.id,
      glpiTicketId: ticketId,
      runId: run.id,
      summary: block,
      detail: (run.output ?? run.error ?? "").slice(-1500),
    });
    return;
  }

  // Regra de segurança aplicada pelo orquestrador: agente nunca fecha o chamado.
  await glpi.updateTicketStatus(ticketId, glpi.GLPI_TICKET_STATUS.PENDING);
}

export async function runAgentMonitorCycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const [tickets, agents] = await Promise.all([
      glpi.listRecentTickets(),
      prisma.agent.findMany({ where: { enabled: true, glpiUserId: { not: null } } }),
    ]);
    const byUser = new Map(agents.map((agent) => [agent.glpiUserId!, agent]));
    for (const ticket of tickets) {
      if (ticket.status >= glpi.GLPI_TICKET_STATUS.SOLVED) continue;
      const assigned = await glpi.getAssignedUserIds(ticket.id);
      for (const userId of assigned) {
        const agent = byUser.get(userId);
        if (!agent || !(await shouldRun(agent.id, ticket.id))) continue;
        try {
          await processTicket(agent, ticket.id);
        } catch (error) {
          logger.error(
            { err: errorSummary(error), agentId: agent.id, ticketId: ticket.id },
            "Falha na execução automática do agente",
          );
          await glpi.updateTicketStatus(ticket.id, glpi.GLPI_TICKET_STATUS.PENDING).catch(() => undefined);
        }
      }
    }

    // Anuncia chamados atribuídos a contas de chat e cobra atualizações (24h)
    await chatAccounts.processAssignments(tickets).catch((error) =>
      logger.error({ err: errorSummary(error) }, "Falha ao processar atribuições de chat"),
    );
    await chatAccounts.processNudges().catch((error) =>
      logger.error({ err: errorSummary(error) }, "Falha ao processar cobranças de chat"),
    );
  } finally {
    running = false;
  }
}

export function startAgentMonitor(): void {
  if (timer) return;
  timer = setInterval(() => void runAgentMonitorCycle(), env.AGENT_POLL_INTERVAL_MS);
  timer.unref();
  void runAgentMonitorCycle();
}

export function stopAgentMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
