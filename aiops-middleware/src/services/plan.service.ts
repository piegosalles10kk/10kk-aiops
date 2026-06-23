import type { TicketPlan } from "@prisma/client";
import { TicketPlanStatus } from "@prisma/client";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import * as audit from "./audit.service.js";
import * as glpi from "./glpi.service.js";

/**
 * Plano de chamados ("lote de requisições") elaborado pelo Gerente.
 *
 * Ciclo de vida:
 *  1. O Gerente conversa com o usuário e chama proposePlan -> DRAFT
 *     (uma nova proposta substitui o rascunho anterior do canal).
 *  2. O usuário revisa; o Gerente re-propõe quantas vezes precisar.
 *  3. Só após confirmação explícita o confirmDraft grava os chamados
 *     no GLPI (tipo Requisição), na ordem sugerida, resolvendo
 *     dependências para os números reais dos chamados criados.
 *  4. Os cards do Trello surgem sozinhos pela descoberta do sync.
 */

export const planItemSchema = z.object({
  ordem: z.coerce.number().int().min(1),
  titulo: z.string().min(3),
  descricao: z.string().min(3),
  criteriosAceite: z.array(z.string()).default([]),
  prioridade: z.enum(["baixa", "media", "alta", "critica"]).default("media"),
  /** Ordens (1-based) dos itens dos quais este depende. */
  dependeDe: z.array(z.coerce.number().int().min(1)).default([]),
  responsavel: z.string().optional(),
});

export const planItemsSchema = z.array(planItemSchema).min(1).max(30);

export type PlanItem = z.infer<typeof planItemSchema>;

const URGENCY_BY_PRIORITY: Record<PlanItem["prioridade"], number> = {
  baixa: 2,
  media: 3,
  alta: 4,
  critica: 5,
};

function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Cria/substitui o rascunho do canal. */
export async function proposePlan(
  channel: string,
  goal: string,
  rawItems: unknown,
): Promise<TicketPlan> {
  const items = planItemsSchema.parse(rawItems);

  // Valida dependências: só podem apontar para ordens existentes no plano
  const orders = new Set(items.map((i) => i.ordem));
  for (const item of items) {
    for (const dep of item.dependeDe) {
      if (!orders.has(dep)) {
        throw new Error(`Item ${item.ordem} depende da ordem ${dep}, que não existe no plano`);
      }
      if (dep === item.ordem) {
        throw new Error(`Item ${item.ordem} não pode depender de si mesmo`);
      }
    }
  }

  // Um rascunho por canal: descarta o anterior
  await prisma.ticketPlan.updateMany({
    where: { channel, status: TicketPlanStatus.DRAFT },
    data: { status: TicketPlanStatus.CANCELLED },
  });

  const plan = await prisma.ticketPlan.create({
    data: { channel, goal, items },
  });
  logger.info({ planId: plan.id, channel, itemCount: items.length }, "Plano de chamados proposto (DRAFT)");
  return plan;
}

export function getDraft(channel: string): Promise<TicketPlan | null> {
  return prisma.ticketPlan.findFirst({
    where: { channel, status: TicketPlanStatus.DRAFT },
    orderBy: { createdAt: "desc" },
  });
}

export async function cancelDraft(channel: string): Promise<boolean> {
  const result = await prisma.ticketPlan.updateMany({
    where: { channel, status: TicketPlanStatus.DRAFT },
    data: { status: TicketPlanStatus.CANCELLED },
  });
  return result.count > 0;
}

