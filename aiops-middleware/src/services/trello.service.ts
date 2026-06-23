import axios from "axios";
import FormData from "form-data";
import { env, isTrelloEnabled } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { AiAnalysis } from "../schemas/ai-analysis.schema.js";
import { withRetry } from "../utils/retry.js";

const http = axios.create({
  baseURL: "https://api.trello.com/1",
  timeout: 15_000,
});

/** Credenciais vão por query string, conforme padrão da API do Trello. */
function authParams() {
  return { key: env.TRELLO_API_KEY, token: env.TRELLO_TOKEN };
}

export interface CreateCardInput {
  title: string;
  analysis: AiAnalysis;
  glpiTicketId: number | null;
}

/**
 * Cria um card na lista de incidentes abertos.
 * Retorna o id do card, ou null se a integração estiver desabilitada.
 */
export async function createCard(input: CreateCardInput): Promise<string | null> {
  if (!isTrelloEnabled) {
    logger.warn("Trello desabilitado (variáveis ausentes) — card não criado");
    return null;
  }

  const description = [
    `**Causa raiz:** ${input.analysis.causaRaiz}`,
    "",
    `**Impacto:** ${input.analysis.impacto}`,
    "",
    `**Solução recomendada:** ${input.analysis.solucaoRecomendada}`,
    "",
    input.glpiTicketId ? `🎫 Ticket GLPI: #${input.glpiTicketId}` : "🎫 Ticket GLPI: não criado",
  ].join("\n");

  // Alertas do Grafana são sempre incidentes — aplica a label correspondente
  const typeLabels = await ensureTypeLabels().catch(() => null);

  return withRetry(
    async () => {
      const response = await http.post<{ id: string }>("/cards", null, {
        params: {
          ...authParams(),
          idList: env.TRELLO_LIST_ID_INCIDENT,
          name: `🚨 ${input.title}`,
          desc: description,
          ...(typeLabels ? { idLabels: typeLabels.incident } : {}),
        },
      });
      logger.info({ cardId: response.data.id }, "Card criado no Trello");
      return response.data.id;
    },
    { label: "trello.createCard" },
  );
}

/** Adiciona um comentário a um card e retorna o id da action criada. */
export async function addComment(cardId: string, text: string): Promise<string | null> {
  if (!isTrelloEnabled) return null;

  return withRetry(
    async () => {
      const response = await http.post<{ id: string }>(
        `/cards/${cardId}/actions/comments`,
        null,
        { params: { ...authParams(), text } },
      );
      logger.info({ cardId }, "Comentário adicionado ao card do Trello");
      return response.data.id;
    },
    { label: "trello.addComment" },
  );
}

// ---------------------------------------------------------------------------
// Operações usadas pela sincronização bidirecional GLPI <-> Trello
// ---------------------------------------------------------------------------

export interface TrelloComment {
  id: string;
  text: string;
  author: string;
  date: string;
}

export interface TrelloCheckItem {
  id: string;
  name: string;
  /** "complete" | "incomplete" */
  state: string;
}

export interface TrelloLabel {
  id: string;
  name: string;
}

export interface TrelloCardSummary {
  id: string;
  name: string;
  desc: string;
  idList: string;
  labels?: TrelloLabel[];
}

/** Cards de uma lista (usado para descobrir cards criados manualmente). */
export async function getListCards(listId: string): Promise<TrelloCardSummary[]> {
  if (!isTrelloEnabled) return [];
  const response = await http.get<TrelloCardSummary[]>(`/lists/${listId}/cards`, {
    params: { ...authParams(), fields: "name,desc,idList,labels" },
  });
  return response.data;
}

/** Dados básicos de um card (lista atual, nome, descrição, labels). */
export async function getCard(cardId: string): Promise<TrelloCardSummary | null> {
  if (!isTrelloEnabled) return null;
  const response = await http.get<TrelloCardSummary>(`/cards/${cardId}`, {
    params: { ...authParams(), fields: "name,desc,idList,labels" },
  });
  return response.data;
}

