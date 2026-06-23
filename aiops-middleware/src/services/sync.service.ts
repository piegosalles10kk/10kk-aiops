import type { Incident, SyncItem } from "@prisma/client";
import { SyncKind } from "@prisma/client";
import { env, isTrelloEnabled } from "../config/env.js";
import { logger } from "../lib/logger.js";
import * as incidentRepo from "../repositories/incident.repository.js";
import * as syncRepo from "../repositories/sync.repository.js";
import { errorSummary } from "../utils/retry.js";
import * as glpi from "./glpi.service.js";
import * as trello from "./trello.service.js";

/**
 * Motor de sincronização bidirecional GLPI <-> Trello (polling).
 *
 * A cada ciclo, para cada incidente OPEN com ticket + card:
 *  1. Atribuição: técnico atribuído no GLPI -> card vai para a lista
 *     "em andamento" e o membro do board com nome correspondente é
 *     adicionado ao card.
 *  2. Followups do GLPI -> comentários no Trello (e vice-versa).
 *  3. Tarefas do GLPI -> itens da checklist "Tarefas (GLPI)" no Trello
 *     (e vice-versa), incluindo o estado feito/pendente.
 *
 * A tabela sync_items guarda o par (glpiId, trelloId) de cada item já
 * propagado: é isso que impede eco infinito entre os dois sistemas.
 */

const CHECKLIST_NAME = "Tarefas (GLPI)";
const TASK_STATE_DONE = "done";
const TASK_STATE_OPEN = "open";

/** Remove tags HTML do conteúdo do GLPI para exibição no Trello. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

/**
 * Registra a mesma nota nos dois lados (comentário no Trello + followup no
 * GLPI) e mapeia o par imediatamente, para o ciclo de comentários não ecoar.
 */
async function createPairedNote(
  incidentId: string,
  ticketId: number,
  cardId: string,
  trelloText: string,
  glpiHtml: string,
): Promise<void> {
  const commentId = await trello.addComment(cardId, trelloText);
  if (!commentId) return;
  const followupId = await glpi.addFollowup(ticketId, glpiHtml);
  if (followupId) {
    await syncRepo.create({
      incidentId,
      kind: SyncKind.FOLLOWUP,
      glpiId: followupId,
      trelloId: commentId,
    });
  }
}

/** Cria a nota de vínculo nos dois lados, já mapeada para não ecoar. */
async function createLinkNote(
  incidentId: string,
  ticketId: number,
  cardId: string,
  cardName: string,
): Promise<void> {
  await createPairedNote(
    incidentId,
    ticketId,
    cardId,
    `🎫 Vinculado ao chamado GLPI **#${ticketId}**.`,
    `🔗 Vinculado ao card do Trello: <b>${cardName}</b>.`,
  );
}

/**
 * Descobre cards criados manualmente no Trello que ainda não têm
 * chamado vinculado e cria o chamado no GLPI.
 *
 * O tipo do chamado vem da lista onde o card está:
 *   lista de incidentes -> Incidente (1) | lista de requisições -> Requisição (2).
 * Para cards em "em andamento", o tipo vem da label do card (default Incidente).
 */
async function discoverManualCards(): Promise<void> {
  const lists: Array<{ listId: string; kind: "incident" | "request" | "byLabel" }> = [];
  if (env.TRELLO_LIST_ID_INCIDENT) lists.push({ listId: env.TRELLO_LIST_ID_INCIDENT, kind: "incident" });
  if (env.TRELLO_LIST_ID_REQUEST) lists.push({ listId: env.TRELLO_LIST_ID_REQUEST, kind: "request" });
  if (env.TRELLO_LIST_ID_IN_PROGRESS) lists.push({ listId: env.TRELLO_LIST_ID_IN_PROGRESS, kind: "byLabel" });

  const typeLabels = await trello.ensureTypeLabels();

  for (const { listId, kind } of lists) {
    const cards = await trello.getListCards(listId);
    for (const card of cards) {
      const existing = await incidentRepo.findByTrelloCardId(card.id);
      if (existing) continue;

      const isRequest = kind === "request" || (kind === "byLabel" && trello.cardIsRequest(card));

      logger.info(
        { cardId: card.id, cardName: card.name, tipo: isRequest ? "Requisição" : "Incidente" },
        "Card manual detectado no Trello — criando chamado no GLPI",
      );

      try {
        const ticketId = await glpi.createRawTicket({
          title: `[Trello] ${card.name}`,
          content: [
            "<p><em>Chamado criado automaticamente a partir de um card do Trello.</em></p>",
            `<p>${card.desc?.trim() || "(card sem descrição)"}</p>`,
          ].join("\n"),
          type: isRequest ? glpi.GLPI_TICKET_TYPE.REQUEST : glpi.GLPI_TICKET_TYPE.INCIDENT,
        });

        const incident = await incidentRepo.createFromTrelloCard({
          trelloCardId: card.id,
          glpiTicketId: ticketId,
        });

        // Espelha o tipo como label no card (sobrevive à mudança de lista)
        if (typeLabels) {
          await trello.addLabelToCard(card.id, isRequest ? typeLabels.request : typeLabels.incident);
        }

        await createLinkNote(incident.id, ticketId, card.id, card.name);
      } catch (error) {
        logger.error(
          { err: errorSummary(error), cardId: card.id },
          "Falha ao criar chamado GLPI para card manual do Trello",
        );
      }
    }
  }
}

