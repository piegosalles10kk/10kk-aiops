import { Router } from "express";
import { prisma } from "../lib/prisma.js";

export const healthRouter = Router();

/** Liveness: o processo está de pé. */
healthRouter.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

/** Readiness: dependências críticas (banco) acessíveis. */
healthRouter.get("/readyz", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "database unavailable" });
  }
});
