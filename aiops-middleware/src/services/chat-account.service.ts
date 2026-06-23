import crypto from "node:crypto";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { errorSummary } from "../utils/retry.js";
import * as approval from "./approval.service.js";
import * as glpi from "./glpi.service.js";
import * as settings from "./settings.service.js";

/**
 * Contas GLPI vinculadas a sessões de chat (Telegram/Slack).
 *
 * Uma sessão de chat pode ganhar uma conta de técnico no GLPI. A partir daí:
 *  - todo chamado atribuído a essa conta é anunciado no chat da pessoa;
 *  - a pessoa atualiza o chamado pelo chat (comentar, anexar, finalizar);
 *  - a cada 24h sem atualização, o Gerente cobra um retorno.
 */

async function resolveProfileId(): Promise<number> {
  const rows = await settings.listSettings();
  const configured = Number(rows.find((s) => s.key === "GLPI_AGENT_PROFILE_ID")?.value);
  if (configured) return configured;
  const detected = await glpi.findDefaultAgentProfileId();
  if (!detected) {
    throw new Error("Nenhum perfil Técnico encontrado no GLPI — configure GLPI_AGENT_PROFILE_ID");
  }
  return detected;
}

/** Cria a conta GLPI para uma sessão de chat e devolve as credenciais. */
export async function createAccount(
  channel: string,
  username: string,
  displayName?: string,
): Promise<{ glpiUserId: number; username: string; password: string }> {
  const existing = await prisma.chatAccount.findUnique({ where: { channel } });
  if (existing) throw new Error("Este chat já tem uma conta GLPI vinculada.");

  const normalizedUsername = username.trim();
  if (!/^[a-zA-Z0-9_.@-]{3,64}$/.test(normalizedUsername)) {
    throw new Error("O username deve ter de 3 a 64 caracteres e usar apenas letras, números, ponto, hífen, underline ou @.");
  }
  if (await glpi.findUserByUsername(normalizedUsername)) {
    throw new Error("Este username já existe no GLPI. Use a opção de vincular conta existente.");
  }

  const profileId = await resolveProfileId();
  const label = displayName?.trim() || normalizedUsername;
  const password = crypto.randomBytes(18).toString("base64url");
  const glpiUserId = await glpi.createAgentUser({
    username: normalizedUsername,
    fullName: label,
    password,
    profileId,
  });

  await prisma.chatAccount.create({
    data: {
      channel,
      glpiUserId,
      glpiUsername: normalizedUsername,
      displayName: displayName?.trim() || null,
    },
  });
  logger.info(
    { channel, glpiUserId, username: normalizedUsername },
    "Conta GLPI criada para sessão de chat",
  );
  return { glpiUserId, username: normalizedUsername, password };
}

/** Vincula a sessão a uma conta que já existe no GLPI. */
export async function linkExistingAccount(
  channel: string,
  username: string,
): Promise<{ glpiUserId: number; username: string; displayName: string }> {
  const existingChannel = await prisma.chatAccount.findUnique({ where: { channel } });
  if (existingChannel) throw new Error("Este chat já tem uma conta GLPI vinculada.");

  const user = await glpi.findUserByUsername(username);
  if (!user) throw new Error(`Não encontrei o username "${username.trim()}" no GLPI.`);
  if (!user.active) throw new Error("A conta encontrada está desativada no GLPI.");

  await prisma.chatAccount.create({
    data: {
      channel,
      glpiUserId: user.id,
      glpiUsername: user.username,
      displayName: user.displayName,
    },
  });
  logger.info(
    { channel, glpiUserId: user.id, username: user.username },
    "Conta GLPI existente vinculada à sessão de chat",
  );
  return { glpiUserId: user.id, username: user.username, displayName: user.displayName };
}

export function getAccountByChannel(channel: string) {
  return prisma.chatAccount.findUnique({ where: { channel } });
}

/** Chamados vinculados a esta sessão (a lista de "meus chamados"). */
export function myTickets(channel: string) {
  return prisma.chatTicketLink.findMany({ where: { channel }, orderBy: { createdAt: "desc" } });
}

export async function canManageTicket(channel: string, ticketId: number): Promise<boolean> {
  const account = await getAccountByChannel(channel);
  if (!account) return false;
  const assigned = await glpi.getAssignedUserIds(ticketId);
  const canManage = assigned.includes(account.glpiUserId);
  if (!canManage) return false;

  // O GLPI é a fonte da verdade. Se o chamado já está atribuído à pessoa mas
  // ainda não existe o vínculo local (por atraso no polling, rebuild etc.),
  // cria o link silenciosamente para o chat conseguir atuar no chamado.
  const link = await prisma.chatTicketLink.findUnique({
    where: { glpiTicketId_channel: { glpiTicketId: ticketId, channel } },
  });
  if (!link) {
    const ticket = await glpi.getTicket(ticketId).catch(() => null);
    await prisma.chatTicketLink.create({
      data: { glpiTicketId: ticketId, channel, ticketName: ticket?.name ?? null },
    });
    await approval.setTicketOwner(ticketId, channel).catch(() => undefined);
  }
  return true;
}

