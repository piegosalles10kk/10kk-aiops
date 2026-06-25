import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import * as audit from "./audit.service.js";
import { glpiRequest } from "./glpi.service.js";

/**
 * Entidades do GLPI a partir da topologia de projetos: uma entidade pai por
 * projeto raiz e entidades filhas por componente confirmado. Idempotente:
 * não duplica entidade com mesmo nome sob o mesmo pai.
 */

export interface GlpiEntity {
  id: number;
  name: string;
  entities_id: number;
  completename?: string;
}

/** Entidade raiz padrão do GLPI (configurável futuramente via setting). */
const ROOT_ENTITY_ID = 0;

export async function listEntities(): Promise<GlpiEntity[]> {
  const data = await glpiRequest<GlpiEntity[]>("get", "/Entity", {
    params: { range: "0-999", expand_dropdowns: false },
  });
  return Array.isArray(data) ? data : [];
}

export async function findEntityByName(name: string, parentId = ROOT_ENTITY_ID): Promise<GlpiEntity | null> {
  const entities = await listEntities();
  const target = name.trim().toLowerCase();
  return entities.find((e) =>
    e.name?.trim().toLowerCase() === target && Number(e.entities_id) === Number(parentId),
  ) ?? null;
}

export async function createEntity(input: { name: string; parentId?: number; comment?: string }): Promise<number> {
  const res = await glpiRequest<{ id: number } | Array<{ id: number }>>("post", "/Entity", {
    data: { input: { name: input.name, entities_id: input.parentId ?? ROOT_ENTITY_ID, comment: input.comment ?? "" } },
  });
  const id = Array.isArray(res) ? res[0]?.id : res?.id;
  if (!id) throw new Error("GLPI não retornou id ao criar entidade");
  return id;
}

export async function updateEntity(id: number, patch: { name?: string; comment?: string }): Promise<void> {
  await glpiRequest("put", `/Entity/${id}`, { data: { input: { id, ...patch } } });
}

/** Garante a entidade pai do projeto. Reusa glpiEntityId salvo se houver. */
export async function ensureProjectEntity(projectId: string, actor?: string): Promise<number> {
  const project = await prisma.codebaseProject.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Projeto não encontrado");
  if (project.glpiEntityId) return project.glpiEntityId;

  const name = project.name.trim();
  const existing = await findEntityByName(name, ROOT_ENTITY_ID);
  const entityId = existing?.id ?? await createEntity({ name, comment: `Projeto AIOps: ${project.name}` });

  await prisma.codebaseProject.update({ where: { id: projectId }, data: { glpiEntityId: entityId } });
  await audit.record(actor ?? "system", "project.glpi_entity.sync", "CodebaseProject", projectId,
    { entityId, created: !existing });
  return entityId;
}

/**
 * Garante a entidade filha de um componente sob a entidade pai correta.
 * Se o componente já tem `glpiEntityId` mas a entidade está sob um pai
 * diferente (ex.: foi criada plana antes do suporte a pastas), move a
 * entidade para o pai correto via atualização do `entities_id` no GLPI.
 */
export async function ensureComponentEntity(
  componentId: string,
  parentEntityId: number,
  actor?: string,
): Promise<number> {
  const component = await prisma.projectComponent.findUnique({ where: { id: componentId } });
  if (!component) throw new Error("Componente não encontrado");

  const name = component.name.trim();

  // Se já tem entidade salva, verifica se está sob o pai correto
  if (component.glpiEntityId) {
    try {
      const existing = await glpiRequest<GlpiEntity>("get", `/Entity/${component.glpiEntityId}`);
      if (Number(existing.entities_id) === Number(parentEntityId)) {
        return component.glpiEntityId; // Já está sob o pai correto
      }
      // Reparent: move a entidade para o pai correto
      await glpiRequest("put", `/Entity/${component.glpiEntityId}`, {
        data: { input: { id: component.glpiEntityId, entities_id: parentEntityId } },
      });
      await audit.record(actor ?? "system", "project.glpi_entity.reparent", "ProjectComponent", componentId,
        { entityId: component.glpiEntityId, oldParent: existing.entities_id, newParent: parentEntityId });
      return component.glpiEntityId;
    } catch {
      // Entidade foi removida do GLPI; recria abaixo
    }
  }

  // Busca entidade existente com mesmo nome sob o pai correto
  const existing = await findEntityByName(name, parentEntityId);
  const entityId = existing?.id
    ?? await createEntity({ name, parentId: parentEntityId, comment: `Componente: ${component.relativePath}` });

  if (component.glpiEntityId !== entityId) {
    await prisma.projectComponent.update({ where: { id: componentId }, data: { glpiEntityId: entityId } });
  }
  await audit.record(actor ?? "system", "project.glpi_entity.sync", "ProjectComponent", componentId,
    { entityId, parentEntityId, created: !existing });
  return entityId;
}

/**
 * Sincroniza a hierarquia GLPI inteira de um projeto: entidade pai +
 * entidades filhas para cada componente confirmado e habilitado.
 *
 * A hierarquia GLPI reflete a estrutura de pastas dos componentes:
 * um componente com relativePath "OmniPay/api" cria a entidade
 * "OmniPay" (intermediária) e "api" como filha dela.
 */
