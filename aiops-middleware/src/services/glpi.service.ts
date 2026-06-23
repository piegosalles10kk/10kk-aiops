import axios, { AxiosError, type AxiosInstance } from "axios";
import FormData from "form-data";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { AiAnalysis } from "../schemas/ai-analysis.schema.js";
import { errorSummary, withRetry } from "../utils/retry.js";
import * as knowledge from "./knowledge.service.js";

/** Status nativos do GLPI para tickets. */
export const GLPI_TICKET_STATUS = {
  NEW: 1,
  ASSIGNED: 2,
  PLANNED: 3,
  PENDING: 4,
  SOLVED: 5,
  CLOSED: 6,
} as const;

const http: AxiosInstance = axios.create({
  baseURL: env.GLPI_API_URL,
  // O GLPI local tem latência alta em chamadas frias (initSession ~5s)
  timeout: 30_000,
  headers: {
    "Content-Type": "application/json",
    "App-Token": env.GLPI_APP_TOKEN,
  },
});

/**
 * Cache do Session-Token do GLPI.
 * O initSession é caro e a sessão expira no servidor; mantemos o token em
 * memória e renovamos automaticamente ao receber 401 (ERROR_SESSION_TOKEN_INVALID).
 */
let sessionToken: string | null = null;

/**
 * Inicializa a sessão no GLPI usando App-Token + user_token.
 * GET {GLPI_API_URL}/initSession
 *   Headers: App-Token, Authorization: user_token <GLPI_USER_TOKEN>
 * Resposta: { "session_token": "..." }
 */
async function initSession(): Promise<string> {
  const response = await http.get<{ session_token: string }>("/initSession", {
    headers: {
      Authorization: `user_token ${env.GLPI_USER_TOKEN}`,
    },
  });

  if (!response.data?.session_token) {
    throw new Error("GLPI initSession não retornou session_token");
  }

  logger.info("Sessão GLPI inicializada com sucesso");
  return response.data.session_token;
}

async function getSessionToken(forceRefresh = false): Promise<string> {
  if (!sessionToken || forceRefresh) {
    sessionToken = await initSession();
  }
  return sessionToken;
}

/**
 * Executa uma chamada autenticada ao GLPI. Se a sessão tiver expirado (401),
 * renova o token uma única vez e repete a chamada.
 */
async function withSession<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const token = await getSessionToken();
  try {
    return await fn(token);
  } catch (error) {
    const isSessionExpired =
      error instanceof AxiosError && error.response?.status === 401;
    if (!isSessionExpired) throw error;

    logger.warn("Sessão GLPI expirada (401) — renovando token e repetindo a chamada");
    const freshToken = await getSessionToken(true);
    return fn(freshToken);
  }
}

function buildTicketContent(analysis: AiAnalysis, alertContext: string): string {
  // GLPI renderiza HTML no campo content
  return [
    "<h2>🤖 Diagnóstico automático (AIOps)</h2>",
    `<p><strong>Causa raiz:</strong> ${analysis.causaRaiz}</p>`,
    `<p><strong>Impacto:</strong> ${analysis.impacto}</p>`,
    `<p><strong>Solução recomendada:</strong> ${analysis.solucaoRecomendada}</p>`,
    "<hr>",
    "<h3>Contexto do alerta (Grafana)</h3>",
    `<pre>${alertContext}</pre>`,
  ].join("\n");
}

export interface CreateTicketInput {
  title: string;
  analysis: AiAnalysis;
  alertContext: string;
  /** 1=muito baixa ... 5=muito alta (urgência GLPI). */
  urgency?: number;
}

/** Tipos de chamado no GLPI. */
export const GLPI_TICKET_TYPE = { INCIDENT: 1, REQUEST: 2 } as const;