// ---------------------------------------------------------------------------
// Labels de tipo (Incidente x Requisição) — espelham o campo "type" do GLPI
// ---------------------------------------------------------------------------

let cachedTypeLabels: { incident: string; request: string } | null = null;

/**
 * Garante que o board tenha as labels "Incidente" (vermelha) e
 * "Requisição" (azul), criando-as se necessário. Resultado cacheado.
 */
export async function ensureTypeLabels(): Promise<{ incident: string; request: string } | null> {
  if (!isTrelloEnabled || !env.TRELLO_LIST_ID_INCIDENT) return null;
  if (cachedTypeLabels) return cachedTypeLabels;

  const list = await http.get<{ idBoard: string }>(`/lists/${env.TRELLO_LIST_ID_INCIDENT}`, {
    params: { ...authParams(), fields: "idBoard" },
  });
  const boardId = list.data.idBoard;

  const labels = await http.get<TrelloLabel[]>(`/boards/${boardId}/labels`, {
    params: authParams(),
  });
  const findLabel = (fragment: string) =>
    labels.data.find((l) => normalizeName(l.name ?? "").includes(fragment))?.id;

  let incident = findLabel("incidente");
  let request = findLabel("requisi");

  if (!incident) {
    const created = await http.post<{ id: string }>(`/boards/${boardId}/labels`, null, {
      params: { ...authParams(), name: "Incidente", color: "red" },
    });
    incident = created.data.id;
    logger.info({ boardId }, "Label 'Incidente' criada no board do Trello");
  }
  if (!request) {
    const created = await http.post<{ id: string }>(`/boards/${boardId}/labels`, null, {
      params: { ...authParams(), name: "Requisição", color: "blue" },
    });
    request = created.data.id;
    logger.info({ boardId }, "Label 'Requisição' criada no board do Trello");
  }

  cachedTypeLabels = { incident, request };
  return cachedTypeLabels;
}

/** Aplica uma label a um card (ignora erro de label já presente). */
export async function addLabelToCard(cardId: string, labelId: string): Promise<void> {
  if (!isTrelloEnabled) return;
  try {
    await http.post(`/cards/${cardId}/idLabels`, null, {
      params: { ...authParams(), value: labelId },
    });
  } catch (error) {
    // 400 "label is already on the card" é esperado em re-sync
    logger.debug({ cardId, labelId }, "Label já presente no card (ignorado)");
  }
}

/** Verifica se o card tem a label de Requisição (senão, é Incidente). */
export function cardIsRequest(card: TrelloCardSummary): boolean {
  return (card.labels ?? []).some((l) => normalizeName(l.name ?? "").includes("requisi"));
}

/** Cria um card genérico (usado para chamados criados à mão no GLPI). */
export async function createBasicCard(input: {
  title: string;
  description: string;
  listId?: string;
  labelId?: string | null;
}): Promise<string | null> {
  if (!isTrelloEnabled) {
    logger.warn("Trello desabilitado (variáveis ausentes) — card não criado");
    return null;
  }

  return withRetry(
    async () => {
      const response = await http.post<{ id: string }>("/cards", null, {
        params: {
          ...authParams(),
          idList: input.listId ?? env.TRELLO_LIST_ID_INCIDENT,
          name: input.title,
          desc: input.description,
          ...(input.labelId ? { idLabels: input.labelId } : {}),
        },
      });
      logger.info({ cardId: response.data.id }, "Card criado no Trello");
      return response.data.id;
    },
    { label: "trello.createBasicCard" },
  );
}

/** Move o card para uma lista específica. */
export async function moveCardToList(cardId: string, listId: string): Promise<void> {
  if (!isTrelloEnabled) return;
  await withRetry(
    async () => {
      await http.put(`/cards/${cardId}`, null, {
        params: { ...authParams(), idList: listId },
      });
      logger.info({ cardId, listId }, "Card movido de lista no Trello");
    },
    { label: "trello.moveCardToList" },
  );
}

