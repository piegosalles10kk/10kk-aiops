import axios from "axios";
import { env, isSlackEnabled } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { AiAnalysis } from "../schemas/ai-analysis.schema.js";
import { errorSummary, withRetry } from "../utils/retry.js";

const http = axios.create({ timeout: 10_000 });

interface IncidentNotification {
  title: string;
  analysis: AiAnalysis;
  glpiTicketId: number | null;
}

/**
 * Notifica abertura de incidente via Incoming Webhook (Block Kit).
 * Falha de Slack nunca interrompe o pipeline — é "best effort".
 */
export async function notifyIncidentOpened(input: IncidentNotification): Promise<void> {
  await send({
    text: `🚨 Novo incidente: ${input.title}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🚨 ${input.title}`, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Causa raiz:*\n${input.analysis.causaRaiz}` },
          { type: "mrkdwn", text: `*Impacto:*\n${input.analysis.impacto}` },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Solução recomendada:*\n${input.analysis.solucaoRecomendada}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: input.glpiTicketId
              ? `🎫 Ticket GLPI *#${input.glpiTicketId}* aberto automaticamente`
              : "⚠️ Ticket GLPI não pôde ser criado — verificar logs do middleware",
          },
        ],
      },
    ],
  });
}

/** Notifica resolução automática do incidente. */
export async function notifyIncidentResolved(
  title: string,
  glpiTicketId: number | null,
): Promise<void> {
  await send({
    text: `✅ Incidente resolvido: ${title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ *Incidente resolvido:* ${title}${
            glpiTicketId ? `\n🎫 Ticket GLPI #${glpiTicketId} solucionado automaticamente.` : ""
          }`,
        },
      },
    ],
  });
}

async function send(payload: Record<string, unknown>): Promise<void> {
  if (!isSlackEnabled || !env.SLACK_WEBHOOK_URL) {
    logger.warn("Slack desabilitado (SLACK_WEBHOOK_URL ausente) — notificação ignorada");
    return;
  }

  try {
    await withRetry(() => http.post(env.SLACK_WEBHOOK_URL!, payload), {
      label: "slack.send",
    });
  } catch (error) {
    logger.error({ err: errorSummary(error) }, "Falha definitiva ao notificar Slack");
  }
}
