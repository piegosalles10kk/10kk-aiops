import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import { AgentRunStatus, ToolKind } from "@prisma/client";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { getSecret } from "./settings.service.js";
import * as usage from "./usage.service.js";

/**
 * Serviço base das 3 ferramentas de qualidade (Visual / Pentest / Stress).
 *
 * Concentra tudo que é comum: criar a execução, registrar a timeline
 * passo-a-passo, gerar texto/script com o Gemini (contabilizando tokens),
 * disparar comandos reais no runner do host e finalizar com relatório.
 *
 * O middleware roda em container e NÃO acessa o filesystem do host; por isso
 * os scripts gerados são enviados inline (campo `files`) e o runner os grava
 * no diretório de trabalho antes de executar o binário.
 */

/** Mensagem de erro legível (errorSummary é estruturado, para logs). */
export function errText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export type StepStatus = "running" | "ok" | "warn" | "error";

export interface ToolStep {
  ts: number;
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface ToolFile {
  path: string;
  content: string;
}

interface RunnerJob {
  id: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const TOOLS_WORKDIR = ".aiops-tools";

const runnerHeaders = {
  Authorization: `Bearer ${process.env.RUNNER_TOKEN ?? "local-runner-token"}`,
};

/** Alvo padrão configurável via setting TOOLS_DEFAULT_URL. */
export async function defaultTarget(): Promise<{ targetUrl: string; repoPath: string }> {
  const targetUrl = (await getSecret("TOOLS_DEFAULT_URL")) || "http://host.docker.internal:3000";
  const repoPath = (await getSecret("TOOLS_DEFAULT_REPO_PATH")) || "";
  return { targetUrl, repoPath };
}

export async function createRun(kind: ToolKind, input: {
  channel: string;
  targetUrl?: string;
  repoPath?: string;
  params?: Record<string, unknown>;
}) {
  const fallback = await defaultTarget();
  return prisma.toolRun.create({
    data: {
      kind,
      channel: input.channel,
      targetUrl: input.targetUrl || fallback.targetUrl,
      repoPath: input.repoPath || fallback.repoPath,
      params: (input.params ?? {}) as object,
      status: AgentRunStatus.RUNNING,
      startedAt: new Date(),
    },
  });
}

/** Anexa um passo à timeline (lido em tempo real pela UI). */
export async function step(
  runId: string,
  label: string,
  status: StepStatus = "ok",
  detail?: string,
): Promise<void> {
  try {
    const run = await prisma.toolRun.findUnique({ where: { id: runId }, select: { steps: true } });
    const steps = (Array.isArray(run?.steps) ? (run!.steps as unknown as ToolStep[]) : []).slice(-200);
    steps.push({ ts: Date.now(), label, status, detail: detail?.slice(0, 2_000) });
    await prisma.toolRun.update({ where: { id: runId }, data: { steps: steps as unknown as object } });
  } catch (error) {
    logger.debug({ error, runId }, "Falha ao registrar passo de ferramenta (ignorada)");
  }
}

/** A execução foi cancelada pelo usuário? */
export async function isCancelled(runId: string): Promise<boolean> {
  const run = await prisma.toolRun.findUnique({ where: { id: runId }, select: { status: true } });
  return run?.status === AgentRunStatus.CANCELLED;
}

/**
 * Gera texto (script ou relatório) com o Gemini, contabiliza tokens no
 * TokenUsage e acumula no próprio ToolRun. Nunca lança: em falha devolve "".
 */
export async function generate(
  runId: string,
  feature: "visual_test" | "pentest" | "load_test",
  prompt: string,
  systemInstruction?: string,
): Promise<string> {
  try {
    const model = env.MANAGER_MODEL || env.GEMINI_MODEL;
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { temperature: 0.2, ...(systemInstruction ? { systemInstruction } : {}) },
    });
    const u = response.usageMetadata;
    void usage.record({ model, feature, usage: u });
    await prisma.toolRun.update({
      where: { id: runId },
      data: {
        promptTokens: { increment: u?.promptTokenCount ?? 0 },
        outputTokens: { increment: u?.candidatesTokenCount ?? 0 },
        totalTokens: { increment: u?.totalTokenCount ?? 0 },
      },
    });
    return response.text ?? "";
  } catch (error) {
    logger.warn({ error, runId, feature }, "Falha ao gerar conteúdo com o Gemini");
    return "";
  }
}

/** Extrai um bloco de código do markdown gerado (```lang ... ```), se houver. */
export function extractCode(text: string): string {
  const match = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return (match?.[1] ?? text).trim();
}

/**
 * Dispara um comando real no runner (provider COMMAND) e faz polling até o
 * fim, respeitando o cancelamento. Os arquivos vão inline para o host.
 */
