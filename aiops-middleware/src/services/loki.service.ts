import axios from "axios";
import { env, isLokiEnabled } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { GrafanaAlert } from "../schemas/grafana.schema.js";
import { errorSummary, withRetry } from "../utils/retry.js";

/**
 * Pull de logs reais no Loki para enriquecer o prompt da IA.
 *
 * A consulta é feita via proxy de datasource do Grafana
 * (GET {GRAFANA_URL}/api/datasources/proxy/uid/loki/loki/api/v1/query_range)
 * autenticada com Service Account token — assim o middleware não precisa
 * estar na mesma rede Docker da stack de observability.
 */

const http = axios.create({
  baseURL: env.GRAFANA_URL,
  timeout: 20_000,
  headers: env.GRAFANA_SA_TOKEN
    ? { Authorization: `Bearer ${env.GRAFANA_SA_TOKEN}` }
    : undefined,
});

/** Labels do alerta que normalmente também existem como stream labels no Loki. */
const STREAM_LABEL_CANDIDATES = ["environment", "service_name", "app", "job", "container"];

const ERROR_FILTER = `(?i)(error|exception|fatal|panic|5\\d\\d|timeout)`;

/** Monta o seletor LogQL a partir dos labels do alerta, com fallback genérico. */
function buildLogQl(labels: Record<string, string>): string {
  const matchers = STREAM_LABEL_CANDIDATES.filter((l) => labels[l]).map(
    (l) => `${l}="${labels[l]}"`,
  );
  const selector =
    matchers.length > 0 ? `{${matchers.join(", ")}}` : `{service_name=~".+"}`;
  // Crases = raw string no LogQL: evita problemas de escape do regex
  return `${selector} |~ \`${ERROR_FILTER}\``;
}

interface LokiQueryRangeResponse {
  data?: {
    result?: Array<{
      stream: Record<string, string>;
      values: Array<[string, string]>; // [timestamp_ns, linha]
    }>;
  };
}

/** Escapa um valor para uso seguro entre aspas num seletor LogQL. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface LokiQueryInput {
  /** Filtros por label de stream (ex.: { environment: "prod", service_name: "backend" }). */
  selectors?: Record<string, string>;
  /** Texto/regex a filtrar nas linhas (LogQL |~). Se ausente e onlyErrors, usa o filtro de erros. */
  filter?: string;
  /** Só linhas de erro/exceção/timeout/5xx. */
  onlyErrors?: boolean;
  /** Janela em minutos até agora (default 30). */
  minutes?: number;
  /** Máximo de linhas (default 100, teto 500). */
  limit?: number;
}

export interface LokiQueryResult {
  query: string;
  count: number;
  lines: string[];
}

/**
 * Consulta genérica de logs no Loki, sob demanda (usada pelo Gerente).
 * Lança em caso de falha — o chamador decide como reportar.
 */
