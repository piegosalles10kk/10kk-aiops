import { z } from "zod";

/**
 * Payload do webhook de alertas do Grafana (contact point "webhook").
 * Mantemos o schema tolerante (campos extras são permitidos) e estrito
 * apenas no que o pipeline realmente consome.
 */
export const grafanaAlertSchema = z.object({
  status: z.enum(["firing", "resolved"]),
  /** Identificador estável do alerta no Grafana — base da idempotência. */
  fingerprint: z.string().min(1),
  labels: z.record(z.string()).default({}),
  annotations: z.record(z.string()).default({}),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  /** Valores das queries que dispararam o alerta (ex.: {"B": 92.3}). */
  values: z.record(z.number().nullable()).nullish(),
  valueString: z.string().optional(),
});

export const grafanaWebhookSchema = z.object({
  receiver: z.string().optional(),
  status: z.enum(["firing", "resolved"]),
  alerts: z.array(grafanaAlertSchema).min(1),
  groupLabels: z.record(z.string()).optional(),
  commonLabels: z.record(z.string()).optional(),
  commonAnnotations: z.record(z.string()).optional(),
  externalURL: z.string().optional(),
});

export type GrafanaAlert = z.infer<typeof grafanaAlertSchema>;
export type GrafanaWebhook = z.infer<typeof grafanaWebhookSchema>;

/** Nome amigável do alerta para títulos de ticket/card. */
export function alertName(alert: GrafanaAlert): string {
  return alert.labels.alertname ?? "Alerta sem nome";
}