/**
 * Descobre chamados criados manualmente no GLPI (sem incidente vinculado)
 * e cria o card correspondente no Trello, na lista do tipo certo.
 */
async function discoverManualGlpiTickets(): Promise<void> {
  const [tickets, knownIds, typeLabels] = await Promise.all([
    glpi.listRecentTickets(),
    incidentRepo.findKnownGlpiTicketIds(),
    trello.ensureTypeLabels(),
  ]);

  for (const ticket of tickets) {
    if (knownIds.has(ticket.id)) continue;
    if (ticket.is_deleted) continue;
    if (ticket.status >= glpi.GLPI_TICKET_STATUS.SOLVED) continue; // só chamados em aberto

    const isRequest = ticket.type === glpi.GLPI_TICKET_TYPE.REQUEST;
    const listId = isRequest
      ? env.TRELLO_LIST_ID_REQUEST ?? env.TRELLO_LIST_ID_INCIDENT
      : env.TRELLO_LIST_ID_INCIDENT;

    logger.info(
      { glpiTicketId: ticket.id, tipo: isRequest ? "Requisição" : "Incidente" },
      "Chamado manual detectado no GLPI — criando card no Trello",
    );

    try {
      const cardId = await trello.createBasicCard({
        title: `🎫 ${ticket.name}`,
        description: `${htmlToText(ticket.content ?? "")}\n\n🎫 Chamado GLPI: #${ticket.id}`,
        listId,
        labelId: typeLabels ? (isRequest ? typeLabels.request : typeLabels.incident) : null,
      });
      if (!cardId) continue;

      const incident = await incidentRepo.createFromGlpiTicket({
        glpiTicketId: ticket.id,
        trelloCardId: cardId,
      });

      await createLinkNote(incident.id, ticket.id, cardId, ticket.name);
    } catch (error) {
      logger.error(
        { err: errorSummary(error), glpiTicketId: ticket.id },
        "Falha ao criar card no Trello para chamado manual do GLPI",
      );
    }
  }
}

/** O card está em uma das listas de backlog (incidentes ou requisições)? */
function isBacklogList(idList: string): boolean {
  return idList === env.TRELLO_LIST_ID_INCIDENT || idList === env.TRELLO_LIST_ID_REQUEST;
}

/**
 * Transições de lista do card (incidentes OPEN):
 *  - card em "concluídos"          -> soluciona o chamado no GLPI;
 *  - card de volta ao backlog com  -> desatribui os técnicos e o chamado
 *    técnico atribuído                volta para o status Novo;
 *  - chamado solucionado no GLPI   -> card vai para "concluídos".
 */