export async function queryLogs(input: LokiQueryInput): Promise<LokiQueryResult> {
  if (!isLokiEnabled) {
    throw new Error("Consulta de logs indisponível: configure GRAFANA_URL e GRAFANA_SA_TOKEN.");
  }

  const matchers = Object.entries(input.selectors ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  const selector = matchers.length > 0 ? `{${matchers.join(", ")}}` : `{service_name=~".+"}`;

  let query = selector;
  if (input.filter?.trim()) {
    query += ` |~ \`${input.filter.trim()}\``;
  } else if (input.onlyErrors) {
    query += ` |~ \`${ERROR_FILTER}\``;
  }

  const minutes = Math.min(Math.max(input.minutes ?? 30, 1), 1440);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const endMs = Date.now();
  const startMs = endMs - minutes * 60 * 1000;

  const response = await withRetry(
    () =>
      http.get<LokiQueryRangeResponse>(
        "/api/datasources/proxy/uid/loki/loki/api/v1/query_range",
        {
          params: {
            query,
            start: `${startMs}000000`,
            end: `${endMs}000000`,
            limit,
            direction: "backward",
          },
        },
      ),
    { label: "loki.queryLogs" },
  );

  const streams = response.data.data?.result ?? [];
  const lines = streams
    .flatMap((s) =>
      s.values.map(([ts, line]) => ({
        ts: Number(ts),
        line: `[${s.stream.service_name ?? s.stream.app ?? "?"}] ${line}`,
      })),
    )
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((v) => v.line);

  logger.info({ query, count: lines.length }, "Logs do Loki consultados sob demanda");
  return { query, count: lines.length, lines };
}

export interface LokiEntry {
  ts: number;
  service: string;
  environment?: string;
  line: string;
}

/**
 * Consulta entradas estruturadas (com labels de stream) — usada pelo scanner
 * de erros, que precisa parsear cada linha para agrupar por assinatura.
 */
export async function queryLogEntries(input: {
  selectors?: Record<string, string>;
  onlyErrors?: boolean;
  /** Filtro LogQL custom (regex). Tem precedência sobre onlyErrors. */
  filter?: string;
  minutes?: number;
  limit?: number;
}): Promise<LokiEntry[]> {
  if (!isLokiEnabled) return [];

  const matchers = Object.entries(input.selectors ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  const selector = matchers.length > 0 ? `{${matchers.join(", ")}}` : `{service_name=~".+"}`;
  const activeFilter = input.filter ?? (input.onlyErrors ? ERROR_FILTER : undefined);
  const query = activeFilter ? `${selector} |~ \`${activeFilter}\`` : selector;

  const minutes = Math.min(Math.max(input.minutes ?? 10, 1), 1440);
  const limit = Math.min(Math.max(input.limit ?? 300, 1), 1000);
  const endMs = Date.now();
  const startMs = endMs - minutes * 60 * 1000;

  const response = await withRetry(
    () =>
      http.get<LokiQueryRangeResponse>(
        "/api/datasources/proxy/uid/loki/loki/api/v1/query_range",
        {
          params: {
            query,
            start: `${startMs}000000`,
            end: `${endMs}000000`,
            limit,
            direction: "backward",
          },
        },
      ),
    { label: "loki.queryLogEntries" },
  );

  const streams = response.data.data?.result ?? [];
  return streams.flatMap((s) =>
    s.values.map(([ts, line]) => ({
      ts: Number(ts),
      service: s.stream.service_name ?? s.stream.app ?? "?",
      environment: s.stream.environment,
      line,
    })),
  );
}

/** Lista os valores de um label no Loki (default service_name) — descoberta de serviços. */
export async function listLabelValues(label = "service_name"): Promise<string[]> {
  if (!isLokiEnabled) {
    throw new Error("Consulta de logs indisponível: configure GRAFANA_URL e GRAFANA_SA_TOKEN.");
  }
  const response = await withRetry(
    () =>
      http.get<{ data?: string[] }>(
        `/api/datasources/proxy/uid/loki/loki/api/v1/label/${encodeURIComponent(label)}/values`,
      ),
    { label: "loki.listLabelValues" },
  );
  return response.data.data ?? [];
}

/**
 * Busca os logs dos últimos 10 minutos antes do disparo do alerta.
 * Nunca lança: em caso de falha ou integração desabilitada, retorna ""
 * e a IA analisa apenas com os metadados do alerta.
 */
export async function fetchLogsForAlert(alert: GrafanaAlert): Promise<string> {
  if (!isLokiEnabled) {
    logger.warn("Pull de logs desabilitado (GRAFANA_URL/GRAFANA_SA_TOKEN ausentes)");
    return "";
  }

  const endMs = alert.startsAt ? Date.parse(alert.startsAt) : Date.now();
  const safeEndMs = Number.isNaN(endMs) ? Date.now() : endMs;
  const startMs = safeEndMs - 10 * 60 * 1000;

  const query = buildLogQl(alert.labels);

  try {
    const response = await withRetry(
      () =>
        http.get<LokiQueryRangeResponse>(
          "/api/datasources/proxy/uid/loki/loki/api/v1/query_range",
          {
            params: {
              query,
              // Loki usa timestamps em NANOSSEGUNDOS
              start: `${startMs}000000`,
              end: `${safeEndMs}000000`,
              limit: 200,
              direction: "backward",
            },
          },
        ),
      { label: "loki.queryRange" },
    );

    const streams = response.data.data?.result ?? [];
    const lines = streams
      .flatMap((s) =>
        s.values.map(([ts, line]) => ({
          ts: Number(ts),
          line: `[${s.stream.service_name ?? s.stream.app ?? "?"}] ${line}`,
        })),
      )
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 200)
      .map((v) => v.line)
      .join("\n");

    logger.info(
      { query, lineCount: lines ? lines.split("\n").length : 0 },
      "Logs do Loki coletados para enriquecimento da IA",
    );
    return lines;
  } catch (error) {
    logger.error(
      { err: errorSummary(error), query },
      "Falha ao buscar logs no Loki — IA seguirá só com metadados do alerta",
    );
    return "";
  }
}