export async function runCommand(runId: string, input: {
  tool: "npx" | "playwright" | "k6" | "docker" | "node";
  args: string[];
  files?: ToolFile[];
  workdir?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; degraded: boolean; stdout: string; stderr: string; exitCode: number | null; durationMs: number }> {
  const workdir = input.workdir ?? `${TOOLS_WORKDIR}/${runId}`;
  try {
    const start = await axios.post<RunnerJob>(`${env.RUNNER_URL}/runs`, {
      provider: "COMMAND",
      projectPath: workdir,
      tool: input.tool,
      args: input.args,
      files: input.files ?? [],
      timeoutMs: input.timeoutMs,
    }, { timeout: 30_000, headers: runnerHeaders });

    let result = start.data;
    await prisma.toolRun.update({ where: { id: runId }, data: { runnerRunId: result.id } });

    while (result.status === "RUNNING") {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (await isCancelled(runId)) {
        await axios.delete(`${env.RUNNER_URL}/runs/${result.id}`, { timeout: 10_000, headers: runnerHeaders }).catch(() => undefined);
        return { ok: false, degraded: false, stdout: result.stdout, stderr: "Cancelado pelo usuário", exitCode: null, durationMs: result.durationMs };
      }
      result = (await axios.get<RunnerJob>(`${env.RUNNER_URL}/runs/${result.id}`, { timeout: 30_000, headers: runnerHeaders })).data;
      await prisma.toolRun.update({
        where: { id: runId },
        data: { output: result.stdout?.slice(-200_000) || null, durationMs: result.durationMs },
      });
    }

    const ok = result.status === "SUCCEEDED" && result.exitCode === 0;
    // "Degradado" = o binário não está instalado no host → só geramos o script.
    const degraded = !ok && /not recognized|not found|no such file|cannot find|não é reconhecido|ENOENT/i.test(`${result.stderr} ${result.stdout}`);
    return { ok, degraded, stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode, durationMs: result.durationMs };
  } catch (error) {
    // Runner inacessível também é tratado como degradação (não quebra a run).
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ error: message, runId }, "Runner indisponível para comando da ferramenta");
    return { ok: false, degraded: true, stdout: "", stderr: `Runner indisponível: ${message}`, exitCode: null, durationMs: 0 };
  }
}

export async function finish(runId: string, input: {
  status: "SUCCEEDED" | "FAILED";
  summary: string;
  report: string;
  findings?: unknown;
  generatedScript?: string;
}): Promise<void> {
  // Não sobrescreve um cancelamento concorrente.
  if (await isCancelled(runId)) return;
  await prisma.toolRun.update({
    where: { id: runId },
    data: {
      status: input.status === "SUCCEEDED" ? AgentRunStatus.SUCCEEDED : AgentRunStatus.FAILED,
      summary: input.summary.slice(0, 2_000),
      report: input.report,
      findings: (input.findings ?? null) as object,
      generatedScript: input.generatedScript ?? null,
      finishedAt: new Date(),
    },
  });
}

export async function fail(runId: string, message: string): Promise<void> {
  await step(runId, "Falha na execução", "error", message);
  await prisma.toolRun.update({
    where: { id: runId },
    data: { status: AgentRunStatus.FAILED, error: message.slice(0, 4_000), summary: message.slice(0, 500), finishedAt: new Date() },
  }).catch(() => undefined);
}

export async function cancel(runId: string): Promise<boolean> {
  const run = await prisma.toolRun.findUnique({ where: { id: runId } });
  if (!run || run.status !== AgentRunStatus.RUNNING) return false;
  await prisma.toolRun.update({ where: { id: runId }, data: { status: AgentRunStatus.CANCELLED, finishedAt: new Date() } });
  if (run.runnerRunId) {
    await axios.delete(`${env.RUNNER_URL}/runs/${run.runnerRunId}`, { timeout: 10_000, headers: runnerHeaders }).catch(() => undefined);
  }
  return true;
}

export interface Subproject { name: string; path: string; type: string }
export interface SubprojectScan { root: string; rootHasManifest: boolean; rootType: string | null; subprojects: Subproject[] }

/** Detecta subprojetos (apps) dentro de uma pasta, via runner do host (local). */
export async function detectSubprojects(projectPath: string): Promise<SubprojectScan> {
  const res = await axios.post<SubprojectScan>(`${env.RUNNER_URL}/fs/subprojects`,
    { projectPath }, { timeout: 30_000, headers: runnerHeaders });
  return res.data;
}

export async function getRun(id: string) {
  return prisma.toolRun.findUnique({ where: { id } });
}

export async function listRuns(kind?: ToolKind, since?: Date) {
  return prisma.toolRun.findMany({
    where: { ...(kind ? { kind } : {}), ...(since ? { createdAt: { gt: since } } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, kind: true, status: true, channel: true, targetUrl: true,
      summary: true, totalTokens: true, durationMs: true, createdAt: true, finishedAt: true,
    },
  });
}
