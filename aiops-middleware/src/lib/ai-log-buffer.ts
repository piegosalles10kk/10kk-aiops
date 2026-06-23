import { Writable } from "node:stream";

export interface AiLogEntry {
  ts: number;
  level: number;
  msg: string;
  fields: Record<string, unknown>;
}

const MAX = 500;
const buffer: AiLogEntry[] = [];

// Campos que indicam atividade de IA
const AI_FIELDS = new Set([
  "model", "tool", "finishReason", "callCount", "callNames", "turn", "hasText",
  "indexed", "agentId", "runId", "cache", "chamadosAbertos", "fingerprint",
  "aiFallback", "fromFallback",
  "tokensIn", "tokensOut", "tokensTotal", "tokensCached", "resultados",
]);

// Prefixos/palavras nas mensagens que indicam atividade de IA
const AI_PATTERNS = [
  "Gerente", "ferramenta", "modelo", "Agente", "agente",
  "Execuç", "execuç", "Indexaç", "indexaç",
  "embedding", "RAG", "Scanner", "scanner",
  "incidente", "Incidente", "análise", "Análise",
  "Batch API", "Conhecimento", "knowledge",
  "Context cache", "Varredura", "Loop de indexação",
];

function isAiRelevant(obj: Record<string, unknown>): boolean {
  for (const f of AI_FIELDS) {
    if (f in obj) return true;
  }
  const msg = String(obj.msg ?? "");
  return AI_PATTERNS.some((p) => msg.includes(p));
}

export function pushAiLog(raw: string): void {
  const line = raw.trim();
  if (!line) return;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (!isAiRelevant(obj)) return;
    const { time, level, msg, pid: _pid, hostname: _host, ...fields } = obj;
    buffer.push({ ts: Number(time), level: Number(level), msg: String(msg), fields });
    if (buffer.length > MAX) buffer.shift();
  } catch {
    // linha não-JSON (ex.: aviso do npm) — ignora
  }
}

export function getAiLogs(since?: number): AiLogEntry[] {
  if (!since) return buffer.slice(-200);
  return buffer.filter((e) => e.ts > since);
}

/** Stream pino: cada chunk JSON é avaliado e empurrado para o buffer. */
export const aiLogStream = new Writable({
  write(chunk: Buffer, _enc, cb) {
    // pino pode enviar múltiplas linhas num chunk
    for (const line of chunk.toString().split("\n")) {
      pushAiLog(line);
    }
    cb();
  },
});
