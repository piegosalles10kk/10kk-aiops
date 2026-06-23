import "dotenv/config";
import { z } from "zod";

/**
 * Valida o process.env na inicialização (fail-fast): se uma variável
 * obrigatória estiver ausente/inválida, a aplicação não sobe.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3333),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  DATABASE_URL: z.string().url(),

  GLPI_API_URL: z.string().url(),
  GLPI_WEB_URL: z.string().url().optional().transform((v) => v || undefined),
  GLPI_APP_TOKEN: z.string().min(1),
  GLPI_USER_TOKEN: z.string().min(1),

  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  /** Context caching das regras fixas do Gerente (entrada cacheada custa ~10%). */
  MANAGER_CONTEXT_CACHE_ENABLED: z.string().optional().default("true"),
  /** Batch API nos embeddings do reindex RAG (50% de desconto, processamento assíncrono). */
  GEMINI_BATCH_EMBEDDINGS_ENABLED: z.string().optional().default("true"),

  // Grafana (pull de logs no Loki via proxy de datasource) — opcional
  GRAFANA_URL: z.string().optional().transform((v) => v || undefined),
  GRAFANA_SA_TOKEN: z.string().optional().transform((v) => v || undefined),

  // Scanner de erros no Loki: abre chamados automaticamente a partir dos logs.
  // String (não boolean) porque pode ser sobrescrito por settings; interpretado no scanner.
  LOKI_SCAN_ENABLED: z.string().optional().default("false"),
  /** Ambientes a varrer (separados por vírgula). */
  LOKI_SCAN_ENVIRONMENTS: z.string().default("prod"),
  LOKI_SCAN_INTERVAL_MS: z.coerce.number().int().min(60000).default(300000),
  /** Janela de busca em minutos (deve cobrir o intervalo + folga). */
  LOKI_SCAN_LOOKBACK_MIN: z.coerce.number().int().min(2).default(7),
  /** Mínimo de ocorrências do mesmo erro para abrir chamado. */
  LOKI_SCAN_MIN_COUNT: z.coerce.number().int().min(1).default(3),
  /** Máximo de chamados novos por varredura (anti-inundação). */
  LOKI_SCAN_MAX_PER_CYCLE: z.coerce.number().int().min(1).default(5),
  OBSERVABILITY_SCAN_ENABLED: z.string().optional().default("false"),
  OBSERVABILITY_SCAN_INTERVAL_MS: z.coerce.number().int().min(60000).default(300000),
  OBSERVABILITY_MAX_PER_CYCLE: z.coerce.number().int().min(1).default(5),
  PROMETHEUS_CPU_THRESHOLD: z.coerce.number().min(1).max(100).default(90),
  PROMETHEUS_MEMORY_THRESHOLD: z.coerce.number().min(1).max(100).default(90),
  PROMETHEUS_DISK_THRESHOLD: z.coerce.number().min(1).max(100).default(90),
  PROMETHEUS_SERVICE_CPU_THRESHOLD: z.coerce.number().min(1).default(85),
  PROMETHEUS_5XX_RATE_THRESHOLD: z.coerce.number().min(0).default(0.1),
  PROMETHEUS_LATENCY_THRESHOLD_SECONDS: z.coerce.number().min(0.1).default(2),
  PROMETHEUS_AUTH_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(20),
  WAZUH_MIN_LEVEL: z.coerce.number().int().min(1).max(15).default(12),
  WAZUH_SCAN_LOOKBACK_MIN: z.coerce.number().int().min(1).default(10),

  // Integrações opcionais: string vazia vira undefined
  TRELLO_API_KEY: z.string().optional().transform((v) => v || undefined),
  TRELLO_TOKEN: z.string().optional().transform((v) => v || undefined),
  TRELLO_LIST_ID_INCIDENT: z.string().optional().transform((v) => v || undefined),
  TRELLO_LIST_ID_REQUEST: z.string().optional().transform((v) => v || undefined),
  TRELLO_LIST_ID_IN_PROGRESS: z.string().optional().transform((v) => v || undefined),
  TRELLO_LIST_ID_PENDING: z.string().optional().transform((v) => v || undefined),
  TRELLO_LIST_ID_DONE: z.string().optional().transform((v) => v || undefined),
  SLACK_WEBHOOK_URL: z.string().optional().transform((v) => v || undefined),
  /** Slack bidirecional via Socket Mode (chat com o Gerente). */
  SLACK_BOT_TOKEN: z.string().optional().transform((v) => v || undefined),
  SLACK_APP_TOKEN: z.string().optional().transform((v) => v || undefined),
  /** Canais do Slack para avisos proativos (ex.: aprovações). IDs separados por vírgula. */
  SLACK_CHANNEL: z.string().optional().transform((v) => v || undefined),

  /** Intervalo do loop de sincronização GLPI <-> Trello. */
  SYNC_INTERVAL_MS: z.coerce.number().int().min(5000).default(30000),
  CONFIG_ENCRYPTION_KEY: z.string().min(16).default("change-me-in-production"),
  RUNNER_URL: z.string().url().default("http://host.docker.internal:3340"),
  QDRANT_URL: z.string().url().default("http://qdrant:6333"),
  AGENT_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(15000),
  PROJECTS_HOST_ROOT: z.string().default(".."),
  /** Caminho do próprio código do middleware, relativo a PROJECTS_HOST_ROOT. */
  SELF_CODE_PATH: z.string().default("DEV/GPI-TRELLO/aiops-middleware"),
  TELEGRAM_BOT_TOKEN: z.string().optional().transform((v) => v || undefined),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional().transform((v) => v || undefined),
  MANAGER_MODEL: z.string().default("gemini-2.5-flash"),
  /** Descrição do projeto/ambiente que o Gerente sempre considera. */
  MANAGER_PROJECT_CONTEXT: z.string().optional().transform((v) => v || undefined),
  GLOBAL_AGENT_PROMPT: z.string().optional().transform((v) => v || undefined),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Logger ainda não está disponível neste ponto do bootstrap
  console.error(
    "❌ Variáveis de ambiente inválidas:",
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

export const env = parsed.data;

export const isTrelloEnabled = Boolean(
  env.TRELLO_API_KEY && env.TRELLO_TOKEN && env.TRELLO_LIST_ID_INCIDENT,
);

export const isSlackEnabled = Boolean(env.SLACK_WEBHOOK_URL);

export const isLokiEnabled = Boolean(env.GRAFANA_URL && env.GRAFANA_SA_TOKEN);
