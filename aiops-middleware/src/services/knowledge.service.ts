import axios from "axios";
import { GoogleGenAI, JobState } from "@google/genai";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { errorSummary } from "../utils/retry.js";
import * as glpi from "./glpi.service.js";
import * as usage from "./usage.service.js";

const collection = "glpi_tickets";
const EMBEDDING_MODEL = "gemini-embedding-001";

function batchEmbeddingsEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    String(env.GEMINI_BATCH_EMBEDDINGS_ENABLED).toLowerCase().trim(),
  );
}

const BATCH_POLL_INTERVAL_MS = 10_000;
const BATCH_TIMEOUT_MS = 10 * 60_000;

/**
 * Embeda vários textos de uma vez pela Batch API (50% de desconto). O reindex
 * roda em background, então a latência extra do lote é aceitável. Retorna null
 * em qualquer falha/timeout para o chamador cair no fluxo inline.
 */
async function batchEmbeddings(texts: string[]): Promise<Array<number[] | null> | null> {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  try {
    const job = await ai.batches.createEmbeddings({
      model: EMBEDDING_MODEL,
      src: { inlinedRequests: { contents: texts } },
    });
    if (!job.name) throw new Error("job de batch criado sem nome");

    const deadline = Date.now() + BATCH_TIMEOUT_MS;
    let current = job;
    while (
      current.state !== JobState.JOB_STATE_SUCCEEDED &&
      current.state !== JobState.JOB_STATE_FAILED &&
      current.state !== JobState.JOB_STATE_CANCELLED
    ) {
      if (Date.now() > deadline) throw new Error("batch não concluiu dentro do tempo limite");
      await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_INTERVAL_MS));
      current = await ai.batches.get({ name: job.name });
    }
    if (current.state !== JobState.JOB_STATE_SUCCEEDED) {
      throw new Error(`batch terminou em ${current.state}: ${current.error?.message ?? "sem detalhe"}`);
    }

    const responses = current.dest?.inlinedEmbedContentResponses ?? [];
    if (responses.length !== texts.length) {
      throw new Error(`batch devolveu ${responses.length} respostas para ${texts.length} textos`);
    }

    const tokens = texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
    void usage.record({
      model: EMBEDDING_MODEL,
      feature: "embedding",
      usage: { promptTokenCount: tokens, totalTokenCount: tokens },
      batch: true,
    });
    logger.info({ textos: texts.length, job: job.name, tokensIn: tokens }, "Embeddings gerados pela Batch API (50% de desconto)");
    return responses.map((item) => item.response?.embedding?.values ?? null);
  } catch (error) {
    logger.warn({ err: errorSummary(error) }, "Batch API indisponível para embeddings; usando fluxo inline");
    return null;
  }
}

async function embedding(text: string): Promise<number[]> {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const input = text.slice(0, 16_000);
  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: input,
  });
  const tokens = Math.ceil(input.length / 4);
  void usage.record({
    model: EMBEDDING_MODEL,
    feature: "embedding",
    usage: { promptTokenCount: tokens, totalTokenCount: tokens },
  });
  return response.embeddings?.[0]?.values ?? [];
}

/** Resolve o escopo (projeto/componente) de um chamado pelo incidente vinculado. */
async function ticketScope(ticketId: number): Promise<{ projectId: string | null; componentId: string | null }> {
  try {
    const incident = await prisma.incident.findFirst({
      where: { glpiTicketId: ticketId },
      select: { projectId: true, componentId: true },
      orderBy: { createdAt: "desc" },
    });
    return { projectId: incident?.projectId ?? null, componentId: incident?.componentId ?? null };
  } catch {
    return { projectId: null, componentId: null };
  }
}

async function ensureCollection(size: number): Promise<void> {
  try {
    await axios.get(`${env.QDRANT_URL}/collections/${collection}`, { timeout: 5_000 });
  } catch {
    await axios.put(`${env.QDRANT_URL}/collections/${collection}`, {
      vectors: { size, distance: "Cosine" },
    }, { timeout: 10_000 });
  }
}

