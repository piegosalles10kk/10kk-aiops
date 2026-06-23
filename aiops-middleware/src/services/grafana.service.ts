import axios from "axios";
import { env } from "../config/env.js";
import { withRetry } from "../utils/retry.js";

const http = axios.create({ timeout: 30_000 });

function config() {
  if (!env.GRAFANA_URL || !env.GRAFANA_SA_TOKEN) {
    throw new Error("Grafana indisponível: configure GRAFANA_URL e GRAFANA_SA_TOKEN.");
  }
  return {
    baseURL: env.GRAFANA_URL.replace(/\/+$/, ""),
    headers: { Authorization: `Bearer ${env.GRAFANA_SA_TOKEN}` },
  };
}

export interface GrafanaDatasource {
  id: number;
  uid: string;
  name: string;
  type: string;
  url: string;
  isDefault: boolean;
}

export interface DashboardQuery {
  dashboardUid: string;
  dashboard: string;
  panel: string;
  panelType: string;
  datasourceUid: string;
  expression?: string;
  query?: string;
}

export async function discoverCatalog(): Promise<{
  datasources: GrafanaDatasource[];
  dashboards: number;
  queries: DashboardQuery[];
}> {
  const { baseURL, headers } = config();
  const [datasourcesResponse, searchResponse] = await Promise.all([
    http.get<GrafanaDatasource[]>(`${baseURL}/api/datasources`, { headers }),
    http.get<Array<{ uid: string }>>(`${baseURL}/api/search`, {
      headers,
      params: { type: "dash-db", limit: 500 },
    }),
  ]);

  const queries: DashboardQuery[] = [];
  for (const item of searchResponse.data) {
    const response = await http.get<{
      dashboard: { uid: string; title: string; panels?: unknown[] };
    }>(`${baseURL}/api/dashboards/uid/${encodeURIComponent(item.uid)}`, { headers });
    const dashboard = response.data.dashboard;
    const walk = (panels: unknown[], depth = 0) => {
      if (depth > 8) return;
      for (const raw of panels) {
        const panel = raw as {
          title?: string;
          type?: string;
          datasource?: { uid?: string; type?: string };
          targets?: Array<{
            datasource?: { uid?: string; type?: string };
            expr?: string;
            query?: string;
          }>;
          panels?: unknown[];
        };
        for (const target of panel.targets ?? []) {
          queries.push({
            dashboardUid: dashboard.uid,
            dashboard: dashboard.title,
            panel: panel.title ?? "Painel sem nome",
            panelType: panel.type ?? "unknown",
            datasourceUid:
              target.datasource?.uid ??
              panel.datasource?.uid ??
              target.datasource?.type ??
              panel.datasource?.type ??
              "",
            expression: target.expr,
            query: target.query,
          });
        }
        if (panel.panels) walk(panel.panels, depth + 1);
      }
    };
    walk(dashboard.panels ?? []);
  }

  return {
    datasources: datasourcesResponse.data,
    dashboards: searchResponse.data.length,
    queries,
  };
}

interface PrometheusResponse {
  status: string;
  data?: {
    result?: Array<{
      metric: Record<string, string>;
      value?: [number, string];
    }>;
  };
}

export async function queryPrometheus(
  expression: string,
): Promise<Array<{ metric: Record<string, string>; value: number }>> {
  const { baseURL, headers } = config();
  const response = await withRetry(
    () =>
      http.get<PrometheusResponse>(
        `${baseURL}/api/datasources/proxy/uid/prometheus/api/v1/query`,
        { headers, params: { query: expression } },
      ),
    { label: "grafana.prometheus.query" },
  );
  return (response.data.data?.result ?? []).map((item) => ({
    metric: item.metric,
    value: Number(item.value?.[1] ?? 0),
  }));
}

interface GrafanaFrame {
  schema?: { fields?: Array<{ name: string }> };
  data?: { values?: unknown[][] };
}

export async function queryWazuh(input: {
  query: string;
  minutes: number;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const { baseURL, headers } = config();
  const to = Date.now();
  const from = to - input.minutes * 60_000;
  const response = await withRetry(
    () =>
      http.post<{ results?: Record<string, { frames?: GrafanaFrame[] }> }>(
        `${baseURL}/api/ds/query`,
        {
          from: String(from),
          to: String(to),
          queries: [{
            refId: "A",
            datasource: {
              type: "grafana-opensearch-datasource",
              uid: "efoq269yqffuoe",
            },
            query: input.query,
            metrics: [{
              id: "1",
              type: "raw_data",
              settings: { size: String(Math.min(input.limit ?? 100, 500)) },
            }],
            bucketAggs: [],
            timeField: "timestamp",
            intervalMs: 15_000,
            maxDataPoints: 500,
          }],
        },
        { headers: { ...headers, "Content-Type": "application/json" } },
      ),
    { label: "grafana.wazuh.query" },
  );

  const frame = response.data.results?.A?.frames?.[0];
  const fields = frame?.schema?.fields ?? [];
  const columns = frame?.data?.values ?? [];
  const length = Math.max(0, ...columns.map((column) => column.length));
  return Array.from({ length }, (_, rowIndex) =>
    Object.fromEntries(fields.map((field, columnIndex) => [
      field.name,
      columns[columnIndex]?.[rowIndex] ?? null,
    ])),
  );
}
