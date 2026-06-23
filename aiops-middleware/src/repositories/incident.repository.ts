import type { Incident, Prisma } from "@prisma/client";
import { IncidentStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/**
 * Camada de acesso a dados de incidentes. Os services nunca falam
 * diretamente com o Prisma Client.
 */

export function findOpenByAlertId(grafanaAlertId: string): Promise<Incident | null> {
  return prisma.incident.findFirst({
    where: { grafanaAlertId, status: IncidentStatus.OPEN },
  });
}

export function findByAlertId(grafanaAlertId: string): Promise<Incident | null> {
  return prisma.incident.findUnique({ where: { grafanaAlertId } });
}

export function findOpenByPrefix(prefix: string): Promise<Incident[]> {
  return prisma.incident.findMany({
    where: { status: IncidentStatus.OPEN, grafanaAlertId: { startsWith: prefix } },
  });
}

export function create(data: {
  grafanaAlertId: string;
  glpiTicketId: number | null;
  trelloCardId: string | null;
  aiAnalysis: Prisma.InputJsonValue;
}): Promise<Incident> {
  return prisma.incident.create({
    data: { ...data, status: IncidentStatus.OPEN },
  });
}

/**
 * Upsert para reaberturas: se o alerta já existiu e foi resolvido,
 * reabre o registro com os novos ids de ticket/card.
 */
export function upsertOpen(data: {
  grafanaAlertId: string;
  glpiTicketId: number | null;
  trelloCardId: string | null;
  aiAnalysis: Prisma.InputJsonValue;
}): Promise<Incident> {
  return prisma.incident.upsert({
    where: { grafanaAlertId: data.grafanaAlertId },
    create: { ...data, status: IncidentStatus.OPEN },
    update: {
      glpiTicketId: data.glpiTicketId,
      trelloCardId: data.trelloCardId,
      aiAnalysis: data.aiAnalysis,
      status: IncidentStatus.OPEN,
    },
  });
}

export function markResolved(id: string): Promise<Incident> {
  return prisma.incident.update({
    where: { id },
    data: { status: IncidentStatus.RESOLVED },
  });
}

/** Incidentes abertos que possuem ticket GLPI e card Trello (alvo da sincronização). */
export function findAllSyncable(): Promise<Incident[]> {
  return prisma.incident.findMany({
    where: {
      status: IncidentStatus.OPEN,
      glpiTicketId: { not: null },
      trelloCardId: { not: null },
    },
  });
}

export function setAssignedTech(id: string, assignedTechName: string): Promise<Incident> {
  return prisma.incident.update({ where: { id }, data: { assignedTechName } });
}

export function findByGlpiTicketId(glpiTicketId: number): Promise<Incident | null> {
  return prisma.incident.findFirst({ where: { glpiTicketId } });
}

/** Fingerprints dos incidentes do scanner do Loki que ainda estão abertos. */
export async function openLokiFingerprints(): Promise<Set<string>> {
  const rows = await prisma.incident.findMany({
    where: { status: IncidentStatus.OPEN, grafanaAlertId: { startsWith: "loki-" } },
    select: { grafanaAlertId: true },
  });
  return new Set(rows.map((r) => r.grafanaAlertId));
}

export function findByTrelloCardId(trelloCardId: string): Promise<Incident | null> {
  return prisma.incident.findFirst({ where: { trelloCardId } });
}

/** Incidente originado de um card criado manualmente no Trello (sem alerta do Grafana). */
export function createFromTrelloCard(data: {
  trelloCardId: string;
  glpiTicketId: number;
}): Promise<Incident> {
  return prisma.incident.create({
    data: {
      grafanaAlertId: `manual-trello-${data.trelloCardId}`,
      trelloCardId: data.trelloCardId,
      glpiTicketId: data.glpiTicketId,
      status: IncidentStatus.OPEN,
    },
  });
}

/** Incidente originado de um chamado criado manualmente no GLPI. */
export function createFromGlpiTicket(data: {
  glpiTicketId: number;
  trelloCardId: string;
}): Promise<Incident> {
  return prisma.incident.create({
    data: {
      grafanaAlertId: `manual-glpi-${data.glpiTicketId}`,
      glpiTicketId: data.glpiTicketId,
      trelloCardId: data.trelloCardId,
      status: IncidentStatus.OPEN,
    },
  });
}

/** Reabre um incidente (card retirado de concluídos / chamado reaberto). */
export function reopen(id: string): Promise<Incident> {
  return prisma.incident.update({
    where: { id },
    data: { status: IncidentStatus.OPEN },
  });
}

export function clearAssignedTech(id: string): Promise<Incident> {
  return prisma.incident.update({ where: { id }, data: { assignedTechName: null } });
}

/** Incidentes RESOLVED recentes (janela de 14 dias) — alvo da detecção de reabertura. */
export function findRecentResolvedSyncable(): Promise<Incident[]> {
  return prisma.incident.findMany({
    where: {
      status: IncidentStatus.RESOLVED,
      glpiTicketId: { not: null },
      trelloCardId: { not: null },
      updatedAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
    },
  });
}

/** Ids de todos os tickets GLPI já vinculados a algum incidente (qualquer status). */
export async function findKnownGlpiTicketIds(): Promise<Set<number>> {
  const rows = await prisma.incident.findMany({
    where: { glpiTicketId: { not: null } },
    select: { glpiTicketId: true },
  });
  return new Set(rows.map((r) => r.glpiTicketId!));
}
