import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger.js";
import { healthRouter } from "./routes/health.routes.js";
import { webhookRouter } from "./routes/webhook.routes.js";
import { commandCenterRouter } from "./routes/command-center.routes.js";
import { toolsRouter } from "./routes/tools.routes.js";
import { projectRouter } from "./routes/project.routes.js";
import { embedRouter } from "./routes/embed.routes.js";

export function createApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");

  // Proxy de embed ANTES do express.json: precisa do corpo bruto e de
  // repassar qualquer content-type para o site alvo.
  app.use("/embed", embedRouter);

  // Limite maior para acomodar anexos (imagem/áudio/vídeo/PDF) em base64
  app.use(express.json({ limit: "30mb" }));

  app.use("/", healthRouter);
  app.use("/webhooks", webhookRouter);
  app.use("/api/tools", toolsRouter);
  // Rotas novas de topologia/escopo/permissões antes do command-center (sem colisão de paths)
  app.use("/api", projectRouter);
  app.use("/api", commandCenterRouter);
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
  app.use(express.static(publicDir));
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

  // SPA fallback: qualquer rota não-API serve o index.html
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/webhooks/") || req.path.startsWith("/embed/")) {
      return next();
    }
    res.sendFile(path.join(publicDir, "index.html"));
  });

  // 404 padrão (apenas para rotas de API não encontradas)
  app.use((_req, res) => {
    res.status(404).json({ error: "Rota não encontrada" });
  });

  // Error handler global: nenhuma exceção de rota derruba o processo
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: { message: err.message, stack: err.stack } }, "Erro não tratado em rota");
    res.status(500).json({ error: "Erro interno" });
  });

  return app;
}
