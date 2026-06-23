import crypto from "node:crypto";
import { env, isLokiEnabled } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import * as incidentRepo from "../repositories/incident.repository.js";
import type { GrafanaAlert } from "../schemas/grafana.schema.js";
import { errorSummary } from "../utils/retry.js";
import * as glpi from "./glpi.service.js";
import * as incidentService from "./incident.service.js";
import * as loki from "./loki.service.js";

/**
 * Scanner de erros no Loki: varre os logs periodicamente, agrupa os erros por
 * assinatura e abre um chamado para cada erro novo, reutilizando o MESMO
 * pipeline dos alertas do Grafana (análise da IA, GLPI, Trello, avisos).
 *
 * A deduplicação usa um fingerprint estável derivado da assinatura do erro:
 * enquanto houver um incidente aberto para aquele fingerprint, não cria outro.
 */

// Pega logs de nível alto do pino (50=error, 60=fatal) OU palavras de erro comuns
const SECURITY_FILTER =
  `unauthoriz|forbidden|não autorizado|nao autorizado|invalid token|expired token|` +
  `credenciais inválidas|origin not allowed by cors|hmac inválido|invalid signature|` +
  `signature mismatch|webhook unauthorized|brute force|attack|exploit|denied`;
const SCAN_FILTER =
  `("level":(5[0-9]|6[0-9]))|(?i)(error|exception|fatal|panic|falha|timeout|${SECURITY_FILTER})`;
const SECURITY_PATTERN = new RegExp(`(${SECURITY_FILTER})`, "i");

function scanEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(String(env.LOKI_SCAN_ENABLED).toLowerCase().trim());
}

interface ParsedLog {
  service: string;
  level?: number;
  errType?: string;
  message: string;
  raw: string;
  /** A linha é JSON estruturado (pino) de aplicação? */
  structured: boolean;
}

/** Mapeia nível textual (logfmt/winston) para a escala numérica do pino. */
const LEVEL_WORD: Record<string, number> = {
  trace: 10, debug: 20, info: 30, notice: 35, warn: 40, warning: 40,
  error: 50, err: 50, fatal: 60, crit: 60, critical: 60, emerg: 70,
};

function parseLine(entry: loki.LokiEntry): ParsedLog {
  try {
    const o = JSON.parse(entry.line) as Record<string, any>;
    let level: number | undefined;
    if (typeof o.level === "number") level = o.level;
    else if (typeof o.level === "string") level = LEVEL_WORD[o.level.toLowerCase()];
    return {
      service: String(o.service ?? o.name ?? entry.service),
      level,
      errType: o.err?.type ? String(o.err.type) : undefined,
      message: String(o.err?.message ?? o.msg ?? o.message ?? entry.line).slice(0, 300),
      raw: entry.line,
      structured: true,
    };
  } catch {
    // logfmt (ex.: logs internos do Grafana/Loki): extrai level=xxx
    const m = entry.line.match(/\blevel[=:]\s*"?(\w+)"?/i);
    return {
      service: entry.service,
      level: m?.[1] ? LEVEL_WORD[m[1].toLowerCase()] : undefined,
      message: entry.line.slice(0, 300),
      raw: entry.line,
      structured: false,
    };
  }
}