/** Cria um chamado com título e conteúdo HTML livres. Retorna o id. */
export async function createRawTicket(input: {
  title: string;
  content: string;
  urgency?: number;
  /** 1 = Incidente (default), 2 = Requisição. */
  type?: number;
}): Promise<number> {
  return withRetry(
    () =>
      withSession(async (token) => {
        const response = await http.post<{ id: number }>(
          "/Ticket",
          {
            input: {
              name: input.title,
              content: input.content,
              urgency: input.urgency ?? 3,
              status: GLPI_TICKET_STATUS.NEW,
              type: input.type ?? GLPI_TICKET_TYPE.INCIDENT,
            },
          },
          { headers: { "Session-Token": token } },
        );

        const ticketId = response.data?.id;
        if (!ticketId) {
          throw new Error(
            `GLPI não retornou id do ticket criado: ${JSON.stringify(response.data)}`,
          );
        }

        logger.info({ ticketId, title: input.title }, "Ticket criado no GLPI");
        return ticketId;
      }),
    { label: "glpi.createTicket" },
  );
}

/**
 * Cria um chamado de incidente (AIOps) com o diagnóstico da IA.
 * POST {GLPI_API_URL}/Ticket  body: { input: {...} }
 */
export async function createTicket(input: CreateTicketInput): Promise<number> {
  return createRawTicket({
    title: input.title,
    content: buildTicketContent(input.analysis, input.alertContext),
    urgency: input.urgency ?? 4,
  });
}

/**
 * Adiciona uma anotação de acompanhamento (ITILFollowup) a um ticket
 * existente — usado quando o Grafana redispara um alerta já aberto
 * (idempotência), em vez de criar ticket duplicado.
 */
export async function addFollowup(
  ticketId: number,
  content: string,
  userId?: number,
): Promise<number> {
  return withRetry(
    () =>
      withSession(async (token) => {
        const { data } = await http.post<{ id: number }>(
          "/ITILFollowup",
          {
            input: {
              itemtype: "Ticket",
              items_id: ticketId,
              content,
              is_private: 0,
              // Atribui a autoria à conta da pessoa (em vez do usuário da integração)
              ...(userId ? { users_id: userId } : {}),
            },
          },
          { headers: { "Session-Token": token } },
        );
        logger.info({ ticketId, followupId: data?.id }, "Acompanhamento adicionado ao ticket GLPI");
        return data?.id ?? 0;
      }),
    { label: "glpi.addFollowup" },
  ).finally(() => {
    knowledge.indexTicket(ticketId).catch(() => undefined);
  });
}

/**
 * Soluciona um chamado: registra a solução (ITILSolution) e marca o
 * ticket como SOLVED. Usado quando o Grafana envia status "resolved".
 */
