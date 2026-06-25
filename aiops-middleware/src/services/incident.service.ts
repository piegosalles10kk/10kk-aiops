import { logger } from "../lib/logger.js";
import * as incidentRepo from "../repositories/incident.repository.js";
import { alertName, type GrafanaAlert } from "../schemas/grafana.schema.js";
import { errorSummary } from "../utils/retry.js";
import * as gemini from "./gemini.service.js";
import * as glpi from "./glpi.service.js";
import * as glpiEntity from "./glpi-entity.service.js";
import * as loki from "./loki.service.js";
import * as slack from "./slack.service.js";
import * as trello from "./trello.service.js";
import * as telegram from "./telegram.service.js";

/**
 * Orquestrador do ciclo de vida do incidente.
 *
 * Princípios de resiliência aplicados:
 * - Cada integração externa (GLPI, Trello, Slack) falha de forma isolada:
 *   o erro é logado estruturadamente e o pipeline segue com o que conseguiu.
 * - Idempotência: alertas repetidos viram follow-up, nunca ticket duplicado.
 * - O estado persistido no Postgres é a fonte da verdade para correlação.
 */

function alertContextText(alert: GrafanaAlert): string {
  return JSON.stringify(
    {
      alertname: alertName(alert),
      fingerprint: alert.fingerprint,
      labels: alert.labels,
      annotations: alert.annotations,
      values: alert.values ?? undefined,
      startsAt: alert.startsAt,
      generatorURL: alert.generatorURL,
    },
    null,
    2,
  );
}

/** Processa um alerta em estado "firing". */
export async function handleFiringAlert(alert: GrafanaAlert): Promise<void> {
  const name = alertName(alert);
  const log = logger.child({ fingerprint: alert.fingerprint, alertname: name });

  // ---- 1. Idempotência: alerta já tem incidente OPEN? -> apenas append ----
  const existing = await incidentRepo.findOpenByAlertId(alert.fingerprint);
  if (existing) {
    log.info({ incidentId: existing.id }, "Alerta reincidente — registrando follow-up");

    const followupNote = `🔁 Alerta redisparado pelo Grafana em ${new Date().toISOString()}.<br><pre>${alertContextText(alert)}</pre>`;

    // O follow-up registrado aqui é espelhado para o Trello pelo motor de
    // sincronização (sync.service), então não comentamos no card diretamente.
    if (existing.glpiTicketId) {
      try {
        await glpi.addFollowup(existing.glpiTicketId, followupNote);
      } catch (error) {
        log.error({ err: errorSummary(error) }, "Falha ao adicionar follow-up no GLPI");
      }
    }
    return;
  }

  // ---- 2. Novo incidente: puxa logs reais do Loki para enriquecer a IA ----
  log.info("Novo incidente — coletando logs no Loki e iniciando análise com IA");
  const lokiLogs = await loki.fetchLogsForAlert(alert);
  const { analysis, fromFallback } = await gemini.analyzeIncident(
    alert,
    lokiLogs || alert.annotations.logs || alert.annotations.description,
  );

  // ---- 3. Cria o ticket no GLPI (entidade resolvida por labels do alerta) ----
  const entityId = await glpiEntity.resolveAlertEntity(alert.labels).catch(() => undefined);
  let glpiTicketId: number | null = null;
  try {
    glpiTicketId = await glpi.createTicket({
      title: `[AIOps] ${name}`,
      analysis,
      alertContext: alertContextText(alert),
      urgency: alert.labels.severity === "critical" ? 5 : 4,
      entityId,
    });
  } catch (error) {
    log.error({ err: errorSummary(error) }, "Falha ao criar ticket no GLPI");
  }

  // ---- 4. Cria o card no Trello ----
  let trelloCardId: string | null = null;
  try {
    trelloCardId = await trello.createCard({ title: name, analysis, glpiTicketId });
  } catch (error) {
    log.error({ err: errorSummary(error) }, "Falha ao criar card no Trello");
  }

  // ---- 5. Persiste o incidente (fonte da verdade para a resolução) ----
  const incident = await incidentRepo.upsertOpen({
    grafanaAlertId: alert.fingerprint,
    glpiTicketId,
    trelloCardId,
    aiAnalysis: { ...analysis, fromFallback },
  });

  // ---- 6. Notifica o Slack (best effort, não lança) ----
  await slack.notifyIncidentOpened({ title: name, analysis, glpiTicketId });
  await telegram.broadcast(
    `Novo incidente: ${name}\nGLPI: ${glpiTicketId ? `#${glpiTicketId}` : "não criado"}\n\nCausa: ${analysis.causaRaiz}\nImpacto: ${analysis.impacto}`,
  );

  log.info(
    { incidentId: incident.id, glpiTicketId, trelloCardId, aiFallback: fromFallback },
    "Incidente aberto e orquestrado",
  );
}

/** Processa um alerta em estado "resolved": resolução automática. */
export async function handleResolvedAlert(alert: GrafanaAlert): Promise<void> {
  const name = alertName(alert);
  const log = logger.child({ fingerprint: alert.fingerprint, alertname: name });

  const incident = await incidentRepo.findOpenByAlertId(alert.fingerprint);
  if (!incident) {
    log.warn("Recebido 'resolved' sem incidente OPEN correspondente — ignorando");
    return;
  }

  const solutionNote = `✅ Resolvido automaticamente: o Grafana reportou normalização do alerta em ${alert.endsAt ?? new Date().toISOString()}.`;

  if (incident.glpiTicketId) {
    try {
      await glpi.solveTicket(incident.glpiTicketId, solutionNote);
    } catch (error) {
      log.error({ err: errorSummary(error) }, "Falha ao solucionar ticket no GLPI");
    }
  }

  if (incident.trelloCardId) {
    try {
      await trello.moveCardToDone(incident.trelloCardId);
    } catch (error) {
      log.error({ err: errorSummary(error) }, "Falha ao mover card no Trello");
    }
  }

  await incidentRepo.markResolved(incident.id);
  await slack.notifyIncidentResolved(name, incident.glpiTicketId);
  await telegram.broadcast(
    `Incidente resolvido: ${name}${incident.glpiTicketId ? `\nGLPI #${incident.glpiTicketId}` : ""}`,
  );

  log.info({ incidentId: incident.id }, "Incidente resolvido automaticamente");
}