export async function indexRecentTickets(): Promise<number> {
  const tickets = await glpi.listRecentTickets();

  // Carrega os contextos primeiro para poder embedar tudo em um único lote
  const items: Array<{ id: number; name: string; status: number; context: string }> = [];
  for (const ticket of tickets) {
    try {
      const context = (await glpi.getTicketContext(ticket.id)).slice(0, 16_000);
      items.push({ id: ticket.id, name: ticket.name, status: ticket.status, context });
    } catch (error) {
      logger.debug({ error, ticketId: ticket.id }, "Falha ao carregar contexto do chamado");
    }
  }
  if (items.length === 0) return 0;

  // Lotes pequenos não compensam a latência do job assíncrono
  const vectors =
    batchEmbeddingsEnabled() && items.length >= 4
      ? await batchEmbeddings(items.map((item) => item.context))
      : null;

  let indexed = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    try {
      const vector = vectors?.[i] ?? (await embedding(item.context));
      if (!vector.length) continue;
      await ensureCollection(vector.length);
      const scope = await ticketScope(item.id);
      await axios.put(`${env.QDRANT_URL}/collections/${collection}/points`, {
        points: [{
          id: item.id,
          vector,
          payload: {
            ticketId: item.id, name: item.name, status: item.status, context: item.context,
            sourceType: "ticket", projectId: scope.projectId, componentId: scope.componentId,
          },
        }],
      }, { params: { wait: true }, timeout: 15_000 });
      indexed++;
    } catch (error) {
      logger.debug({ error, ticketId: item.id }, "Falha ao indexar chamado no Qdrant");
    }
  }
  return indexed;
}

/**
 * Indexa UM chamado específico no Qdrant (insere ou atualiza).
 * Chamado sempre que um ticket é solucionado, comentado ou alterado.
 */
export async function indexTicket(ticketId: number): Promise<boolean> {
  try {
    const context = (await glpi.getTicketContext(ticketId)).slice(0, 16_000);
    if (!context) return false;
    const vector = await embedding(context);
    if (!vector.length) return false;
    await ensureCollection(vector.length);
    const ticket = await glpi.getTicket(ticketId);
    const scope = await ticketScope(ticketId);
    await axios.put(`${env.QDRANT_URL}/collections/${collection}/points`, {
      points: [{
        id: ticketId,
        vector,
        payload: {
          ticketId,
          name: ticket?.name ?? `Chamado #${ticketId}`,
          status: ticket?.status ?? 0,
          context,
          sourceType: "ticket",
          projectId: scope.projectId,
          componentId: scope.componentId,
        },
      }],
    }, { params: { wait: true }, timeout: 15_000 });
    logger.info(
      { ticketId, model: EMBEDDING_MODEL, tokensIn: Math.ceil(context.length / 4) },
      "Ticket indexado no Qdrant (embedding)",
    );
    return true;
  } catch (error) {
    logger.warn({ error, ticketId }, "Falha ao indexar chamado individual no Qdrant");
    return false;
  }
}


export interface KnowledgeScope {
  /** null = sem restrição (web/admin). Lista vazia = sem acesso a nada escopado. */
  projectIds?: string[] | null;
  componentIds?: string[] | null;
}

/**
 * Monta o filtro do Qdrant a partir do escopo permitido. Conhecimento legado
 * (sem projectId) permanece visível para não quebrar o uso atual; pontos
 * escopados só aparecem se o projeto estiver na lista permitida.
 */
export function buildScopeFilter(scope?: KnowledgeScope): Record<string, unknown> | undefined {
  if (!scope || scope.projectIds == null) return undefined; // acesso amplo
  return {
    should: [
      { is_empty: { key: "projectId" } },
      ...(scope.projectIds.length ? [{ key: "projectId", match: { any: scope.projectIds } }] : []),
    ],
  };
}

export async function searchKnowledge(query: string, limit = 6, scope?: KnowledgeScope): Promise<string[]> {
  try {
    const vector = await embedding(query);
    if (!vector.length) return [];
    const filter = buildScopeFilter(scope);
    const { data } = await axios.post<{
      result?: Array<{ payload?: { context?: string } }>;
    }>(`${env.QDRANT_URL}/collections/${collection}/points/search`, {
      vector,
      limit,
      with_payload: true,
      ...(filter ? { filter } : {}),
    }, { timeout: 15_000 });
    const results = (data.result ?? []).map((item) => item.payload?.context).filter(Boolean) as string[];
    logger.info(
      { model: EMBEDDING_MODEL, tokensIn: Math.ceil(query.length / 4), resultados: results.length },
      "Busca RAG no Qdrant",
    );
    return results;
  } catch {
    const tickets = await glpi.listRecentTickets();
    const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
    return tickets
      .filter((ticket) => words.some((word) => `${ticket.id} ${ticket.name}`.toLowerCase().includes(word)))
      .slice(0, limit)
      .map((ticket) => JSON.stringify(ticket));
  }
}