export async function solveTicket(
  ticketId: number,
  solutionNote: string,
  userId?: number,
): Promise<void> {
  await withRetry(
    () =>
      withSession(async (token) => {
        // 1) Registra a solução formal do chamado
        await http.post(
          "/ITILSolution",
          {
            input: {
              itemtype: "Ticket",
              items_id: ticketId,
              content: solutionNote,
              ...(userId ? { users_id: userId } : {}),
            },
          },
          { headers: { "Session-Token": token } },
        );

        // 2) Garante o status SOLVED no ticket
        await http.put(
          `/Ticket/${ticketId}`,
          { input: { id: ticketId, status: GLPI_TICKET_STATUS.SOLVED } },
          { headers: { "Session-Token": token } },
        );

        logger.info({ ticketId }, "Ticket GLPI marcado como solucionado");
      }),
    { label: "glpi.solveTicket" },
  );
  // Reindexa no Qdrant para que o Gerente tenha ciência da solução
  knowledge.indexTicket(ticketId).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Leitura e escrita de sub-itens do ticket (usados pela sincronização Trello)
// ---------------------------------------------------------------------------

/** Estados de uma TicketTask no GLPI. */
export const GLPI_TASK_STATE = { INFO: 0, TODO: 1, DONE: 2 } as const;

/** Tipo de vínculo usuário-ticket: 2 = técnico atribuído. */
const TICKET_USER_TYPE_ASSIGNED = 2;

export interface GlpiFollowup {
  id: number;
  content: string;
  users_id: number;
  date: string;
}

export interface GlpiTask {
  id: number;
  content: string;
  state: number;
  users_id: number;
  date: string;
}

export interface GlpiTicketSummary {
  id: number;
  name: string;
  content: string;
  status: number;
  type: number;
  priority?: number;
  urgency?: number;
  date?: string;
  date_creation?: string;
  date_mod?: string;
  solvedate?: string | null;
  closedate?: string | null;
  is_deleted?: number;
}

/** Chamados mais recentes (usado para descobrir chamados criados à mão). */
export async function listRecentTickets(): Promise<GlpiTicketSummary[]> {
  return withSession(async (token) => {
    const { data } = await http.get<GlpiTicketSummary[]>("/Ticket", {
      headers: { "Session-Token": token },
      params: { range: "0-99", sort: "id", order: "DESC" },
    });
    return Array.isArray(data) ? data : [];
  });
}

/** Chamados para painéis operacionais, com janela maior que a busca conversacional. */
export async function listDashboardTickets(): Promise<GlpiTicketSummary[]> {
  return withSession(async (token) => {
    const { data } = await http.get<GlpiTicketSummary[]>("/Ticket", {
      headers: { "Session-Token": token },
      params: { range: "0-999", sort: "id", order: "DESC" },
    });
    return (Array.isArray(data) ? data : []).filter((ticket) => ticket.is_deleted !== 1);
  });
}

/** Chamados para relatórios, paginados para cobrir períodos maiores. */
export async function listReportTickets(limit = 5000): Promise<GlpiTicketSummary[]> {
  return withSession(async (token) => {
    const pageSize = 1000;
    const tickets: GlpiTicketSummary[] = [];
    for (let start = 0; start < limit; start += pageSize) {
      const end = Math.min(start + pageSize - 1, limit - 1);
      const { data } = await http.get<GlpiTicketSummary[]>("/Ticket", {
        headers: { "Session-Token": token },
        params: { range: `${start}-${end}`, sort: "id", order: "DESC" },
      });
      const page = (Array.isArray(data) ? data : []).filter((ticket) => ticket.is_deleted !== 1);
      tickets.push(...page);
      if (page.length < pageSize) break;
    }
    return tickets;
  });
}

/** Dados básicos de um chamado (status, tipo). */
export async function getTicket(ticketId: number): Promise<GlpiTicketSummary | null> {
  return withSession(async (token) => {
    const { data } = await http.get<GlpiTicketSummary>(`/Ticket/${ticketId}`, {
      headers: { "Session-Token": token },
    });
    return data ?? null;
  });
}

const userNameCache = new Map<number, string>();

export interface GlpiUserOption {
  id: number;
  username: string;
  displayName: string;
  active: boolean;
}

/** Lista contas GLPI para seletores administrativos. */
export async function listUsers(): Promise<GlpiUserOption[]> {
  return withSession(async (token) => {
    const { data } = await http.get<Array<{
      id: number;
      name?: string;
      realname?: string;
      firstname?: string;
      is_active?: number;
    }>>("/User", {
      headers: { "Session-Token": token },
      params: { range: "0-999", sort: "name", order: "ASC" },
    });
    return (Array.isArray(data) ? data : [])
      .filter((user): user is typeof user & { name: string } => Boolean(user.name))
      .map((user) => {
        const displayName = [user.firstname, user.realname].filter(Boolean).join(" ").trim();
        return {
          id: user.id,
          username: user.name,
          displayName: displayName || user.name,
          active: user.is_active !== 0,
        };
      });
  });
}

/** Localiza uma conta GLPI pelo username (campo `name`). */
export async function findUserByUsername(
  username: string,
): Promise<{ id: number; username: string; displayName: string; active: boolean } | null> {
  const wanted = username.trim().toLowerCase();
  if (!wanted) return null;
  return (await listUsers()).find((item) => item.username.trim().toLowerCase() === wanted) ?? null;
}

/** Resolve o nome completo de um usuário do GLPI (com cache em memória). */
export async function getUserName(userId: number): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  const name = await withSession(async (token) => {
    const { data } = await http.get<{
      name?: string;
      realname?: string;
      firstname?: string;
    }>(`/User/${userId}`, { headers: { "Session-Token": token } });
    const fullName = [data.firstname, data.realname].filter(Boolean).join(" ").trim();
    return fullName || data.name || `usuário #${userId}`;
  });

  userNameCache.set(userId, name);
  return name;
}

/** Nomes dos técnicos atualmente atribuídos a um ticket. */
export interface GlpiAssignedTech {
  id: number;
  name: string;
}