async function syncListTransitions(incident: Incident): Promise<void> {
  const cardId = incident.trelloCardId!;
  const ticketId = incident.glpiTicketId!;

  const card = await trello.getCard(cardId);
  if (!card) return;

  // Trello -> GLPI: card concluído
  if (env.TRELLO_LIST_ID_DONE && card.idList === env.TRELLO_LIST_ID_DONE) {
    logger.info(
      { incidentId: incident.id, glpiTicketId: ticketId },
      "Card movido para concluídos no Trello — solucionando chamado no GLPI",
    );
    await glpi.solveTicket(ticketId, "✅ Resolvido via Trello: card movido para a lista de concluídos.");
    await incidentRepo.markResolved(incident.id);
    return;
  }

  // Trello -> GLPI: card tirado de "em andamento" de volta ao backlog
  if (incident.assignedTechName && isBacklogList(card.idList)) {
    logger.info(
      { incidentId: incident.id, glpiTicketId: ticketId },
      "Card retirado de 'em andamento' — desatribuindo técnicos e voltando chamado para Novo",
    );
    await glpi.unassignAllTechs(ticketId);
    await glpi.updateTicketStatus(ticketId, glpi.GLPI_TICKET_STATUS.NEW);
    await incidentRepo.clearAssignedTech(incident.id);
    await createPairedNote(
      incident.id,
      ticketId,
      cardId,
      "↩️ Card devolvido ao backlog — técnicos desatribuídos e chamado de volta ao status **Novo**.",
      "↩️ Card do Trello devolvido ao backlog — técnicos desatribuídos e chamado de volta ao status <b>Novo</b>.",
    );
    return;
  }

  // GLPI -> Trello: chamado solucionado/fechado
  const ticket = await glpi.getTicket(ticketId);
  if (ticket && ticket.status >= glpi.GLPI_TICKET_STATUS.SOLVED) {
    logger.info(
      { incidentId: incident.id, glpiTicketId: ticketId },
      "Chamado solucionado no GLPI — movendo card para concluídos no Trello",
    );
    await trello.moveCardToDone(cardId);
    await incidentRepo.markResolved(incident.id);
  }
}

/**
 * Detecção de reabertura (incidentes RESOLVED dos últimos 14 dias):
 *  - card retirado de "concluídos" no Trello -> reabre o chamado no GLPI
 *    ("em andamento" -> Em atendimento; backlog -> Novo + desatribuição);
 *  - chamado reaberto no GLPI -> card sai de "concluídos".
 */
async function checkReopen(incident: Incident): Promise<void> {
  const cardId = incident.trelloCardId!;
  const ticketId = incident.glpiTicketId!;

  const card = await trello.getCard(cardId);
  if (!card) return;

  // Trello -> GLPI: card saiu de "concluídos"
  if (env.TRELLO_LIST_ID_DONE && card.idList !== env.TRELLO_LIST_ID_DONE) {
    const toInProgress = card.idList === env.TRELLO_LIST_ID_IN_PROGRESS;
    logger.info(
      { incidentId: incident.id, glpiTicketId: ticketId, destino: toInProgress ? "em andamento" : "backlog" },
      "Card retirado de concluídos no Trello — reabrindo chamado no GLPI",
    );

    if (toInProgress) {
      await glpi.updateTicketStatus(ticketId, glpi.GLPI_TICKET_STATUS.ASSIGNED);
    } else {
      await glpi.unassignAllTechs(ticketId);
      await glpi.updateTicketStatus(ticketId, glpi.GLPI_TICKET_STATUS.NEW);
      await incidentRepo.clearAssignedTech(incident.id);
    }
    await incidentRepo.reopen(incident.id);
    await createPairedNote(
      incident.id,
      ticketId,
      cardId,
      "🔄 Card retirado de concluídos — chamado **reaberto** no GLPI.",
      "🔄 Chamado reaberto: card do Trello retirado da lista de concluídos.",
    );
    return;
  }

  // GLPI -> Trello: chamado reaberto (status voltou para antes de Solucionado)
  const ticket = await glpi.getTicket(ticketId);
  if (ticket && ticket.status < glpi.GLPI_TICKET_STATUS.SOLVED) {
    const hasTech = (await glpi.getAssignedTechNames(ticketId)).length > 0;
    const targetList = hasTech
      ? env.TRELLO_LIST_ID_IN_PROGRESS
      : trello.cardIsRequest(card)
        ? env.TRELLO_LIST_ID_REQUEST ?? env.TRELLO_LIST_ID_INCIDENT
        : env.TRELLO_LIST_ID_INCIDENT;

    logger.info(
      { incidentId: incident.id, glpiTicketId: ticketId },
      "Chamado reaberto no GLPI — retirando card de concluídos no Trello",
    );
    if (targetList) {
      await trello.moveCardToList(cardId, targetList);
    }
    await incidentRepo.reopen(incident.id);
    await createPairedNote(
      incident.id,
      ticketId,
      cardId,
      "🔄 Chamado **reaberto** no GLPI — card retirado de concluídos.",
      "🔄 Chamado reaberto — card do Trello retirado da lista de concluídos.",
    );
  }
}

