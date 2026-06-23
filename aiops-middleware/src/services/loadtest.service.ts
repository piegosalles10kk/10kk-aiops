import { ToolKind } from "@prisma/client";
import { logger } from "../lib/logger.js";
import * as tool from "./tool-run.service.js";

/**
 * Teste de carga/estresse com k6. O script é gerado deterministicamente com os
 * 5 cenários do plano (ou um cenário escolhido) sobre os endpoints prioritários;
 * o Gemini escreve o relatório a partir das métricas reais (p50/p95/p99, erros).
 * k6 ausente no host → degrada para "só gerou script".
 */

interface Scenario { vus: number; duration: string; desc: string }

const SCENARIOS: Record<string, Scenario> = {
  baseline: { vus: 10, duration: "2m", desc: "Baseline normal (p95 < 200ms)" },
  pico: { vus: 50, duration: "5m", desc: "Pico de entrada de mensagens (p95 < 500ms, 0 erros 5xx)" },
  thundering: { vus: 100, duration: "30s", desc: "Thundering herd (sem cascata de 429/503)" },
  sustained: { vus: 30, duration: "30m", desc: "Dia útil sustentado (sem memory leak)" },
  cpu: { vus: 80, duration: "5m", desc: "Limite de CPU (identifica throttle point)" },
};

const DEFAULT_ENDPOINTS = [
  { method: "GET", path: "/api/conversations" },
  { method: "POST", path: "/api/messages" },
  { method: "GET", path: "/api/contacts" },
  { method: "GET", path: "/api/billing" },
];

function buildScript(targetUrl: string, endpoints: typeof DEFAULT_ENDPOINTS, scn: Scenario): string {
  const base = targetUrl.replace(/\/+$/, "");
  const calls = endpoints.map((e) => e.method === "POST"
    ? `  res = http.post('${base}${e.path}', JSON.stringify({ probe: true }), { headers: { 'Content-Type': 'application/json' } });\n  check(res, { '${e.path} < 500': (r) => r.status < 500 });`
    : `  res = http.get('${base}${e.path}');\n  check(res, { '${e.path} < 500': (r) => r.status < 500 });`,
  ).join("\n");
  return [
    "import http from 'k6/http';",
    "import { check, sleep } from 'k6';",
    "export const options = {",
    `  vus: ${scn.vus},`,
    `  duration: '${scn.duration}',`,
    "  thresholds: {",
    "    http_req_failed: ['rate<0.05'],",
    "    http_req_duration: ['p(95)<500'],",
    "  },",
    "};",
    "export default function () {",
    "  let res;",
    calls,
    "  sleep(1);",
    "}",
  ].join("\n");
}

export async function start(input: {
  channel: string;
  targetUrl?: string;
  repoPath?: string;
  params?: Record<string, unknown>;
}) {
  const run = await tool.createRun(ToolKind.LOAD, input);
  void orchestrate(run.id, input).catch((error) => tool.fail(run.id, tool.errText(error)));
  return run;
}

async function orchestrate(runId: string, input: { targetUrl?: string; params?: Record<string, unknown> }): Promise<void> {
  const fallback = await tool.defaultTarget();
  const targetUrl = input.targetUrl || fallback.targetUrl;
  const params = input.params ?? {};
  const scenarioKey = String(params.scenario ?? "baseline").toLowerCase();
  const scenario = SCENARIOS[scenarioKey] ?? SCENARIOS.baseline!;
  const endpoints = Array.isArray(params.endpoints) && params.endpoints.length
    ? (params.endpoints as typeof DEFAULT_ENDPOINTS)
    : DEFAULT_ENDPOINTS;

  await tool.step(runId, "Selecionando cenário e endpoints", "ok",
    `Cenário '${scenarioKey}' (${scenario.vus} VUs, ${scenario.duration}); ${endpoints.length} endpoints.`);

  const script = buildScript(targetUrl, endpoints, scenario);
  await tool.step(runId, "Gerando script k6", "ok", scenario.desc);

  await tool.step(runId, "Executando k6", "running", `k6 run (${scenario.vus} VUs / ${scenario.duration})`);
  const result = await tool.runCommand(runId, {
    tool: "k6",
    args: ["run", "script.js"],
    files: [{ path: "script.js", content: script }],
    workdir: `.aiops-tools/load/${runId}`,
    // Sem timeout para o cenário sustained (30m); runner controla.
    timeoutMs: scenarioKey === "sustained" ? 0 : 600_000,
  });

  let findings: unknown;
  let summary: string;
  let status: "SUCCEEDED" | "FAILED" = "SUCCEEDED";

  if (result.degraded) {
    await tool.step(runId, "k6 indisponível no host", "warn", "Script gerado; instale o k6 para executar.");
    summary = "⚠ Script de carga k6 gerado (não executado: k6 ausente no host).";
    findings = { executed: false, scenario: scenarioKey, vus: scenario.vus };
  } else {
    const metrics = parseK6(result.stdout + "\n" + result.stderr);
    const breached = result.stdout.includes("thresholds on metrics") || /✗/.test(result.stdout);
    status = result.ok ? "SUCCEEDED" : "FAILED";
    findings = { executed: true, scenario: scenarioKey, vus: scenario.vus, ...metrics, thresholdsBreached: breached };
    summary = `Cenário '${scenarioKey}': p95=${metrics.p95 ?? "?"}ms, p99=${metrics.p99 ?? "?"}ms, erros=${metrics.errorRate ?? "?"}.`;
    await tool.step(runId, "Métricas coletadas", breached ? "error" : "ok", summary);
  }

  await tool.step(runId, "Gerando relatório", "running");
  const report = await tool.generate(runId, "load_test",
    `Escreva um relatório de teste de carga em markdown (pt-BR).\n` +
    `Alvo: ${targetUrl}\nCenário: ${scenarioKey} — ${scenario.desc}\n` +
    `Métricas/saída do k6:\n${(result.stdout || result.stderr || "(sem saída)").slice(0, 4_000)}\n\n` +
    `Inclua: objetivo, configuração, latências p50/p95/p99, taxa de erro, ponto de ruptura observado e recomendações.`,
  );

  await tool.finish(runId, { status, summary, report: report || summary, findings, generatedScript: script });
  logger.info({ runId, scenario: scenarioKey, status }, "Teste de carga concluído");
}

/** Extrai p50/p95/p99 e taxa de erro da saída textual do k6. */
function parseK6(output: string): { p50?: string; p95?: string; p99?: string; errorRate?: string; avg?: string } {
  const dur = output.match(/http_req_duration[^\n]*?avg=([\d.]+\w*)[^\n]*?med=([\d.]+\w*)[^\n]*?p\(95\)=([\d.]+\w*)/);
  const p99 = output.match(/p\(99\)=([\d.]+\w*)/);
  const failed = output.match(/http_req_failed[^\n]*?([\d.]+)%/);
  return {
    avg: dur?.[1],
    p50: dur?.[2],
    p95: dur?.[3],
    p99: p99?.[1],
    errorRate: failed ? `${failed[1]}%` : undefined,
  };
}