export async function getAssignedTechs(ticketId: number): Promise<GlpiAssignedTech[]> {
  const links = await withSession(async (token) => {
    const { data } = await http.get<Array<{ id: number; users_id: number; type: number }>>(
      `/Ticket/${ticketId}/Ticket_User`,
      { headers: { "Session-Token": token }, params: { range: "0-99" } },
    );
    return Array.isArray(data) ? data : [];
  });

  const assigned = links.filter((l) => l.type === TICKET_USER_TYPE_ASSIGNED);
  return Promise.all(
    assigned.map(async (link) => ({
      id: link.users_id,
      name: await getUserName(link.users_id),
    })),
  );
}

/** Nomes dos técnicos atualmente atribuídos a um ticket. */
export async function getAssignedTechNames(ticketId: number): Promise<string[]> {
  return (await getAssignedTechs(ticketId)).map((tech) => tech.name);
}

/** Remove todos os técnicos atribuídos de um ticket. */
export async function unassignAllTechs(ticketId: number): Promise<void> {
  await withRetry(
    () =>
      withSession(async (token) => {
        const { data } = await http.get<Array<{ id: number; users_id: number; type: number }>>(
          `/Ticket/${ticketId}/Ticket_User`,
          { headers: { "Session-Token": token }, params: { range: "0-99" } },
        );
        const links = (Array.isArray(data) ? data : []).filter(
          (l) => l.type === TICKET_USER_TYPE_ASSIGNED,
        );
        for (const link of links) {
          await http.delete(`/Ticket_User/${link.id}`, {
            headers: { "Session-Token": token },
          });
        }
        logger.info({ ticketId, removed: links.length }, "Técnicos desatribuídos do ticket GLPI");
      }),
    { label: "glpi.unassignAllTechs" },
  );
}

/** Atualiza apenas o status de um ticket. */
export async function updateTicketStatus(ticketId: number, status: number): Promise<void> {
  await withRetry(
    () =>
      withSession(async (token) => {
        await http.put(
          `/Ticket/${ticketId}`,
          { input: { id: ticketId, status } },
          { headers: { "Session-Token": token } },
        );
        logger.info({ ticketId, status }, "Status do ticket GLPI atualizado");
      }),
    { label: "glpi.updateTicketStatus" },
  ).finally(() => {
    knowledge.indexTicket(ticketId).catch(() => undefined);
  });
}

/** Followups (acompanhamentos) de um ticket. */
export async function getFollowups(ticketId: number): Promise<GlpiFollowup[]> {
  return withSession(async (token) => {
    const { data } = await http.get<GlpiFollowup[]>(`/Ticket/${ticketId}/ITILFollowup`, {
      headers: { "Session-Token": token },
      params: { range: "0-199" },
    });
    return Array.isArray(data) ? data : [];
  });
}

/** Tarefas (TicketTask) de um ticket. */
export async function getTasks(ticketId: number): Promise<GlpiTask[]> {
  return withSession(async (token) => {
    const { data } = await http.get<GlpiTask[]>(`/Ticket/${ticketId}/TicketTask`, {
      headers: { "Session-Token": token },
      params: { range: "0-199" },
    });
    return Array.isArray(data) ? data : [];
  });
}

/** Cria uma tarefa no ticket e retorna o id. */
export async function addTask(
  ticketId: number,
  content: string,
  state: number = GLPI_TASK_STATE.TODO,
  userId?: number,
): Promise<number> {
  return withRetry(
    () =>
      withSession(async (token) => {
        const { data } = await http.post<{ id: number }>(
          "/TicketTask",
          {
            input: {
              tickets_id: ticketId,
              content,
              state,
              // Atribui a tarefa ao técnico da conversa, quando houver
              ...(userId ? { users_id_tech: userId } : {}),
            },
          },
          { headers: { "Session-Token": token } },
        );
        if (!data?.id) {
          throw new Error(`GLPI não retornou id da tarefa criada: ${JSON.stringify(data)}`);
        }
        logger.info({ ticketId, taskId: data.id }, "Tarefa criada no ticket GLPI");
        return data.id;
      }),
    { label: "glpi.addTask" },
  );
}

