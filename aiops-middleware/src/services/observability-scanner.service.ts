import crypto from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import * as incidentRepo from "../repositories/incident.repository.js";
import type { GrafanaAlert } from "../schemas/grafana.schema.js";
import { errorSummary } from "../utils/retry.js";
import * as grafana from "./grafana.service.js";
import * as incidentService from "./incident.service.js";

interface MetricDetector {
  id: string;
  title: string;
  expression: () => string;
  severity: "warning" | "critical";
  description: string;
}

function enabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    String(env.OBSERVABILITY_SCAN_ENABLED).toLowerCase().trim(),
  );
}

function environmentsRegex(): string {
  return String(env.LOKI_SCAN_ENVIRONMENTS)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .join("|") || "prod|homolog";
}

const detectors: MetricDetector[] = [
  {
    id: "target-down",
    title: "Target monitorado indisponível",
    expression: () => `up{environment=~"${environmentsRegex()}"} == 0`,
    severity: "critical",
    description: "Um endpoint de aplicação monitorado pelo Prometheus está indisponível.",
  },
  {
    id: "host-cpu-high",
    title: "CPU do host acima do limite",
    expression: () =>
      `(1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100 > ${env.PROMETHEUS_CPU_THRESHOLD}`,
    severity: "warning",
    description: "A utilização média de CPU do host permaneceu acima do limite configurado.",
  },
  {
    id: "host-memory-high",
    title: "Memória do host acima do limite",
    expression: () =>
      `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100 > ${env.PROMETHEUS_MEMORY_THRESHOLD}`,
    severity: "warning",
    description: "A utilização de memória do host ultrapassou o limite configurado.",
  },
  {
    id: "host-disk-high",
    title: "Disco do host acima do limite",
    expression: () =>
      `(1 - node_filesystem_avail_bytes{mountpoint="/host"} / node_filesystem_size_bytes{mountpoint="/host"}) * 100 > ${env.PROMETHEUS_DISK_THRESHOLD}`,
    severity: "critical",
    description: "A utilização do filesystem principal ultrapassou o limite configurado.",
  },
  {
    id: "service-cpu-high",
    title: "CPU elevada por serviço",
    expression: () =>
      `avg by(environment, service)(rate(container_cpu_usage_seconds_total{environment=~"${environmentsRegex()}"}[5m])) * 100 > ${env.PROMETHEUS_SERVICE_CPU_THRESHOLD}`,
    severity: "warning",
    description: "Um serviço apresenta consumo sustentado de CPU acima do limite.",
  },
  {
    id: "http-5xx-rate",
    title: "Taxa elevada de respostas HTTP 5xx",
    expression: () =>
      `sum by(service)(rate(traefik_service_requests_total{code=~"5..",service=~".*omni-(${environmentsRegex()}).*|.*omnipay-(${environmentsRegex()}).*"}[5m])) > ${env.PROMETHEUS_5XX_RATE_THRESHOLD}`,
    severity: "critical",
    description: "A taxa de respostas HTTP 5xx ultrapassou o limite configurado.",
  },
  {
    id: "http-latency-p95",
    title: "Latência HTTP p95 elevada",
    expression: () =>
      `histogram_quantile(0.95, sum by(service, le)(rate(traefik_service_request_duration_seconds_bucket{service=~".*omni-(${environmentsRegex()}).*|.*omnipay-(${environmentsRegex()}).*"}[5m]))) > ${env.PROMETHEUS_LATENCY_THRESHOLD_SECONDS}`,
    severity: "warning",
    description: "A latência p95 de um serviço ultrapassou o limite configurado.",
  },
  {
    id: "container-restart",
    title: "Container reiniciado",
    expression: () =>
      `changes(container_start_time_seconds{environment=~"${environmentsRegex()}"}[5m]) > 0`,
    severity: "warning",
    description: "O Prometheus detectou reinício recente de um container monitorado.",
  },
  {
    id: "auth-failures",
    title: "Volume elevado de HTTP 401/403",
    expression: () =>
      `sum by(service)(rate(traefik_service_requests_total{code=~"401|403",service=~".*omni-(${environmentsRegex()}).*|.*omnipay-(${environmentsRegex()}).*"}[5m])) * 300 > ${env.PROMETHEUS_AUTH_FAILURE_THRESHOLD}`,
    severity: "warning",
    description: "O volume de respostas 401/403 nos últimos cinco minutos ultrapassou o limite.",
  },
];

function metricFingerprint(detectorId: string, metric: Record<string, string>): string {
  const identity = Object.entries(metric)
    .filter(([key]) => key !== "__name__")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
  return `prom-${detectorId}-${crypto.createHash("sha1").update(identity || "global").digest("hex").slice(0, 12)}`;
}