/** Move o card para a lista "em andamento" (técnico atribuído no GLPI). */
export async function moveCardToInProgress(cardId: string): Promise<void> {
  if (!env.TRELLO_LIST_ID_IN_PROGRESS) {
    logger.warn({ cardId }, "TRELLO_LIST_ID_IN_PROGRESS não configurado — card não movido");
    return;
  }
  await moveCardToList(cardId, env.TRELLO_LIST_ID_IN_PROGRESS);
}

/** Remove acentos/caixa para comparação tolerante de nomes. */
function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Procura no board do card um membro cujo nome corresponda ao do técnico
 * do GLPI (comparação sem acentos/caixa, aceita correspondência parcial).
 */
export async function findBoardMemberId(
  cardId: string,
  techName: string,
): Promise<string | null> {
  if (!isTrelloEnabled) return null;

  const card = await http.get<{ idBoard: string }>(`/cards/${cardId}`, {
    params: { ...authParams(), fields: "idBoard" },
  });
  const members = await http.get<Array<{ id: string; fullName: string; username: string }>>(
    `/boards/${card.data.idBoard}/members`,
    { params: authParams() },
  );

  const target = normalizeName(techName);
  const match = members.data.find((m) => {
    const full = normalizeName(m.fullName ?? "");
    const user = normalizeName(m.username ?? "");
    return full === target || user === target || full.includes(target) || target.includes(full);
  });
  return match?.id ?? null;
}

/** Atribui um membro do board ao card. */
export async function addMemberToCard(cardId: string, memberId: string): Promise<void> {
  if (!isTrelloEnabled) return;
  await withRetry(
    async () => {
      await http.post(`/cards/${cardId}/idMembers`, null, {
        params: { ...authParams(), value: memberId },
      });
      logger.info({ cardId, memberId }, "Membro atribuído ao card do Trello");
    },
    { label: "trello.addMemberToCard" },
  );
}

/** Lista os comentários do card (actions do tipo commentCard, mais recentes primeiro). */
export async function getComments(cardId: string): Promise<TrelloComment[]> {
  if (!isTrelloEnabled) return [];

  const response = await http.get<
    Array<{ id: string; date: string; data: { text: string }; memberCreator?: { fullName?: string } }>
  >(`/cards/${cardId}/actions`, {
    params: { ...authParams(), filter: "commentCard", limit: 50 },
  });

  return response.data.map((a) => ({
    id: a.id,
    text: a.data.text,
    author: a.memberCreator?.fullName ?? "alguém no Trello",
    date: a.date,
  }));
}

/** Procura uma checklist pelo nome no card (sem criar). */
export async function findChecklist(cardId: string, name: string): Promise<string | null> {
  if (!isTrelloEnabled) return null;

  const existing = await http.get<Array<{ id: string; name: string }>>(
    `/cards/${cardId}/checklists`,
    { params: { ...authParams(), checkItems: "none" } },
  );
  return existing.data.find((c) => c.name === name)?.id ?? null;
}

/** Garante a existência de uma checklist com o nome dado e retorna seu id. */
export async function ensureChecklist(cardId: string, name: string): Promise<string | null> {
  if (!isTrelloEnabled) return null;

  const found = await findChecklist(cardId, name);
  if (found) return found;

  const created = await http.post<{ id: string }>("/checklists", null, {
    params: { ...authParams(), idCard: cardId, name },
  });
  logger.info({ cardId, checklistId: created.data.id }, "Checklist criada no card do Trello");
  return created.data.id;
}

/** Itens de uma checklist. */
export async function getCheckItems(checklistId: string): Promise<TrelloCheckItem[]> {
  if (!isTrelloEnabled) return [];
  const response = await http.get<TrelloCheckItem[]>(`/checklists/${checklistId}/checkItems`, {
    params: authParams(),
  });
  return response.data;
}