/** Sincroniza a atribuição de técnico (GLPI -> Trello). */
async function syncAssignment(incident: Incident): Promise<void> {
  const techNames = await glpi.getAssignedTechNames(incident.glpiTicketId!);
  if (techNames.length === 0) return;

  const joined = techNames.join(", ");
  if (joined === incident.assignedTechName) return; // nada mudou

  const cardId = incident.trelloCardId!;
  const isFirstAssignment = !incident.assignedTechName;

  logger.info(
    { incidentId: incident.id, techNames },
    "Técnico atribuído no GLPI — atualizando card no Trello",
  );

  if (isFirstAssignment) {
    await trello.moveCardToInProgress(cardId);
  }

  for (const name of techNames) {
    try {
      const memberId = await trello.findBoardMemberId(cardId, name);
      if (memberId) {
        await trello.addMemberToCard(cardId, memberId);
      } else {
        logger.warn(
          { techName: name, cardId },
          "Nenhum membro do board do Trello corresponde ao técnico do GLPI",
        );
      }
    } catch (error) {
      logger.error({ err: errorSummary(error), techName: name }, "Falha ao atribuir membro no Trello");
    }
  }

  // Registra a nota de atribuição nos dois lados e já mapeia o par,
  // para que o ciclo de comentários não a propague de novo (eco).
  const commentId = await trello.addComment(cardId, `👤 Atribuído no GLPI a: **${joined}**`);
  if (commentId) {
    const followupId = await glpi.addFollowup(
      incident.glpiTicketId!,
      `👤 Técnico atribuído: <b>${joined}</b> — card do Trello movido para "em andamento".`,
    );
    if (followupId) {
      await syncRepo.create({
        incidentId: incident.id,
        kind: SyncKind.FOLLOWUP,
        glpiId: followupId,
        trelloId: commentId,
      });
    }
  }
  await incidentRepo.setAssignedTech(incident.id, joined);
}

/** Followups GLPI -> comentários Trello e comentários Trello -> followups GLPI. */
async function syncComments(incident: Incident, syncItems: SyncItem[]): Promise<void> {
  const ticketId = incident.glpiTicketId!;
  const cardId = incident.trelloCardId!;

  const mapped = syncItems.filter((s) => s.kind === SyncKind.FOLLOWUP);
  const mappedGlpiIds = new Set(mapped.map((s) => s.glpiId));
  const mappedTrelloIds = new Set(mapped.map((s) => s.trelloId));

  const [followups, comments] = await Promise.all([
    glpi.getFollowups(ticketId),
    trello.getComments(cardId),
  ]);

  // GLPI -> Trello
  for (const followup of followups) {
    if (mappedGlpiIds.has(followup.id)) continue;
    const author = await glpi.getUserName(followup.users_id);
    const text = `💬 **${author}** (GLPI, ${followup.date}):\n\n${htmlToText(followup.content)}`;
    const commentId = await trello.addComment(cardId, text);
    if (commentId) {
      await syncRepo.create({
        incidentId: incident.id,
        kind: SyncKind.FOLLOWUP,
        glpiId: followup.id,
        trelloId: commentId,
      });
      mappedTrelloIds.add(commentId);
    }
  }

  // Trello -> GLPI
  for (const comment of comments) {
    if (mappedTrelloIds.has(comment.id)) continue;
    const content = `💬 <b>${comment.author}</b> (Trello):<br><br>${comment.text}`;
    const followupId = await glpi.addFollowup(ticketId, content);
    if (followupId) {
      await syncRepo.create({
        incidentId: incident.id,
        kind: SyncKind.FOLLOWUP,
        glpiId: followupId,
        trelloId: comment.id,
      });
    }
  }
}