export async function assertCanManageTicket(channel: string, ticketId: number): Promise<void> {
  if (!(await canManageTicket(channel, ticketId))) {
    throw new Error(`O chamado #${ticketId} não está atribuído à conta GLPI desta conversa.`);
  }
}

export async function activeTickets(channel: string) {
  const links = await myTickets(channel);
  const active: Array<(typeof links)[number] & { status: number }> = [];
  for (const link of links) {
    const ticket = await glpi.getTicket(link.glpiTicketId).catch(() => null);
    if (!ticket || ticket.status >= glpi.GLPI_TICKET_STATUS.SOLVED) continue;
    if (await canManageTicket(channel, link.glpiTicketId).catch(() => false)) {
      active.push({ ...link, status: ticket.status });
    }
  }
  return active;
}

/**
 * Anuncia ao chat um chamado recém-atribuído à conta dele (uma vez por chamado).
 * Também registra a sessão como dona do chamado (aprovações vêm para cá).
 */
async function announceAssignment(channel: string, ticketId: number, ticketName: string): Promise<void> {
  const exists = await prisma.chatTicketLink.findUnique({
    where: { glpiTicketId_channel: { glpiTicketId: ticketId, channel } },
  });
  if (exists) return;

  await prisma.chatTicketLink.create({
    data: { glpiTicketId: ticketId, channel, ticketName },
  });
  await approval.setTicketOwner(ticketId, channel).catch(() => undefined);
  await approval.notifyChannel(
    channel,
    `🎫 Você foi designado ao chamado #${ticketId}: ${ticketName}\n\n` +
      `Pode me responder aqui para registrar o que fez, enviar arquivos (viram anexos no chamado) ` +
      `ou dizer "pode finalizar" que eu encerro. É só falar comigo normalmente.`,
  );
  logger.info({ channel, ticketId }, "Chamado anunciado ao chat do técnico");
}

/**
 * Verifica os chamados abertos atribuídos a contas de chat e anuncia os novos.
 * Recebe a lista de tickets recentes e uma função para obter os responsáveis.
 */
export async function processAssignments(
  tickets: Array<{ id: number; name: string; status: number }>,
): Promise<void> {
  const accounts = await prisma.chatAccount.findMany();
  if (accounts.length === 0) return;
  const byUser = new Map<number, typeof accounts>();
  for (const account of accounts) {
    const channels = byUser.get(account.glpiUserId) ?? [];
    channels.push(account);
    byUser.set(account.glpiUserId, channels);
  }

  for (const ticket of tickets) {
    if (ticket.status >= glpi.GLPI_TICKET_STATUS.SOLVED) continue;
    let assigned: number[];
    try {
      assigned = await glpi.getAssignedUserIds(ticket.id);
    } catch {
      continue;
    }
    for (const userId of assigned) {
      const linkedAccounts = byUser.get(userId) ?? [];
      for (const account of linkedAccounts) {
        await announceAssignment(account.channel, ticket.id, ticket.name).catch((error) =>
          logger.error(
            { err: errorSummary(error), ticketId: ticket.id, channel: account.channel },
            "Falha ao anunciar chamado ao chat",
          ),
        );
      }
    }
  }
}

const NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;
let lastNudgeScan = 0;

/**
 * Cobra atualização (a cada 24h de inatividade) nos chamados atribuídos a
 * contas de chat. Roda no máximo de hora em hora.
 */
export async function processNudges(): Promise<void> {
  if (Date.now() - lastNudgeScan < 60 * 60 * 1000) return; // no máximo 1x/hora
  lastNudgeScan = Date.now();

  const links = await prisma.chatTicketLink.findMany();
  for (const link of links) {
    try {
      const ticket = await glpi.getTicket(link.glpiTicketId);
      if (!ticket || ticket.status >= glpi.GLPI_TICKET_STATUS.SOLVED) continue;

      // Última atividade = followup mais recente, senão a criação do vínculo
      const followups = await glpi.getFollowups(link.glpiTicketId);
      const lastActivity = followups
        .map((f) => new Date(f.date).getTime())
        .filter(Number.isFinite)
        .sort((a, b) => b - a)[0] ?? link.createdAt.getTime();

      const lastNudge = link.lastNudgeAt?.getTime() ?? link.createdAt.getTime();
      const now = Date.now();
      if (now - lastActivity < NUDGE_AFTER_MS || now - lastNudge < NUDGE_AFTER_MS) continue;

      await approval.notifyChannel(
        link.channel,
        `⏰ Passaram 24h sem atualização no chamado #${link.glpiTicketId}: ${link.ticketName ?? ""}\n\n` +
          `Como está o andamento? Me conta o que avançou que eu registro, ou diga "pode finalizar" se já resolveu.`,
      );
      await prisma.chatTicketLink.update({
        where: { glpiTicketId_channel: { glpiTicketId: link.glpiTicketId, channel: link.channel } },
        data: { lastNudgeAt: new Date() },
      });
      logger.info({ channel: link.channel, ticketId: link.glpiTicketId }, "Cobrança de atualização enviada");
    } catch (error) {
      logger.warn({ err: errorSummary(error), ticketId: link.glpiTicketId }, "Falha ao cobrar atualização");
    }
  }
}