/** Atualiza o estado de uma tarefa (TODO <-> DONE). */
export async function updateTaskState(taskId: number, state: number): Promise<void> {
  await withRetry(
    () =>
      withSession(async (token) => {
        await http.put(
          `/TicketTask/${taskId}`,
          { input: { id: taskId, state } },
          { headers: { "Session-Token": token } },
        );
        logger.info({ taskId, state }, "Estado da tarefa GLPI atualizado");
      }),
    { label: "glpi.updateTaskState" },
  );
}

/** Finaliza uma tarefa registrando conclusão e tempo real em segundos. */
export async function completeTask(taskId: number, content: string, actiontime: number): Promise<void> {
  await withRetry(
    () =>
      withSession(async (token) => {
        await http.put(
          `/TicketTask/${taskId}`,
          {
            input: {
              id: taskId,
              state: GLPI_TASK_STATE.DONE,
              content,
              actiontime: Math.max(0, Math.round(actiontime)),
            },
          },
          { headers: { "Session-Token": token } },
        );
      }),
    { label: "glpi.completeTask" },
  );
}

/** IDs de usuários atribuídos como técnicos ao chamado. */
export async function getAssignedUserIds(ticketId: number): Promise<number[]> {
  return withSession(async (token) => {
    const { data } = await http.get<Array<{ users_id: number; type: number }>>(
      `/Ticket/${ticketId}/Ticket_User`,
      { headers: { "Session-Token": token }, params: { range: "0-99" } },
    );
    return (Array.isArray(data) ? data : [])
      .filter((link) => link.type === TICKET_USER_TYPE_ASSIGNED)
      .map((link) => link.users_id);
  });
}

/** Atribui um usuário como técnico do chamado. */
export async function assignUser(ticketId: number, userId: number): Promise<void> {
  await withRetry(
    () =>
      withSession(async (token) => {
        await http.post(
          "/Ticket_User",
          { input: { tickets_id: ticketId, users_id: userId, type: TICKET_USER_TYPE_ASSIGNED } },
          { headers: { "Session-Token": token } },
        );
      }),
    { label: "glpi.assignUser" },
  );
}

/**
 * Detecta o perfil padrão para contas de agentes quando GLPI_AGENT_PROFILE_ID
 * não está configurado: procura um perfil "Technician/Técnico" no GLPI.
 */
export async function findDefaultAgentProfileId(): Promise<number | null> {
  return withSession(async (token) => {
    const { data } = await http.get<Array<{ id: number; name: string }>>("/Profile", {
      headers: { "Session-Token": token },
      params: { range: "0-50" },
    });
    const profiles = Array.isArray(data) ? data : [];
    const technician = profiles.find((p) => /t[eé]cnic|technician/i.test(p.name ?? ""));
    if (technician) {
      logger.info({ profileId: technician.id, name: technician.name }, "Perfil de agente autodetectado no GLPI");
      return technician.id;
    }
    return null;
  });
}

/** Cria a conta técnica de um agente e associa um perfil GLPI. */
export async function createAgentUser(input: {
  username: string;
  fullName: string;
  password: string;
  profileId: number;
}): Promise<number> {
  return withRetry(
    () =>
      withSession(async (token) => {
        const { data } = await http.post<{ id: number }>(
          "/User",
          {
            input: {
              name: input.username,
              realname: input.fullName,
              password: input.password,
              password2: input.password,
              is_active: 1,
            },
          },
          { headers: { "Session-Token": token } },
        );
        if (!data?.id) throw new Error("GLPI não retornou o ID do usuário criado");
        await http.post(
          "/Profile_User",
          {
            input: {
              users_id: data.id,
              profiles_id: input.profileId,
              entities_id: 0,
              is_recursive: 1,
            },
          },
          { headers: { "Session-Token": token } },
        );
        return data.id;
      }),
    { label: "glpi.createAgentUser" },
  );
}

/** Contexto completo usado pelo agente antes de atuar. */
export async function getTicketContext(ticketId: number): Promise<string> {
  const [ticket, followups, tasks, techs] = await Promise.all([
    getTicket(ticketId),
    getFollowups(ticketId),
    getTasks(ticketId),
    getAssignedTechNames(ticketId),
  ]);
  return JSON.stringify({ ticket, assignedTechnicians: techs, followups, tasks }, null, 2);
}