/** Tarefas GLPI <-> checklist do Trello (criação e estado feito/pendente). */
async function syncTasks(incident: Incident, syncItems: SyncItem[]): Promise<void> {
  const ticketId = incident.glpiTicketId!;
  const cardId = incident.trelloCardId!;

  const tasks = await glpi.getTasks(ticketId);
  const mapped = syncItems.filter((s) => s.kind === SyncKind.TASK);

  // Só cria a checklist quando há tarefa nova no GLPI a propagar;
  // caso contrário, usa uma existente (criada antes ou manualmente no Trello).
  const hasNewGlpiTask = tasks.some((t) => !mapped.some((m) => m.glpiId === t.id));
  const checklistId = hasNewGlpiTask
    ? await trello.ensureChecklist(cardId, CHECKLIST_NAME)
    : await trello.findChecklist(cardId, CHECKLIST_NAME);
  if (!checklistId) return;

  const checkItems = await trello.getCheckItems(checklistId);
  const byGlpiId = new Map(mapped.map((s) => [s.glpiId, s]));
  const byTrelloId = new Map(mapped.map((s) => [s.trelloId, s]));
  const checkItemById = new Map(checkItems.map((c) => [c.id, c]));

  // GLPI -> Trello: tarefas novas viram itens da checklist
  for (const task of tasks) {
    if (byGlpiId.has(task.id)) continue;
    const done = task.state === glpi.GLPI_TASK_STATE.DONE;
    const itemId = await trello.addCheckItem(checklistId, htmlToText(task.content), done);
    if (itemId) {
      const created = await syncRepo.create({
        incidentId: incident.id,
        kind: SyncKind.TASK,
        glpiId: task.id,
        trelloId: itemId,
        lastState: done ? TASK_STATE_DONE : TASK_STATE_OPEN,
      });
      byGlpiId.set(task.id, created);
      byTrelloId.set(itemId, created);
    }
  }

  // Trello -> GLPI: itens novos da checklist viram tarefas no ticket
  for (const item of checkItems) {
    if (byTrelloId.has(item.id)) continue;
    const done = item.state === "complete";
    const taskId = await glpi.addTask(
      ticketId,
      item.name,
      done ? glpi.GLPI_TASK_STATE.DONE : glpi.GLPI_TASK_STATE.TODO,
    );
    if (taskId) {
      const created = await syncRepo.create({
        incidentId: incident.id,
        kind: SyncKind.TASK,
        glpiId: taskId,
        trelloId: item.id,
        lastState: done ? TASK_STATE_DONE : TASK_STATE_OPEN,
      });
      byGlpiId.set(taskId, created);
    }
  }

  // Estado feito/pendente dos itens já mapeados:
  // compara cada lado com o último estado sincronizado para saber quem mudou.
  for (const task of tasks) {
    const sync = byGlpiId.get(task.id);
    if (!sync) continue;
    const item = checkItemById.get(sync.trelloId);
    if (!item) continue;

    const glpiDone = task.state === glpi.GLPI_TASK_STATE.DONE;
    const trelloDone = item.state === "complete";
    const lastDone = sync.lastState === TASK_STATE_DONE;

    if (glpiDone === trelloDone) {
      if (glpiDone !== lastDone) {
        await syncRepo.updateState(sync.id, glpiDone ? TASK_STATE_DONE : TASK_STATE_OPEN);
      }
      continue;
    }

    if (glpiDone !== lastDone) {
      // Mudou no GLPI -> propaga para o Trello
      await trello.setCheckItemState(cardId, item.id, glpiDone ? "complete" : "incomplete");
      await syncRepo.updateState(sync.id, glpiDone ? TASK_STATE_DONE : TASK_STATE_OPEN);
    } else {
      // Mudou no Trello -> propaga para o GLPI
      await glpi.updateTaskState(
        task.id,
        trelloDone ? glpi.GLPI_TASK_STATE.DONE : glpi.GLPI_TASK_STATE.TODO,
      );
      await syncRepo.updateState(sync.id, trelloDone ? TASK_STATE_DONE : TASK_STATE_OPEN);
    }
  }
}

/**
 * Anexos GLPI (Documents) <-> anexos do Trello (uploads), nos dois sentidos.
 * Só sincroniza arquivos enviados (ignora anexos do Trello que são apenas
 * links/URLs). O par (docId, attachmentId) é persistido para impedir eco.
 */