async function scanPrometheus(): Promise<number> {
  let opened = 0;
  for (const detector of detectors) {
    const results = await grafana.queryPrometheus(detector.expression());
    const activeFingerprints = new Set<string>();
    for (const result of results) {
      if (!Number.isFinite(result.value)) continue;
      const fingerprint = metricFingerprint(detector.id, result.metric);
      activeFingerprints.add(fingerprint);
      const labels = Object.entries(result.metric)
        .filter(([key]) => key !== "__name__")
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      const alert: GrafanaAlert = {
        status: "firing",
        fingerprint,
        labels: {
          alertname: `[Prometheus] ${detector.title}`,
          environment: result.metric.environment ?? "infra",
          service_name: result.metric.service ?? result.metric.job ?? result.metric.instance ?? "host",
          severity: detector.severity,
          origem: "prometheus-scanner",
          detector: detector.id,
        },
        annotations: {
          summary: `${detector.title}: valor ${result.value.toFixed(3)}`,
          description: `${detector.description}\n\nSérie: ${labels || "global"}\nValor atual: ${result.value}\nPromQL: ${detector.expression()}`,
          metrics: JSON.stringify({ value: result.value, metric: result.metric }),
        },
        values: { A: result.value },
        startsAt: new Date().toISOString(),
      };
      const existing = await incidentRepo.findOpenByAlertId(fingerprint);
      if (!existing) {
        await incidentService.handleFiringAlert(alert);
        opened += 1;
      }
    }

    const open = await incidentRepo.findOpenByPrefix(`prom-${detector.id}-`);
    for (const incident of open) {
      if (activeFingerprints.has(incident.grafanaAlertId)) continue;
      await incidentService.handleResolvedAlert({
        status: "resolved",
        fingerprint: incident.grafanaAlertId,
        labels: {
          alertname: `[Prometheus] ${detector.title}`,
          origem: "prometheus-scanner",
        },
        annotations: { summary: "Métrica normalizada." },
        endsAt: new Date().toISOString(),
      });
    }
  }
  return opened;
}

function field(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return row[name];
  }
  return undefined;
}

async function scanWazuh(): Promise<number> {
  const rows = await grafana.queryWazuh({
    query: `rule.level:[${env.WAZUH_MIN_LEVEL} TO 15] OR rule_level:[${env.WAZUH_MIN_LEVEL} TO 15] OR syslog_level:ALERT`,
    minutes: env.WAZUH_SCAN_LOOKBACK_MIN,
    limit: 300,
  });
  const groups = new Map<string, {
    fingerprint: string;
    ruleId: string;
    level: number;
    agent: string;
    description: string;
    count: number;
    samples: string[];
  }>();
  for (const row of rows) {
    const level = Number(field(row, "rule.level", "rule_level") ?? 0);
    const ruleId = String(field(row, "rule.id", "rule_id") ?? "unknown");
    const agent = String(field(row, "agent.name", "agent_name") ?? "wazuh-manager");
    const description = String(
      field(row, "rule.description", "data.rule.description", "full_log") ?? "Evento Wazuh",
    );
    if (level < env.WAZUH_MIN_LEVEL && String(field(row, "syslog_level")).toUpperCase() !== "ALERT") {
      continue;
    }
    const signature = `${ruleId}|${agent}`;
    const fingerprint = `wazuh-${crypto.createHash("sha1").update(signature).digest("hex").slice(0, 12)}`;
    const group = groups.get(fingerprint) ?? {
      fingerprint,
      ruleId,
      level,
      agent,
      description,
      count: 0,
      samples: [],
    };
    group.count += 1;
    group.level = Math.max(group.level, level);
    if (group.samples.length < 5) {
      group.samples.push(JSON.stringify({
        timestamp: field(row, "timestamp", "@timestamp"),
        agent,
        ruleId,
        level,
        description,
        sourceIp: field(row, "data.srcip", "srcip"),
        fullLog: field(row, "full_log"),
      }));
    }
    groups.set(fingerprint, group);
  }

  let opened = 0;
  for (const group of [...groups.values()].sort((a, b) => b.level - a.level || b.count - a.count)) {
    if (opened >= env.OBSERVABILITY_MAX_PER_CYCLE) break;
    const existing = await incidentRepo.findOpenByAlertId(group.fingerprint);
    const alert: GrafanaAlert = {
      status: "firing",
      fingerprint: group.fingerprint,
      labels: {
        alertname: `[Wazuh] Regra ${group.ruleId}: ${group.description.slice(0, 100)}`,
        environment: "security",
        service_name: group.agent,
        severity: group.level >= 14 ? "critical" : "warning",
        origem: "wazuh-scanner",
        wazuh_rule_id: group.ruleId,
        wazuh_level: String(group.level),
      },
      annotations: {
        summary: `${group.count} evento(s) Wazuh nível ${group.level} para ${group.agent}`,
        description: `Evento de segurança detectado pelo Wazuh/OpenSearch.\n\n${group.description}\n\nAmostras:\n${group.samples.join("\n")}`,
        logs: group.samples.join("\n"),
      },
      startsAt: new Date().toISOString(),
    };
    if (!existing) {
      await incidentService.handleFiringAlert(alert);
      opened += 1;
    }
  }
  return opened;
}

