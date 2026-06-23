import type { SyncItem, SyncKind } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

/** Mapeamentos de itens já sincronizados entre GLPI e Trello. */

export function listByIncident(incidentId: string): Promise<SyncItem[]> {
  return prisma.syncItem.findMany({ where: { incidentId } });
}

export function create(data: {
  incidentId: string;
  kind: SyncKind;
  glpiId: number;
  trelloId: string;
  lastState?: string;
}): Promise<SyncItem> {
  return prisma.syncItem.create({ data });
}

export function updateState(id: string, lastState: string): Promise<SyncItem> {
  return prisma.syncItem.update({ where: { id }, data: { lastState } });
}
