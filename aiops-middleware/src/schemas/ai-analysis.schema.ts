import { z } from "zod";

/**
 * Contrato estrito da resposta da IA. Qualquer desvio (campo faltando,
 * tipo errado, texto fora do JSON) é rejeitado pelo Zod.
 */
export const aiAnalysisSchema = z.object({
  causaRaiz: z.string().min(1),
  impacto: z.string().min(1),
  solucaoRecomendada: z.string().min(1),
});

export type AiAnalysis = z.infer<typeof aiAnalysisSchema>;

/** Análise de contingência usada quando a IA falha — o pipeline nunca para por causa dela. */
export const FALLBACK_ANALYSIS: AiAnalysis = {
  causaRaiz: "Análise automática indisponível (falha na chamada à IA).",
  impacto: "Não avaliado automaticamente. Requer triagem manual.",
  solucaoRecomendada:
    "Verificar manualmente os logs e métricas associados ao alerta no Grafana.",
};