async function syncAttachments(incident: Incident, syncItems: SyncItem[]): Promise<void> {
  const ticketId = incident.glpiTicketId!;
  const cardId = incident.trelloCardId!;

  const mapped = syncItems.filter((s) => s.kind === SyncKind.ATTACHMENT);
  const mappedGlpiIds = new Set(mapped.map((s) => s.glpiId));
  const mappedTrelloIds = new Set(mapped.map((s) => s.trelloId));

  const [docs, attachments] = await Promise.all([
    glpi.getDocuments(ticketId),
    trello.getAttachments(cardId),
  ]);

  // GLPI -> Trello
  for (const doc of docs) {
    if (mappedGlpiIds.has(doc.id)) continue;
    try {
      const buffer = await glpi.downloadDocument(doc.id);
      const attId = await trello.uploadAttachment(cardId, doc.filename, doc.mime, buffer);
      if (attId) {
        await syncRepo.create({
          incidentId: incident.id,
          kind: SyncKind.ATTACHMENT,
          glpiId: doc.id,
          trelloId: attId,
        });
        mappedTrelloIds.add(attId);
      }
    } catch (error) {
      logger.error({ err: errorSummary(error), docId: doc.id }, "Falha ao enviar documento do GLPI para o Trello");
    }
  }

  // Trello -> GLPI
  for (const att of attachments) {
    if (!att.isUpload) continue; // ignora anexos que são apenas links
    if (mappedTrelloIds.has(att.id)) continue;
    try {
      const buffer = await trello.downloadAttachment(att.url);
      const docId = await glpi.uploadDocument(ticketId, att.name, att.mimeType, buffer);
      await syncRepo.create({
        incidentId: incident.id,
        kind: SyncKind.ATTACHMENT,
        glpiId: docId,
        trelloId: att.id,
      });
    } catch (error) {
      logger.error({ err: errorSummary(error), attId: att.id }, "Falha ao enviar anexo do Trello para o GLPI");
    }
  }
}

/** Sincroniza um incidente; cada etapa falha isoladamente. */
async function syncIncident(incident: Incident): Promise<void> {
  const log = logger.child({ incidentId: incident.id, glpiTicketId: incident.glpiTicketId });

  const steps: Array<[string, (i: Incident, s: SyncItem[]) => Promise<void>]> = [
    ["assignment", (i) => syncAssignment(i)],
    ["comments", syncComments],
    ["tasks", syncTasks],
    ["attachments", syncAttachments],
    ["transitions", (i) => syncListTransitions(i)],
  ];

  for (const [name, step] of steps) {
    try {
      // Recarrega os mapeamentos a cada etapa: uma etapa anterior do mesmo
      // ciclo pode ter criado pares novos (ex.: nota de atribuição).
      const syncItems = await syncRepo.listByIncident(incident.id);
      await step(incident, syncItems);
    } catch (error) {
      log.error({ err: errorSummary(error), step: name }, "Falha em etapa de sincronização");
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Executa um ciclo completo de sincronização (com guarda anti-sobreposição). */
export async function runSyncCycle(): Promise<void> {
  if (running) {
    logger.debug("Ciclo de sync anterior ainda em execução — pulando");
    return;
  }
  running = true;
  try {
    // Descoberta de itens criados à mão (Trello e GLPI), antes do sync por incidente
    try {
      await discoverManualCards();
    } catch (error) {
      logger.error({ err: errorSummary(error) }, "Falha ao descobrir cards manuais do Trello");
    }
    try {
      await discoverManualGlpiTickets();
    } catch (error) {
      logger.error({ err: errorSummary(error) }, "Falha ao descobrir chamados manuais do GLPI");
    }

    const incidents = await incidentRepo.findAllSyncable();
    for (const incident of incidents) {
      await syncIncident(incident);
    }

    // Reabertura: incidentes resolvidos recentemente cujo card saiu de
    // "concluídos" ou cujo chamado foi reaberto no GLPI
    const resolved = await incidentRepo.findRecentResolvedSyncable();
    for (const incident of resolved) {
      try {
        await checkReopen(incident);
      } catch (error) {
        logger.error(
          { err: errorSummary(error), incidentId: incident.id },
          "Falha na detecção de reabertura",
        );
      }
    }

  } catch (error) {
    logger.error({ err: errorSummary(error) }, "Falha no ciclo de sincronização");
  } finally {
    running = false;
  }
}

/** Inicia o loop de sincronização periódico. */
export function startSyncLoop(): void {
  if (!isTrelloEnabled) {
    logger.warn("Sincronização GLPI<->Trello desativada (Trello não configurado)");
    return;
  }
  timer = setInterval(() => void runSyncCycle(), env.SYNC_INTERVAL_MS);
  timer.unref();
  logger.info({ intervalMs: env.SYNC_INTERVAL_MS }, "Loop de sincronização GLPI<->Trello iniciado");
}

export function stopSyncLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