export async function previewObservability(): Promise<{
  catalog: {
    dashboards: number;
    datasources: Array<{ uid: string; name: string; type: string }>;
    queries: number;
    queriesByDatasource: Record<string, number>;
  };
  prometheus: Array<{
    detector: string;
    title: string;
    expression: string;
    matches: number;
    samples: Array<{ metric: Record<string, string>; value: number }>;
  }>;
  wazuh: {
    query: string;
    matches: number;
    samples: Array<Record<string, unknown>>;
  };
}> {
  const catalog = await grafana.discoverCatalog();
  const prometheus = [];
  for (const detector of detectors) {
    const expression = detector.expression();
    const results = await grafana.queryPrometheus(expression);
    prometheus.push({
      detector: detector.id,
      title: detector.title,
      expression,
      matches: results.length,
      samples: results.slice(0, 5),
    });
  }
  const wazuhQuery =
    `rule.level:[${env.WAZUH_MIN_LEVEL} TO 15] OR ` +
    `rule_level:[${env.WAZUH_MIN_LEVEL} TO 15] OR syslog_level:ALERT`;
  const wazuhRows = await grafana.queryWazuh({
    query: wazuhQuery,
    minutes: env.WAZUH_SCAN_LOOKBACK_MIN,
    limit: 20,
  });
  return {
    catalog: {
      dashboards: catalog.dashboards,
      datasources: catalog.datasources.map(({ uid, name, type }) => ({ uid, name, type })),
      queries: catalog.queries.length,
      queriesByDatasource: Object.fromEntries(
        [...new Set(catalog.queries.map((item) => item.datasourceUid))]
          .map((uid) => [uid, catalog.queries.filter((item) => item.datasourceUid === uid).length]),
      ),
    },
    prometheus,
    wazuh: {
      query: wazuhQuery,
      matches: wazuhRows.length,
      samples: wazuhRows.slice(0, 5),
    },
  };
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastCatalogAt = 0;

export async function runObservabilityScanCycle(): Promise<void> {
  if (running || !enabled()) return;
  running = true;
  try {
    if (Date.now() - lastCatalogAt > 60 * 60 * 1000) {
      const catalog = await grafana.discoverCatalog();
      logger.info({
        dashboards: catalog.dashboards,
        datasources: catalog.datasources.map((item) => `${item.name}:${item.type}`),
        queries: catalog.queries.length,
        queriesByDatasource: Object.fromEntries(
          [...new Set(catalog.queries.map((item) => item.datasourceUid))]
            .map((uid) => [uid, catalog.queries.filter((item) => item.datasourceUid === uid).length]),
        ),
      }, "Catálogo de observabilidade do Grafana atualizado");
      lastCatalogAt = Date.now();
    }
    const [prometheusOpened, wazuhOpened] = await Promise.all([
      scanPrometheus(),
      scanWazuh(),
    ]);
    if (prometheusOpened + wazuhOpened > 0) {
      logger.info({ prometheusOpened, wazuhOpened }, "Scanner unificado abriu chamados");
    }
  } catch (error) {
    logger.error({ err: errorSummary(error) }, "Falha no scanner unificado de observabilidade");
  } finally {
    running = false;
  }
}

export function startObservabilityScanner(): void {
  if (timer || !enabled()) {
    if (!enabled()) logger.info("Scanner unificado desativado (OBSERVABILITY_SCAN_ENABLED != true)");
    return;
  }
  const interval = env.OBSERVABILITY_SCAN_INTERVAL_MS;
  timer = setInterval(() => void runObservabilityScanCycle(), interval);
  timer.unref();
  logger.info({ intervalMs: interval }, "Scanner unificado Prometheus/Wazuh iniciado");
  setTimeout(() => void runObservabilityScanCycle(), 20_000).unref();
}

export function stopObservabilityScanner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
