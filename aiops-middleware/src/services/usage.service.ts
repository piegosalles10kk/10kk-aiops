import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";

/**
 * Contabilização de uso de tokens das chamadas ao Gemini e cálculo de custo.
 * Alimenta a tela de Consumo.
 */

/** Preço em USD por 1 milhão de tokens (entrada/saída). Estimativas — ajuste conforme o plano. */
interface ModelPrice {
  input: number;
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.075, output: 0.3 },
  "gemini-embedding-001": { input: 0.15, output: 0 },
};

const DEFAULT_PRICE: ModelPrice = { input: 0.3, output: 2.5 };

function priceFor(model: string): ModelPrice {
  const exact = PRICES[model];
  if (exact) return exact;
  // Casa por prefixo (ex.: "gemini-2.5-flash-preview-..." -> gemini-2.5-flash)
  const match = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((key) => model.startsWith(key));
  return (match && PRICES[match]) || DEFAULT_PRICE;
}

export function estimateCostUsd(
  model: string,
  promptTokens: number,
  outputTokens: number,
  options?: { cachedTokens?: number; batch?: boolean },
): number {
  const price = priceFor(model);
  // Tokens lidos do context cache custam ~10% do preço de entrada
  const cached = Math.min(options?.cachedTokens ?? 0, promptTokens);
  const fresh = promptTokens - cached;
  let cost =
    (fresh / 1_000_000) * price.input +
    (cached / 1_000_000) * price.input * 0.1 +
    (outputTokens / 1_000_000) * price.output;
  // Batch API: 50% de desconto sobre o total
  if (options?.batch) cost *= 0.5;
  return cost;
}

interface UsageMetadataLike {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

/**
 * Registra o uso de uma chamada ao Gemini. Nunca lança — contabilização
 * jamais deve quebrar o fluxo principal.
 */
export async function record(input: {
  model: string;
  feature: "manager" | "incident" | "embedding" | "visual_test" | "pentest" | "load_test";
  usage?: UsageMetadataLike | null;
  agentId?: string | null;
  /** true quando a chamada foi feita pela Batch API (50% de desconto). */
  batch?: boolean;
}): Promise<void> {
  try {
    const prompt = input.usage?.promptTokenCount ?? 0;
    const output = input.usage?.candidatesTokenCount ?? 0;
    const total = input.usage?.totalTokenCount ?? prompt + output;
    if (total <= 0) return;
    await prisma.tokenUsage.create({
      data: {
        model: input.model,
        feature: input.feature,
        agentId: input.agentId ?? null,
        promptTokens: prompt,
        outputTokens: output,
        totalTokens: total,
        costUsd: estimateCostUsd(input.model, prompt, output, {
          cachedTokens: input.usage?.cachedContentTokenCount ?? 0,
          batch: input.batch,
        }),
      },
    });
  } catch (error) {
    logger.debug({ error }, "Falha ao registrar uso de tokens (ignorada)");
  }
}

type Range = "day" | "week" | "month";

const RANGE_CONFIG: Record<Range, { windowMs: number; buckets: number }> = {
  day: { windowMs: 14 * 24 * 60 * 60 * 1000, buckets: 14 }, // 14 dias
  week: { windowMs: 12 * 7 * 24 * 60 * 60 * 1000, buckets: 12 }, // 12 semanas
  month: { windowMs: 365 * 24 * 60 * 60 * 1000, buckets: 12 }, // 12 meses
};

function bucketKey(date: Date, range: Range): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  if (range === "month") return `${y}-${m}`;
  if (range === "week") {
    // Segunda-feira da semana (ISO-ish) em UTC
    const tmp = new Date(Date.UTC(y, date.getUTCMonth(), date.getUTCDate()));
    const day = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() - day + 1);
    return `${tmp.getUTCFullYear()}-${String(tmp.getUTCMonth() + 1).padStart(2, "0")}-${String(tmp.getUTCDate()).padStart(2, "0")}`;
  }
  return `${y}-${m}-${d}`;
}

export interface UsageSummary {
  range: Range;
  totals: { totalTokens: number; promptTokens: number; outputTokens: number; costUsd: number; costBrl?: number; calls: number };
  byModel: Array<{ model: string; totalTokens: number; costUsd: number; costBrl?: number; calls: number }>;
  byFeature: Array<{ feature: string; totalTokens: number; costUsd: number; costBrl?: number }>;
  series: Array<{ bucket: string; totalTokens: number; costUsd: number; costBrl?: number }>;
  topAgents: Array<{ agent: string; runs: number; totalSeconds: number; succeeded: number }>;
}

export async function summary(range: Range = "day"): Promise<UsageSummary> {
  const cfg = RANGE_CONFIG[range];
  const since = new Date(Date.now() - cfg.windowMs);

  const rows = await prisma.tokenUsage.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
  });

  const totals = { totalTokens: 0, promptTokens: 0, outputTokens: 0, costUsd: 0, calls: rows.length };
  const byModel = new Map<string, { totalTokens: number; costUsd: number; calls: number }>();
  const byFeature = new Map<string, { totalTokens: number; costUsd: number }>();
  const series = new Map<string, { totalTokens: number; costUsd: number }>();

  for (const row of rows) {
    totals.totalTokens += row.totalTokens;
    totals.promptTokens += row.promptTokens;
    totals.outputTokens += row.outputTokens;
    totals.costUsd += row.costUsd;

    const m = byModel.get(row.model) ?? { totalTokens: 0, costUsd: 0, calls: 0 };
    m.totalTokens += row.totalTokens;
    m.costUsd += row.costUsd;
    m.calls += 1;
    byModel.set(row.model, m);

    const f = byFeature.get(row.feature) ?? { totalTokens: 0, costUsd: 0 };
    f.totalTokens += row.totalTokens;
    f.costUsd += row.costUsd;
    byFeature.set(row.feature, f);

    const key = bucketKey(row.createdAt, range);
    const s = series.get(key) ?? { totalTokens: 0, costUsd: 0 };
    s.totalTokens += row.totalTokens;
    s.costUsd += row.costUsd;
    series.set(key, s);
  }

  // Top agentes por execuções (os CLIs faturam tokens à parte; usamos o que temos)
  const runGroups = await prisma.agentRun.groupBy({
    by: ["agentId"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { durationMs: true },
  });
  const succeededGroups = await prisma.agentRun.groupBy({
    by: ["agentId"],
    where: { createdAt: { gte: since }, status: "SUCCEEDED" },
    _count: { _all: true },
  });
  const succeededByAgent = new Map(succeededGroups.map((g) => [g.agentId, g._count._all]));
  const agents = await prisma.agent.findMany({ select: { id: true, name: true } });
  const nameById = new Map(agents.map((a) => [a.id, a.name]));

  const topAgents = runGroups
    .map((g) => ({
      agent: nameById.get(g.agentId) ?? "—",
      runs: g._count._all,
      totalSeconds: Math.round((g._sum.durationMs ?? 0) / 1000),
      succeeded: succeededByAgent.get(g.agentId) ?? 0,
    }))
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 10);

  return {
    range,
    totals,
    byModel: [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    byFeature: [...byFeature.entries()]
      .map(([feature, v]) => ({ feature, ...v }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    series: [...series.entries()]
      .map(([bucket, v]) => ({ bucket, ...v }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket)),
    topAgents,
  };
}