function buildTicketContent(
  goal: string,
  item: PlanItem,
  dependencyTickets: Array<{ ordem: number; ticketId: number; titulo: string }>,
): string {
  const parts = [
    `<p><em>Chamado criado pelo Gerente AIOps como parte do plano: <b>${goal}</b> (item ${item.ordem}).</em></p>`,
    `<p>${item.descricao}</p>`,
  ];

  if (item.criteriosAceite.length > 0) {
    parts.push(
      "<p><b>Critérios de aceite:</b></p>",
      `<ul>${item.criteriosAceite.map((c) => `<li>${c}</li>`).join("")}</ul>`,
    );
  }

  if (dependencyTickets.length > 0) {
    parts.push(
      "<p><b>Depende de:</b></p>",
      `<ul>${dependencyTickets
        .map((d) => `<li>Chamado #${d.ticketId} — ${d.titulo} (item ${d.ordem})</li>`)
        .join("")}</ul>`,
    );
  }

  if (item.responsavel) {
    parts.push(`<p><b>Responsável sugerido:</b> ${item.responsavel}</p>`);
  }

  return parts.join("\n");
}

export interface CreatedPlanTicket {
  ordem: number;
  ticketId: number;
  titulo: string;
  responsavelAtribuido?: string;
}

/**
 * Confirma o rascunho do canal: cria os chamados no GLPI (tipo Requisição)
 * na ordem sugerida. Se o responsável corresponder a um agente cadastrado
 * com conta GLPI, o chamado já sai atribuído a ele.
 */
export async function confirmDraft(channel: string): Promise<{
  plan: TicketPlan;
  created: CreatedPlanTicket[];
}> {
  const plan = await getDraft(channel);
  if (!plan) {
    throw new Error("Não há plano em rascunho neste canal para confirmar");
  }

  const items = planItemsSchema.parse(plan.items).sort((a, b) => a.ordem - b.ordem);
  const agents = await prisma.agent.findMany({ where: { enabled: true, glpiUserId: { not: null } } });

  // Retomada: se uma confirmação anterior falhou no meio, os chamados já
  // criados ficaram registrados em createdTicketIds — não duplicamos.
  const previous = Array.isArray(plan.createdTicketIds)
    ? (plan.createdTicketIds as unknown as CreatedPlanTicket[])
    : [];
  const created: CreatedPlanTicket[] = [...previous];
  const byOrder = new Map<number, CreatedPlanTicket>(previous.map((c) => [c.ordem, c]));

  for (const item of items) {
    if (byOrder.has(item.ordem)) continue; // já criado em tentativa anterior
    const dependencyTickets = item.dependeDe
      .map((dep) => byOrder.get(dep))
      .filter((d): d is CreatedPlanTicket => Boolean(d))
      .map((d) => ({ ordem: d.ordem, ticketId: d.ticketId, titulo: d.titulo }));

    const ticketId = await glpi.createRawTicket({
      title: item.titulo,
      content: buildTicketContent(plan.goal, item, dependencyTickets),
      urgency: URGENCY_BY_PRIORITY[item.prioridade],
      type: glpi.GLPI_TICKET_TYPE.REQUEST,
    });

    const entry: CreatedPlanTicket = { ordem: item.ordem, ticketId, titulo: item.titulo };

    // Atribuição automática quando o responsável é um agente com conta GLPI
    if (item.responsavel) {
      const target = normalizeName(item.responsavel);
      const agent = agents.find((a) => {
        const name = normalizeName(a.name);
        return name === target || name.includes(target) || target.includes(name);
      });
      if (agent?.glpiUserId) {
        try {
          await glpi.assignUser(ticketId, agent.glpiUserId);
          entry.responsavelAtribuido = agent.name;
        } catch (error) {
          logger.warn({ ticketId, agent: agent.name, error }, "Falha ao atribuir agente ao chamado do plano");
        }
      }
    }

    created.push(entry);
    byOrder.set(item.ordem, entry);

    // Persiste o progresso imediatamente: se a próxima criação falhar,
    // a retomada sabe o que já existe no GLPI.
    await prisma.ticketPlan.update({
      where: { id: plan.id },
      data: { createdTicketIds: created.map((c) => ({ ...c })) },
    });
  }

  const confirmed = await prisma.ticketPlan.update({
    where: { id: plan.id },
    data: {
      status: TicketPlanStatus.CONFIRMED,
      createdTicketIds: created.map((c) => ({ ...c })),
    },
  });

  await audit.record("manager", "plan.confirm", "TicketPlan", plan.id, {
    goal: plan.goal,
    tickets: created.map((c) => ({ ...c })),
  });
  logger.info({ planId: plan.id, tickets: created.map((c) => c.ticketId) }, "Plano confirmado — chamados criados no GLPI");

  return { plan: confirmed, created };
}

export function listPlans(limit = 50): Promise<TicketPlan[]> {
  return prisma.ticketPlan.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}
