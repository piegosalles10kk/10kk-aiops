import crypto from "node:crypto";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

export const SETTING_DEFINITIONS = [
  ["GLPI_API_URL", false], ["GLPI_WEB_URL", false],
  ["GLPI_APP_TOKEN", true], ["GLPI_USER_TOKEN", true],
  ["GEMINI_API_KEY", true], ["GEMINI_MODEL", false], ["GRAFANA_URL", false],
  ["GRAFANA_SA_TOKEN", true],
  ["LOKI_SCAN_ENABLED", false], ["LOKI_SCAN_ENVIRONMENTS", false],
  ["LOKI_SCAN_INTERVAL_MS", false], ["LOKI_SCAN_MIN_COUNT", false],
  ["OBSERVABILITY_SCAN_ENABLED", false], ["OBSERVABILITY_SCAN_INTERVAL_MS", false],
  ["OBSERVABILITY_MAX_PER_CYCLE", false],
  ["PROMETHEUS_CPU_THRESHOLD", false], ["PROMETHEUS_MEMORY_THRESHOLD", false],
  ["PROMETHEUS_DISK_THRESHOLD", false], ["PROMETHEUS_SERVICE_CPU_THRESHOLD", false],
  ["PROMETHEUS_5XX_RATE_THRESHOLD", false], ["PROMETHEUS_LATENCY_THRESHOLD_SECONDS", false],
  ["PROMETHEUS_AUTH_FAILURE_THRESHOLD", false],
  ["WAZUH_MIN_LEVEL", false], ["WAZUH_SCAN_LOOKBACK_MIN", false],
  ["TRELLO_API_KEY", true], ["TRELLO_TOKEN", true],
  ["TRELLO_LIST_ID_INCIDENT", false], ["TRELLO_LIST_ID_REQUEST", false],
  ["TRELLO_LIST_ID_IN_PROGRESS", false], ["TRELLO_LIST_ID_PENDING", false],
  ["TRELLO_LIST_ID_DONE", false],
  ["SYNC_INTERVAL_MS", false], ["SLACK_WEBHOOK_URL", true],
  ["SLACK_BOT_TOKEN", true], ["SLACK_APP_TOKEN", true], ["SLACK_CHANNEL", false],
  ["TELEGRAM_BOT_TOKEN", true], ["TELEGRAM_ALLOWED_CHAT_IDS", false],
  ["MANAGER_MODEL", false], ["AGENT_POLL_INTERVAL_MS", false],
  ["MANAGER_CONTEXT_CACHE_ENABLED", false], ["GEMINI_BATCH_EMBEDDINGS_ENABLED", false],
  ["ANTHROPIC_API_KEY", true], ["OPENAI_API_KEY", true],
  ["OPENCODE_API_KEY", true],
  ["GLPI_AGENT_PROFILE_ID", false],
  ["GLOBAL_AGENT_PROMPT", false],
  ["MANAGER_PROJECT_CONTEXT", false],
  // Ferramentas de qualidade (Visual/Pentest/Stress): alvo padrão
  ["TOOLS_DEFAULT_URL", false],
  ["TOOLS_DEFAULT_REPO_PATH", false],
] as const;

const definitionMap = new Map<string, boolean>(SETTING_DEFINITIONS);
const key = crypto.createHash("sha256").update(env.CONFIG_ENCRYPTION_KEY).digest();

function encrypt(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decrypt(value: string): string {
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText) return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export async function hydrateSettings(): Promise<void> {
  const rows = await prisma.appSetting.findMany();
  for (const row of rows) {
    const value = row.secret ? decrypt(row.value) : row.value;
    (env as unknown as Record<string, unknown>)[row.key] =
      row.key.endsWith("_MS") ? Number(value) : value || undefined;
  }
}

export async function listSettings(): Promise<Array<{
  key: string;
  secret: boolean;
  configured: boolean;
  value: string;
}>> {
  const rows = new Map((await prisma.appSetting.findMany()).map((row) => [row.key, row]));
  return SETTING_DEFINITIONS.map(([settingKey, secret]) => {
    const row = rows.get(settingKey);
    const fallback = String((env as unknown as Record<string, unknown>)[settingKey] ?? "");
    const configured = Boolean(row?.value || fallback);
    return {
      key: settingKey,
      secret,
      configured,
      value: secret ? (configured ? "********" : "") : row?.value ?? fallback,
    };
  });
}

export async function saveSettings(values: Record<string, unknown>): Promise<void> {
  for (const [settingKey, raw] of Object.entries(values)) {
    const secret = definitionMap.get(settingKey);
    if (secret === undefined || typeof raw !== "string") continue;
    if (secret && raw === "********") continue;
    const value = raw.trim();
    await prisma.appSetting.upsert({
      where: { key: settingKey },
      create: { key: settingKey, value: secret ? encrypt(value) : value, secret },
      update: { value: secret ? encrypt(value) : value, secret },
    });
    (env as unknown as Record<string, unknown>)[settingKey] =
      settingKey.endsWith("_MS") ? Number(value) : value || undefined;
  }
}

export async function getSecret(settingKey: string): Promise<string | undefined> {
  const row = await prisma.appSetting.findUnique({ where: { key: settingKey } });
  if (row) return row.secret ? decrypt(row.value) : row.value;
  return String((env as unknown as Record<string, unknown>)[settingKey] ?? "") || undefined;
}
