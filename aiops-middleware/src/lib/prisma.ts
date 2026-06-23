import { PrismaClient } from "@prisma/client";

/** Instância única do Prisma Client compartilhada por toda a aplicação. */
export const prisma = new PrismaClient();
