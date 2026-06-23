import { ToolKind } from "@prisma/client";
import { logger } from "../lib/logger.js";
import * as tool from "./tool-run.service.js";

/**
 * Teste de regressão visual com Playwright (toHaveScreenshot).
 *
 * O script é gerado deterministicamente (real e executável); o Gemini escreve
 * apenas o relatório narrativo. A 1ª execução cria a baseline; as seguintes
 * comparam (critério: diff < 0.1%). O diretório de trabalho é estável por alvo
 * para que a baseline persista entre execuções.
 */

/** Mapa padrão de telas → rota. Sobrescrevível por params.routes. */
const DEFAULT_SCREENS: Record<string, string> = {
  login: "/login",
  inbox: "/inbox",
  crm: "/crm",
  financeiro: "/financeiro",
  campanhas: "/campanhas",
  configuracoes: "/configuracoes",
  calendario: "/calendario",
  automacoes: "/automacoes",
};

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60) || "alvo";
}

function buildConfig(): tool.ToolFile {
  return {
    path: "playwright.config.ts",
    content: [
      "import { defineConfig, devices } from '@playwright/test';",
      "export default defineConfig({",
      "  testDir: './tests',",
      "  snapshotDir: './snapshots',",
      "  reporter: [['list'], ['json', { outputFile: 'results.json' }]],",
      "  use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },",
      "  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.001 } },",
      "});",
    ].join("\n"),
  };
}

function buildSpec(targetUrl: string, screens: Record<string, string>): tool.ToolFile {
  const base = targetUrl.replace(/\/+$/, "");
  const cases = Object.entries(screens)
    .map(([name, route]) => [
      `test('${name}', async ({ page }) => {`,
      `  await page.goto('${base}${route}', { waitUntil: 'networkidle' }).catch(() => {});`,
      "  await page.waitForTimeout(800);",
      `  await expect(page).toHaveScreenshot('${name}.png', { fullPage: true, animations: 'disabled' });`,
      "});",
    ].join("\n"))
    .join("\n\n");
  return {
    path: "tests/visual.spec.ts",
    content: `import { test, expect } from '@playwright/test';\n\n${cases}\n`,
  };
}

function selectScreens(params: Record<string, unknown>): Record<string, string> {
  const custom = params.routes as Record<string, string> | undefined;
  const map = custom && Object.keys(custom).length ? custom : DEFAULT_SCREENS;
  const requested = params.screens;
  if (!requested || requested === "all") return map;
  const wanted = (Array.isArray(requested) ? requested : [requested]).map((s) => String(s).toLowerCase());
  const filtered = Object.fromEntries(Object.entries(map).filter(([name]) => wanted.includes(name.toLowerCase())));
  return Object.keys(filtered).length ? filtered : map;
}

export async function start(input: {
  channel: string;
  targetUrl?: string;
  repoPath?: string;
  params?: Record<string, unknown>;
}) {
  const run = await tool.createRun(ToolKind.VISUAL, input);
  void orchestrate(run.id, input).catch((error) => tool.fail(run.id, tool.errText(error)));
  return run;
}

async function orchestrate(runId: string, input: { targetUrl?: string; params?: Record<string, unknown> }): Promise<void> {
  const fallback = await tool.defaultTarget();
  const targetUrl = input.targetUrl || fallback.targetUrl;
  const params = input.params ?? {};
  const screens = selectScreens(params);

  await tool.step(runId, "Selecionando telas", "ok", `${Object.keys(screens).length} tela(s): ${Object.keys(screens).join(", ")}`);

  const config = buildConfig();
  const spec = buildSpec(targetUrl, screens);
  const script = `${config.content}\n\n/* tests/visual.spec.ts */\n${spec.content}`;
  await tool.step(runId, "Gerando script Playwright", "ok", `${Object.keys(screens).length} casos com toHaveScreenshot (diff < 0.1%)`);

  await tool.step(runId, "Executando Playwright", "running", `npx playwright test contra ${targetUrl}`);
  const result = await tool.runCommand(runId, {
    tool: "npx",
    args: ["playwright", "test", "--reporter=list"],
    files: [config, spec],
    // Workdir estável por alvo: a baseline persiste entre execuções.
    workdir: `.aiops-tools/visual/${slug(targetUrl)}`,
    timeoutMs: 600_000,
  });

  const firstRun = /A snapshot doesn't exist|writing actual|new snapshot/i.test(`${result.stdout} ${result.stderr}`);
  let findings: unknown;
  let status: "SUCCEEDED" | "FAILED" = "SUCCEEDED";
  let summaryHead = "";

  if (result.degraded) {
    await tool.step(runId, "Playwright indisponível no host", "warn", "Script gerado; instale @playwright/test + browsers para executar.");
    summaryHead = "⚠ Script de regressão visual gerado (não executado: Playwright ausente no host).";
    findings = { executed: false, screens: Object.keys(screens) };
  } else if (firstRun) {
    await tool.step(runId, "Baseline criada", "ok", "Primeira execução: screenshots de referência gravadas.");
    summaryHead = `Baseline visual criada para ${Object.keys(screens).length} tela(s). Rode novamente para comparar.`;
    findings = { executed: true, baseline: true, screens: Object.keys(screens) };
  } else {
    const failed = parseFailures(result.stdout + "\n" + result.stderr);
    status = result.ok && failed.length === 0 ? "SUCCEEDED" : "FAILED";
    await tool.step(runId, "Comparação concluída", failed.length ? "error" : "ok",
      failed.length ? `${failed.length} tela(s) com diferença: ${failed.join(", ")}` : "Sem diferenças acima do limite.");
    summaryHead = failed.length
      ? `${failed.length} tela(s) com regressão visual: ${failed.join(", ")}.`
      : `Todas as ${Object.keys(screens).length} telas dentro do limite de 0.1%.`;
    findings = { executed: true, baseline: false, failedScreens: failed, screens: Object.keys(screens) };
  }

  await tool.step(runId, "Gerando relatório", "running");
  const report = await tool.generate(runId, "visual_test",
    `Escreva um relatório técnico em markdown (pt-BR) de um teste de regressão visual.\n` +
    `Alvo: ${targetUrl}\nTelas: ${Object.keys(screens).join(", ")}\n` +
    `Resultado: ${summaryHead}\n` +
    `Saída resumida do Playwright:\n${(result.stdout || result.stderr || "(sem saída)").slice(0, 4_000)}\n\n` +
    `Inclua: objetivo, telas cobertas, resultado por tela, e próximos passos. Seja objetivo.`,
  );

  await tool.finish(runId, {
    status,
    summary: summaryHead,
    report: report || summaryHead,
    findings,
    generatedScript: script,
  });
  logger.info({ runId, status, tela: Object.keys(screens).length }, "Teste visual concluído");
}

/** Extrai nomes dos testes que falharam na saída textual do Playwright. */
function parseFailures(output: string): string[] {
  const names = new Set<string>();
  for (const match of output.matchAll(/[✘×]\s+.*?›\s*([^\n›]+?)(?:\s+\(|\n|$)/g)) {
    if (match[1]) names.add(match[1].trim());
  }
  for (const match of output.matchAll(/\d+\)\s+\[.*?\]\s*›\s*[^›]+›\s*([^\n]+)/g)) {
    if (match[1]) names.add(match[1].trim());
  }
  return [...names];
}
