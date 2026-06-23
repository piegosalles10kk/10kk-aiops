import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { hydrateSettings } from "./services/settings.service.js";

await hydrateSettings();

const staleRunCutoff = new Date(Date.now() - 20 * 60 * 1000);
const staleRuns = await prisma.agentRun.updateMany({
  where: {
    status: "RUNNING",
    startedAt: { lt: staleRunCutoff },
  },
  data: {
    status: "TIMED_OUT",
    error: "Execução interrompida por reinício ou perda de comunicação com o runner.",
    finishedAt: new Date(),
  },
});
if (staleRuns.count > 0) {
  logger.warn({ count: staleRuns.count }, "Execuções abandonadas foram encerradas");
}

const [
  { createApp },
  { killSession },
  { startSyncLoop, stopSyncLoop },
  { startAgentMonitor, stopAgentMonitor },
  { startTelegramBot, stopTelegramBot },
  { startSlackBot, stopSlackBot },
  { startLokiScanner, stopLokiScanner },
  { startObservabilityScanner, stopObservabilityScanner },
  { chat },
] = await Promise.all([
  import("./app.js"),
  import("./services/glpi.service.js"),
  import("./services/sync.service.js"),
  import("./services/agent-monitor.service.js"),
  import("./services/telegram.service.js"),
  import("./services/slack-bot.service.js"),
  import("./services/loki-scanner.service.js"),
  import("./services/observability-scanner.service.js"),
  import("./services/manager.service.js"),
]);

const server = createApp().listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, env: env.NODE_ENV },
    "🚀 Middleware AIOps no ar — aguardando webhooks do Grafana em /webhooks/grafana",
  );
  startSyncLoop();
  startAgentMonitor();
  // Telegram usa o MESMO canal do chat web: a conversa é uma só, e as
  // mensagens (suas e do Gerente) aparecem na UI marcadas como "via Telegram".
  // Cada chat é uma SESSÃO independente (telegram:<id>, slack:<id>, web):
  // histórico e contexto próprios. Pedidos de aprovação voltam só para a
  // sessão que originou a ação.
  startTelegramBot(async (text, chatId, attachments) => {
    const response = await chat(text, `telegram:${chatId}`, undefined, "telegram", attachments);
    return response.answer;
  });
  startSlackBot(async (text, channelId, attachments) => {
    const response = await chat(text, `slack:${channelId}`, undefined, "slack", attachments);
    return response.answer;
  });
  // Scanner de erros do Loki -> abre chamados automaticamente (opt-in)
  startLokiScanner();
  startObservabilityScanner();
});

/** Graceful shutdown: fecha HTTP, sessão GLPI e conexões do Prisma. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Encerrando aplicação...");
  stopSyncLoop();
  stopAgentMonitor();
  stopTelegramBot();
  stopSlackBot();
  stopLokiScanner();
  stopObservabilityScanner();
  server.close(async () => {
    await Promise.allSettled([killSession(), prisma.$disconnect()]);
    process.exit(0);
  });
  // Força a saída se algo travar o close
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Última linha de defesa: loga e mantém o processo de pé em rejeições não tratadas
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (error) => {
  logger.fatal({ err: { message: error.message, stack: error.stack } }, "Uncaught exception");
  process.exit(1);
});
