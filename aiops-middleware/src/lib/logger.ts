import pino from "pino";
import { env } from "../config/env.js";
import { aiLogStream } from "./ai-log-buffer.js";

const pinoOpts: pino.LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "config.headers['App-Token']",
      "config.headers['Session-Token']",
      "config.headers.Authorization",
      "*.appToken",
      "*.userToken",
      "*.sessionToken",
      "*.apiKey",
    ],
    censor: "[REDACTED]",
  },
};

/**
 * Logger estruturado (JSON em produção, legível em desenvolvimento).
 * Em produção usa multistream para alimentar também o buffer de logs de IA.
 * Tokens e credenciais nunca devem ser logados — use os campos `redact`.
 */
export const logger =
  env.NODE_ENV === "development"
    ? pino({ ...pinoOpts, transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } })
    : pino(pinoOpts, pino.multistream([{ stream: process.stdout }, { stream: aiLogStream }]));