// ---------------------------------------------------------------------------
// Documentos (anexos) — usados pela sincronização de anexos com o Trello
// ---------------------------------------------------------------------------

export interface GlpiDocument {
  id: number;
  filename: string;
  mime: string;
}

/** Lista os documentos (anexos) vinculados a um ticket. */
export async function getDocuments(ticketId: number): Promise<GlpiDocument[]> {
  return withSession(async (token) => {
    const { data } = await http.get<Array<{ documents_id?: number }>>(
      `/Ticket/${ticketId}/Document_Item`,
      { headers: { "Session-Token": token }, params: { range: "0-99" } },
    );
    const links = Array.isArray(data) ? data : [];
    const docs: GlpiDocument[] = [];
    for (const link of links) {
      if (!link.documents_id) continue;
      try {
        const { data: doc } = await http.get<{ id: number; filename?: string; mime?: string; name?: string }>(
          `/Document/${link.documents_id}`,
          { headers: { "Session-Token": token } },
        );
        docs.push({
          id: doc.id,
          filename: doc.filename || doc.name || `documento-${doc.id}`,
          mime: doc.mime || "application/octet-stream",
        });
      } catch {
        // documento inacessível — ignora
      }
    }
    return docs;
  });
}

/** Baixa o conteúdo binário de um documento do GLPI. */
export async function downloadDocument(documentId: number): Promise<Buffer> {
  return withSession(async (token) => {
    const { data } = await http.get<ArrayBuffer>(`/Document/${documentId}`, {
      headers: { "Session-Token": token, Accept: "application/octet-stream" },
      responseType: "arraybuffer",
    });
    return Buffer.from(data);
  });
}

/**
 * Cria um documento no GLPI a partir de um buffer e o vincula ao ticket.
 * Usa multipart (uploadManifest + arquivo), conforme a API REST do GLPI.
 */
export async function uploadDocument(
  ticketId: number,
  filename: string,
  mime: string,
  buffer: Buffer,
  userId?: number,
): Promise<number> {
  if (!buffer || buffer.length === 0) {
    throw new Error(`Arquivo "${filename}" está vazio — nada para anexar.`);
  }
  return withRetry(
    () =>
      withSession(async (token) => {
        const form = new FormData();
        const manifest = JSON.stringify({
          input: { name: filename, _filename: [filename], ...(userId ? { users_id: userId } : {}) },
        });
        form.append("uploadManifest", manifest, { contentType: "application/json" });
        form.append("filename[0]", buffer, { filename, contentType: mime });

        const { data } = await axios.post<
          { id?: number; upload_result?: unknown } | Array<{ id?: number }>
        >(`${env.GLPI_API_URL}/Document`, form, {
          headers: { ...form.getHeaders(), "App-Token": env.GLPI_APP_TOKEN, "Session-Token": token },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 60_000,
        });
        const docId = Array.isArray(data) ? data[0]?.id : data?.id;
        if (!docId) throw new Error(`GLPI não retornou id do documento: ${JSON.stringify(data)}`);

        // Garante que o arquivo foi realmente armazenado (filename preenchido).
        const { data: doc } = await http.get<{ filename?: string | null }>(`/Document/${docId}`, {
          headers: { "Session-Token": token },
        });
        if (!doc?.filename) {
          throw new Error(
            `GLPI criou o documento #${docId} mas não armazenou o arquivo (formato/multipart inválido).`,
          );
        }

        // Vincula o documento ao ticket
        await http.post(
          "/Document_Item",
          { input: { documents_id: docId, itemtype: "Ticket", items_id: ticketId } },
          { headers: { "Session-Token": token } },
        );
        logger.info({ ticketId, docId, filename }, "Documento enviado ao ticket GLPI");
        return docId;
      }),
    { label: "glpi.uploadDocument" },
  );
}

/** Encerra a sessão no GLPI (graceful shutdown). Nunca lança erro. */
export async function killSession(): Promise<void> {
  if (!sessionToken) return;
  try {
    await http.get("/killSession", {
      headers: { "Session-Token": sessionToken },
    });
  } catch (error) {
    logger.warn({ err: errorSummary(error) }, "Falha ao encerrar sessão GLPI (ignorada)");
  } finally {
    sessionToken = null;
  }
}
