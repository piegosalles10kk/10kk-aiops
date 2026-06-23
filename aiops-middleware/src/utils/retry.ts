import { isAxiosError } from "axios";
import { logger } from "../lib/logger.js";

interface RetryOptions {
  /** Quantidade de tentativas adicionais após a primeira falha. */
  retries?: number;
  /** Atraso base em ms (cresce exponencialmente: base, 2x, 4x...). */
  baseDelayMs?: number;
  /** Nome da operação, para logs. */
  label: string;
}

/**
 * Executa uma operação assíncrona com retry e backoff exponencial.
 * Útil para chamadas a APIs externas sujeitas a falhas transitórias.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 2, baseDelayMs = 500, label }: RetryOptions,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt;
        logger.warn(
          { label, attempt: attempt + 1, nextRetryInMs: delay, err: errorSummary(error) },
          "Falha em operação externa, tentando novamente",
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/** Resumo seguro de um erro (sem despejar headers/tokens de respostas axios). */
export function errorSummary(error: unknown): Record<string, unknown> {
  if (isAxiosError(error)) {
    return {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      responseData: error.response?.data,
      method: error.config?.method,
      url: error.config?.url,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }
  return { message: String(error) };
}
