import { GoogleGenAI, Type } from "@google/genai";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  aiAnalysisSchema,
  FALLBACK_ANALYSIS,
  type AiAnalysis,
} from "../schemas/ai-analysis.schema.js";
import { alertName, type GrafanaAlert } from "../schemas/grafana.schema.js";
import { errorSummary, withRetry } from "../utils/retry.js";
import * as usage from "./usage.service.js";
import * as knowledge from "./knowledge.service.js";

/**
 * System Instruction rigoroso: define papel, formato de saída e proibições.
 * Combinado com responseMimeType + responseSchema, força JSON estrito.
 */
const SYSTEM_INSTRUCTION = `
Você é um engenheiro SRE sênior especializado em análise de causa raiz (RCA) de incidentes de produção.

Sua tarefa: analisar o alerta de monitoramento e os logs fornecidos e produzir um diagnóstico objetivo.

REGRAS OBRIGATÓRIAS DE SAÍDA:
1. Responda EXCLUSIVAMENTE com um objeto JSON válido. Nenhum texto antes ou depois. Sem markdown, sem crases.
2. O objeto deve conter EXATAMENTE estas três chaves, todas com valores string em português do Brasil:
   - "causaRaiz": a causa raiz mais provável do problema, baseada nas evidências.
   - "impacto": o impacto técnico e de negócio (serviços afetados, usuários, severidade).
   - "solucaoRecomendada": passos acionáveis e ordenados para mitigar e resolver.
3. Se as evidências forem insuficientes, declare isso dentro dos campos — JAMAIS invente fatos.
4. Seja técnico, direto e conciso (máximo ~120 palavras por campo).
`.trim();

/** Schema declarativo enviado ao Gemini (structured output nativo da API). */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    causaRaiz: { type: Type.STRING },
    impacto: { type: Type.STRING },
    solucaoRecomendada: { type: Type.STRING },
  },
  required: ["causaRaiz", "impacto", "solucaoRecomendada"],
} as const;

function buildPrompt(alert: GrafanaAlert, logs?: string, pastContexts?: string[]): string {
  const sections = [
    `## Alerta disparado: ${alertName(alert)}`,
    `Status: ${alert.status}`,
    `Início: ${alert.startsAt ?? "desconhecido"}`,
    "",
    "### Labels",
    JSON.stringify(alert.labels, null, 2),
    "",
    "### Annotations (resumo/descrição do alerta)",
    JSON.stringify(alert.annotations, null, 2),
  ];

  if (alert.values && Object.keys(alert.values).length > 0) {
    sections.push("", "### Valores medidos no disparo", JSON.stringify(alert.values, null, 2));
  }

  if (logs?.trim()) {
    const truncated = logs.length > 15_000 ? `${logs.slice(0, 15_000)}\n...[truncado]` : logs;
    sections.push("", "### Logs relevantes", "```", truncated, "```");
  } else {
    sections.push("", "### Logs relevantes", "(nenhum log fornecido — baseie-se nos metadados do alerta)");
  }

  if (pastContexts && pastContexts.length > 0) {
    const truncated = pastContexts.join("\n---\n").slice(0, 8_000);
    sections.push("", "### Chamados anteriores similares (base de conhecimento)", truncated);
  }

  sections.push("", "Analise as evidências acima e produza o JSON de diagnóstico. Use os chamados anteriores similares como referência para causa raiz, impacto e solução, quando relevante.");
  return sections.join("\n");
}

/**
 * Analisa um incidente com o Gemini e retorna a análise validada pelo Zod.
 *
 * Resiliência: em caso de falha (rede, quota, JSON malformado), loga o erro
 * estruturado e retorna a análise de contingência — o pipeline de criação
 * de ticket nunca é bloqueado pela IA.
 */
export async function analyzeIncident(
  alert: GrafanaAlert,
  logs?: string,
): Promise<{ analysis: AiAnalysis; fromFallback: boolean }> {
  try {
    // Busca chamados anteriores similares na base vetorial para enriquecer a análise
    const query = `${alertName(alert)} ${alert.labels?.service ?? ""} ${alert.labels?.severity ?? ""} ${alert.annotations?.summary ?? ""}`;
    const pastContexts = await knowledge.searchKnowledge(query, 4).catch(() => []);

    let lastUsage: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined;

    const analysis = await withRetry(
      async () => {
        const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: env.GEMINI_MODEL,
          contents: buildPrompt(alert, logs, pastContexts),
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.2,
          },
        });

        lastUsage = response.usageMetadata;
        void usage.record({ model: env.GEMINI_MODEL, feature: "incident", usage: lastUsage });

        const raw = response.text;
        if (!raw) throw new Error("Gemini retornou resposta vazia");

        return aiAnalysisSchema.parse(JSON.parse(raw));
      },
      { label: "gemini.analyzeIncident", retries: 2, baseDelayMs: 1000 },
    );

    logger.info(
      {
        alertname: alertName(alert),
        model: env.GEMINI_MODEL,
        tokensIn: lastUsage?.promptTokenCount,
        tokensOut: lastUsage?.candidatesTokenCount,
        tokensTotal: lastUsage?.totalTokenCount,
      },
      "Análise da IA concluída e validada",
    );
    return { analysis, fromFallback: false };
  } catch (error) {
    logger.error(
      { err: errorSummary(error), alertname: alertName(alert) },
      "Falha definitiva na análise via Gemini — usando análise de contingência",
    );
    return { analysis: FALLBACK_ANALYSIS, fromFallback: true };
  }
}