/** Adiciona um item à checklist e retorna o id. */
export async function addCheckItem(
  checklistId: string,
  name: string,
  checked: boolean,
): Promise<string | null> {
  if (!isTrelloEnabled) return null;
  return withRetry(
    async () => {
      const response = await http.post<{ id: string }>(
        `/checklists/${checklistId}/checkItems`,
        null,
        { params: { ...authParams(), name, checked } },
      );
      logger.info({ checklistId, checkItemId: response.data.id }, "Item adicionado à checklist");
      return response.data.id;
    },
    { label: "trello.addCheckItem" },
  );
}

/** Marca/desmarca um item da checklist. */
export async function setCheckItemState(
  cardId: string,
  checkItemId: string,
  state: "complete" | "incomplete",
): Promise<void> {
  if (!isTrelloEnabled) return;
  await withRetry(
    async () => {
      await http.put(`/cards/${cardId}/checkItem/${checkItemId}`, null, {
        params: { ...authParams(), state },
      });
      logger.info({ cardId, checkItemId, state }, "Estado de item da checklist atualizado");
    },
    { label: "trello.setCheckItemState" },
  );
}

// ---------------------------------------------------------------------------
// Anexos do card <-> documentos do GLPI
// ---------------------------------------------------------------------------

export interface TrelloAttachment {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  bytes: number;
  isUpload: boolean;
}

/** Lista os anexos de um card. */
export async function getAttachments(cardId: string): Promise<TrelloAttachment[]> {
  if (!isTrelloEnabled) return [];
  const response = await http.get<
    Array<{ id: string; name: string; url: string; mimeType?: string; bytes?: number; isUpload?: boolean }>
  >(`/cards/${cardId}/attachments`, { params: authParams() });
  return response.data.map((a) => ({
    id: a.id,
    name: a.name,
    url: a.url,
    mimeType: a.mimeType || "application/octet-stream",
    bytes: a.bytes ?? 0,
    isUpload: a.isUpload ?? false,
  }));
}

/** Baixa o conteúdo binário de um anexo enviado ao Trello (requer auth OAuth). */
export async function downloadAttachment(url: string): Promise<Buffer> {
  const response = await http.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 60_000,
    // Downloads de uploads no Trello exigem o header de autorização OAuth
    headers: {
      Authorization: `OAuth oauth_consumer_key="${env.TRELLO_API_KEY}", oauth_token="${env.TRELLO_TOKEN}"`,
    },
  });
  return Buffer.from(response.data);
}

/** Envia um arquivo como anexo de um card e retorna o id do anexo. */
export async function uploadAttachment(
  cardId: string,
  filename: string,
  mime: string,
  buffer: Buffer,
): Promise<string | null> {
  if (!isTrelloEnabled) return null;
  return withRetry(
    async () => {
      const form = new FormData();
      form.append("file", buffer, { filename, contentType: mime });
      form.append("name", filename);
      const response = await http.post<{ id: string }>(`/cards/${cardId}/attachments`, form, {
        params: authParams(),
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 60_000,
      });
      logger.info({ cardId, attachmentId: response.data.id, filename }, "Anexo enviado ao card do Trello");
      return response.data.id;
    },
    { label: "trello.uploadAttachment" },
  );
}

/** Move o card para a lista de concluídos (alerta resolvido). */
export async function moveCardToDone(cardId: string): Promise<void> {
  if (!isTrelloEnabled) return;
  if (!env.TRELLO_LIST_ID_DONE) {
    logger.warn({ cardId }, "TRELLO_LIST_ID_DONE não configurado — card não movido");
    return;
  }

  await withRetry(
    async () => {
      await http.put(`/cards/${cardId}`, null, {
        params: { ...authParams(), idList: env.TRELLO_LIST_ID_DONE },
      });
      logger.info({ cardId }, "Card movido para a lista de concluídos no Trello");
    },
    { label: "trello.moveCardToDone" },
  );
}