/** Normaliza a mensagem removendo TODAS as partes dinâmicas (ids, números, urls, paths). */
function normalize(message: string): string {
  return message
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ") // urls
    .replace(/[\w.-]+@[\w.-]+/g, " ") // emails
    .replace(/[a-z]:\\[^\s"]+|\/[^\s"]+\//g, " ") // paths
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, " ") // uuids
    .replace(/0x[0-9a-f]+|\b[0-9a-f]{12,}\b/g, " ") // hex/ids longos
    .replace(/\d[\d.:/-]*/g, " ") // números/datas/horas
    .replace(/["'`]/g, " ")
    .replace(/[^\p{L}\s]/gu, " ") // pontuação
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Conjunto de tokens significativos (palavras >= 4 letras) de uma mensagem normalizada. */
function tokenize(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((w) => w.length >= 4));
}

/** Índice de Jaccard entre dois conjuntos de tokens (0..1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Dois erros são "o mesmo" se forem do mesmo serviço e mensagens muito parecidas. */
const SIMILARITY_THRESHOLD = 0.6;

function fingerprintFor(environment: string, signature: string): string {
  return `loki-${environment}-${crypto.createHash("sha1").update(signature).digest("hex").slice(0, 10)}`;
}

interface ErrorGroup {
  fingerprint: string;
  environment: string;
  service: string;
  errType?: string;
  message: string;
  normMsg: string;
  tokens: Set<string>;
  level?: number;
  count: number;
  samples: string[];
}

async function scanEnvironment(environment: string): Promise<number> {
  const entries = await loki.queryLogEntries({
    selectors: { environment },
    filter: SCAN_FILTER,
    minutes: Number(env.LOKI_SCAN_LOOKBACK_MIN) || 7,
    limit: 1000,
  });

  const groups = new Map<string, ErrorGroup>();
  for (const entry of entries) {
    const parsed = parseLine(entry);
    const securityEvent = SECURITY_PATTERN.test(parsed.message);
    // Só erros de aplicação: nível >= 50 (error/fatal). Descarta info/warn/debug.
    if (parsed.level !== undefined && parsed.level < 50 && !securityEvent) continue;
    // Linha não estruturada (logfmt) sem nível claro de erro = ruído de
    // infraestrutura (ex.: logs internos do Grafana/Loki). Ignora.
    if (!parsed.structured && parsed.level === undefined && !securityEvent) continue;
    // Serviço não identificado e não estruturado também é ruído.
    if (!parsed.structured && (parsed.service === "unknown_service" || parsed.service === "?")) continue;

    const normMsg = normalize(parsed.message);
    const signature = `${parsed.service}|${parsed.errType ?? ""}|${normMsg}`;
    const fingerprint = fingerprintFor(environment, signature);
    const group = groups.get(fingerprint) ?? {
      fingerprint,
      environment,
      service: parsed.service,
      errType: parsed.errType,
      message: parsed.message,
      normMsg,
      tokens: tokenize(normMsg),
      level: parsed.level,
      count: 0,
      samples: [],
    };
    group.count += 1;
    if (group.samples.length < 5) group.samples.push(parsed.raw.slice(0, 500));
    groups.set(fingerprint, group);
  }

  const minCount = Number(env.LOKI_SCAN_MIN_COUNT) || 3;
  const maxPerCycle = Number(env.LOKI_SCAN_MAX_PER_CYCLE) || 5;
  const candidates = [...groups.values()]
    .filter((g) => g.count >= minCount)
    .sort((a, b) => b.count - a.count);

  // Assinaturas de erros que JÁ têm chamado aberto (para dedup por similaridade).
  const openFps = await incidentRepo.openLokiFingerprints();
  const openSigs =
    openFps.size > 0
      ? await prisma.lokiSignature.findMany({ where: { fingerprint: { in: [...openFps] } } })
      : [];
  const sigByFp = new Map(openSigs.map((s) => [s.fingerprint, s]));

  // Backfill: chamados loki abertos sem assinatura (criados antes desta tabela)
  // têm a assinatura reconstruída a partir do título do chamado no GLPI.
  for (const fp of openFps) {
    if (sigByFp.has(fp) || !fp.startsWith(`loki-${environment}-`)) continue;
    try {
      const inc = await incidentRepo.findByAlertId(fp);
      if (!inc?.glpiTicketId) continue;
      const ticket = await glpi.getTicket(inc.glpiTicketId);
      const match = ticket?.name.match(/\[Loki\]\s*([^:]+):\s*(.+)/);
      const service = match?.[1]?.trim() || "?";
      const normMsg = normalize(match?.[2] || ticket?.name || "");
      const created = await prisma.lokiSignature.create({
        data: { fingerprint: fp, environment, service, message: normMsg },
      });
      openSigs.push(created);
    } catch (error) {
      logger.debug({ err: errorSummary(error), fp }, "Falha ao backfillar assinatura do Loki");
    }
  }

  // Guarda de erros já considerados "abertos" nesta sessão (inclui os criados neste ciclo).
  const known = openSigs.map((s) => ({ service: s.service, tokens: tokenize(s.message) }));

  function isDuplicate(group: ErrorGroup): boolean {
    if (openFps.has(group.fingerprint)) return true; // mesmo fingerprint exato
    return known.some(
      (k) => k.service === group.service && jaccard(k.tokens, group.tokens) >= SIMILARITY_THRESHOLD,
    );
  }

  let opened = 0;
  for (const group of candidates) {
    if (opened >= maxPerCycle) break;
    // Já existe um chamado aberto para este erro (igual ou PARECIDO)? Não cria outro.
    if (isDuplicate(group)) continue;

    const shortMsg = group.message.replace(/\s+/g, " ").slice(0, 80);
    const alert: GrafanaAlert = {
      status: "firing",
      fingerprint: group.fingerprint,
      labels: {
        alertname: `[Loki] ${group.service}: ${shortMsg}`,
        environment,
        service_name: group.service,
        severity: (group.level ?? 50) >= 60 ? "critical" : "warning",
        origem: "loki-scanner",
      },
      annotations: {
        summary: `${group.count} ocorrências em ${Number(env.LOKI_SCAN_LOOKBACK_MIN) || 7}min: ${shortMsg}`,
        description: `Erro detectado automaticamente nos logs (${group.service}, ${environment}).\n\nAmostras:\n${group.samples.join("\n")}`,
        logs: group.samples.join("\n"),
      },
      startsAt: new Date().toISOString(),
    };

    try {
      await incidentService.handleFiringAlert(alert);
      // Persiste a assinatura e marca como "conhecida" para o resto deste ciclo
      await prisma.lokiSignature.upsert({
        where: { fingerprint: group.fingerprint },
        create: {
          fingerprint: group.fingerprint,
          environment,
          service: group.service,
          errType: group.errType ?? null,
          message: group.normMsg,
        },
        update: { message: group.normMsg },
      });
      known.push({ service: group.service, tokens: group.tokens });
      opened += 1;
      logger.info(
        { fingerprint: group.fingerprint, service: group.service, environment, count: group.count },
        "Scanner do Loki abriu chamado para erro detectado",
      );
    } catch (error) {
      logger.error(
        { err: errorSummary(error), fingerprint: group.fingerprint },
        "Falha ao abrir chamado a partir do scanner do Loki",
      );
    }
  }
  return opened;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function runScanCycle(): Promise<void> {
  if (running || !scanEnabled() || !isLokiEnabled) return;
  running = true;
  try {
    const environments = String(env.LOKI_SCAN_ENVIRONMENTS)
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    let total = 0;
    for (const environment of environments) {
      try {
        total += await scanEnvironment(environment);
      } catch (error) {
        logger.error({ err: errorSummary(error), environment }, "Falha na varredura do Loki");
      }
    }
    if (total > 0) logger.info({ chamadosAbertos: total }, "Varredura do Loki concluída");
  } finally {
    running = false;
  }
}

export function startLokiScanner(): void {
  if (timer) return;
  if (!scanEnabled()) {
    logger.info("Scanner do Loki desativado (LOKI_SCAN_ENABLED != true)");
    return;
  }
  if (!isLokiEnabled) {
    logger.warn("Scanner do Loki ligado mas Loki indisponível (configure GRAFANA_URL/SA_TOKEN)");
    return;
  }
  const interval = Number(env.LOKI_SCAN_INTERVAL_MS) || 300000;
  timer = setInterval(() => void runScanCycle(), interval);
  timer.unref();
  logger.info({ intervalMs: interval, environments: env.LOKI_SCAN_ENVIRONMENTS }, "Scanner de erros do Loki iniciado");
  // Primeira varredura logo após o boot (com pequeno atraso)
  setTimeout(() => void runScanCycle(), 15_000).unref();
}

export function stopLokiScanner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
