import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export function record(
  actor: string,
  action: string,
  entityType?: string,
  entityId?: string,
  details?: Prisma.InputJsonValue,
) {
  return prisma.auditLog.create({ data: { actor, action, entityType, entityId, details } });
}