export async function syncProjectEntities(projectId: string, actor?: string): Promise<{ projectEntityId: number; components: number }> {
  const projectEntityId = await ensureProjectEntity(projectId, actor);
  const components = await prisma.projectComponent.findMany({
    where: { projectId, status: "CONFIRMED", enabled: true },
    orderBy: { relativePath: "asc" },
  });

  // Mapeia caminho de pasta → ID da entidade GLPI (pastas + componentes)
  const entityByPath = new Map<string, number>();

  let synced = 0;
  for (const component of components) {
    const parts = component.relativePath.replace(/\\/g, "/").split("/");

    // Cria entidades de pastas intermediárias (todos os segmentos
    // antes do último, que é o nome do componente)
    for (let i = 0; i < parts.length - 1; i++) {
      const folderPath = parts.slice(0, i + 1).join("/");
      if (entityByPath.has(folderPath)) continue;

      const folderName = parts[i]!;
      const parentId = i === 0
        ? projectEntityId
        : entityByPath.get(parts.slice(0, i).join("/"))!;

      const existing = await findEntityByName(folderName, parentId);
      const folderEntityId = existing?.id
        ?? await createEntity({ name: folderName, parentId, comment: `Pasta: ${folderPath}` });

      entityByPath.set(folderPath, folderEntityId);
    }

    // O pai correto do componente é a entidade da pasta anterior
    // (ou o projeto, se o componente estiver na raiz)
    const correctParentEntityId = parts.length > 1
      ? entityByPath.get(parts.slice(0, -1).join("/"))!
      : projectEntityId;

    try {
      await ensureComponentEntity(component.id, correctParentEntityId, actor);
      synced++;
    } catch (error) {
      logger.warn({ error, componentId: component.id }, "Falha ao criar entidade GLPI do componente");
    }
  }

  logger.info({ projectId, projectEntityId, synced }, "Entidades GLPI sincronizadas");
  return { projectEntityId, components: synced };
}

/**
 * Resolve a entidade GLPI alvo para um chamado, dado o escopo:
 * componente > projeto > entidade padrão (root).
 */
export async function resolveTicketEntity(scope: { projectId?: string | null; componentId?: string | null }): Promise<number> {
  if (scope.componentId) {
    const c = await prisma.projectComponent.findUnique({ where: { id: scope.componentId }, select: { glpiEntityId: true } });
    if (c?.glpiEntityId) return c.glpiEntityId;
  }
  if (scope.projectId) {
    const p = await prisma.codebaseProject.findUnique({ where: { id: scope.projectId }, select: { glpiEntityId: true } });
    if (p?.glpiEntityId) return p.glpiEntityId;
  }
  return ROOT_ENTITY_ID;
}

/**
 * Resolve a entidade GLPI para um alerta automático (Grafana/Loki/Prometheus/Wazuh)
 * via fuzzy matching dos labels do alerta contra projetos e componentes cadastrados.
 *
 * Prioridade de labels: service_name > job > namespace > alertname > instance.
 * Prioridade de match: componente (mais específico) > projeto.
 * Retorna undefined (não passa entities_id) quando não há match confiante.
 */
export async function resolveAlertEntity(
  labels: Record<string, string>,
): Promise<number | undefined> {
  const candidates = [
    labels.service_name,
    labels.job,
    labels.namespace,
    labels.alertname,
    labels.instance,
  ].filter((v): v is string => Boolean(v));

  if (candidates.length === 0) return undefined;

  const [projects, components] = await Promise.all([
    prisma.codebaseProject.findMany({ select: { name: true, glpiEntityId: true } }),
    prisma.projectComponent.findMany({
      where: { status: { in: ["CONFIRMED", "DETECTED"] }, enabled: true },
      select: { name: true, relativePath: true, glpiEntityId: true },
    }),
  ]);

  function norm(s: string): string {
    return s.toLowerCase().replace(/[-_./\s]+/g, " ").trim();
  }

  function matchScore(candidate: string, target: string): number {
    const c = norm(candidate);
    const t = norm(target);
    if (c === t) return 100;
    if (c.includes(t) || t.includes(c)) return 70;
    // sobreposição de tokens
    const cTokens = new Set(c.split(" "));
    const tTokens = t.split(" ");
    const overlap = tTokens.filter((tok) => tok.length > 2 && cTokens.has(tok)).length;
    if (overlap > 0) return 40 + overlap * 10;
    return 0;
  }

  let bestScore = 0;
  let bestEntityId: number | undefined;

  for (const candidate of candidates) {
    // Componentes têm prioridade (mais específicos que o projeto)
    for (const comp of components) {
      if (!comp.glpiEntityId) continue;
      const s = Math.max(matchScore(candidate, comp.name), matchScore(candidate, comp.relativePath));
      if (s > bestScore) { bestScore = s; bestEntityId = comp.glpiEntityId; }
    }
    for (const proj of projects) {
      if (!proj.glpiEntityId) continue;
      const s = matchScore(candidate, proj.name);
      if (s > bestScore) { bestScore = s; bestEntityId = proj.glpiEntityId; }
    }
  }

  // Só usa a entidade se tiver confiança mínima (evita matches espúrios)
  if (bestScore >= 40 && bestEntityId !== undefined) {
    logger.info({ candidates, bestScore, bestEntityId }, "Entidade GLPI resolvida por labels do alerta");
    return bestEntityId;
  }
  return undefined;
}
