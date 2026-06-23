import type { Request, Response } from "express";
import { logger } from "../lib/logger.js";
import { grafanaWebhookSchema } from "../schemas/grafana.schema.js";
import * as incidentService from "../services/incident.service.js";
import { errorSummary } from "../utils/retry.js";

/**
 * POST /webhooks/grafana
 *
 * Valida o payload com Zod, responde 202 imediatamente (o Grafana tem
 * timeout curto e reenvia em caso de erro) e processa os alertas de
 * forma assíncrona. Cada alerta do grupo é tratado individualmente.
 */
export async function handleGrafanaWebhook(req: Request, res: Response): Promise<void> {
  const parsed = grafanaWebhookSchema.safeParse(req.body);

  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.flatten() },
      "Payload de webhook do Grafana inválido — rejeitado",
    );
    res.status(400).json({
      error: "Payload inválido",
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { alerts } = parsed.data;
  res.status(202).json({ accepted: alerts.length });

  // Processamento pós-resposta: falhas aqui são logadas, nunca derrubam o processo
  for (const alert of alerts) {
    try {
      if (alert.status === "resolved") {
        await incidentService.handleResolvedAlert(alert);
      } else {
        await incidentService.handleFiringAlert(alert);
      }
    } catch (error) {
      logger.error(
        { err: errorSummary(error), fingerprint: alert.fingerprint },
        "Erro não tratado ao processar alerta",
      );
    }
  }
}
