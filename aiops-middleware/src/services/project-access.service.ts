import { AccessSubjectType, ProjectRole, type ProjectAccessGrant } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import * as audit from "./audit.service.js";

/**
 * Autorização granular por sujeito (canal/usuário GLPI/agente/web) sobre
 * projetos, componentes e ferramentas. Política padrão preserva o uso atual:
 * web local/admin tem acesso amplo; canais sem grant recebem só baixo risco.
 */

export type ToolName =
  | "tickets_list" | "ticket_get" | "ticket_create" | "ticket_comment"
  | "code_projects" | "code_tree" | "code_read" | "code_search"
  | "search_knowledge" | "logs_query" | "metrics_query"
  | "ssh_exec" | "pentest" | "load_test" | "visual_regression_test"
  | "ticket_delegate_agent" | "ticket_assign_agent" | "project_update"
  | "project_topology_scan" | "project_topology_confirm"
  | "access_profile_list" | "access_profile_create" | "access_profile_apply"
  | "access_profile_delete";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

const TOOL_RISK: Record<string, RiskLevel> = {
  tickets_list: "LOW", ticket_get: "LOW", ticket_comment: "LOW",
  code_projects: "LOW", search_knowledge: "LOW",
  code_tree: "MEDIUM", code_read: "MEDIUM", code_search: "MEDIUM",
  logs_query: "MEDIUM", metrics_query: "MEDIUM", visual_regression_test: "MEDIUM",
  ticket_create: "MEDIUM",
  pentest: "HIGH", load_test: "HIGH", project_update: "HIGH",
  ticket_delegate_agent: "HIGH", ticket_assign_agent: "HIGH",
  project_topology_scan: "HIGH", project_topology_confirm: "HIGH",
  access_profile_list: "MEDIUM",
  access_profile_create: "HIGH",
  access_profile_apply: "HIGH",
  access_profile_delete: "HIGH",
  ssh_exec: "CRITICAL",
};

export function riskOf(tool: string): RiskLevel {
  return TOOL_RISK[tool] ?? "MEDIUM";
}

export interface AccessSubject {
  type: AccessSubjectType;
  key: string;
  channel?: string;
  glpiUserId?: number;
}

export interface ToolAccessCheck {
  tool: ToolName | string;
  projectId?: string | null;
  componentId?: string | null;
  environment?: string | null;
}

export interface ToolAccessResult {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
}

/** Deriva o sujeito de acesso a partir do canal (web | slack:X | telegram:X). */
export async function getSubjectFromChannel(channel: string): Promise<AccessSubject> {
  const ch = channel || "web";
  if (ch === "web" || ch.startsWith("web:")) {
    return { type: AccessSubjectType.WEB_USER, key: ch, channel: ch };
  }
  const subject: AccessSubject = { type: AccessSubjectType.CHANNEL, key: ch, channel: ch };
  // Conta GLPI vinculada amplia o alcance (grants por glpi_user)
  const account = await prisma.chatAccount.findUnique({ where: { channel: ch }, select: { glpiUserId: true } });
  if (account?.glpiUserId) subject.glpiUserId = account.glpiUserId;
  return subject;
}

function jsonArr(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Grants aplicáveis ao sujeito (pelo canal + pela conta GLPI vinculada). */
async function findGrants(subject: AccessSubject): Promise<ProjectAccessGrant[]> {
  const or: Array<{ subjectType: AccessSubjectType; subjectKey: string }> = [
    { subjectType: subject.type, subjectKey: subject.key },
  ];
  if (subject.glpiUserId) {
    or.push({ subjectType: AccessSubjectType.GLPI_USER, subjectKey: String(subject.glpiUserId) });
  }
  return prisma.projectAccessGrant.findMany({ where: { OR: or } });
}

function grantCoversScope(grant: ProjectAccessGrant, projectId?: string | null, componentId?: string | null): boolean {
  if (projectId && grant.projectId !== projectId) return false;
  if (componentId) {
    return grant.componentId === componentId || (grant.componentId === null && grant.inheritChildren);
  }
  return true;
}

/** Acesso default por role quando a allow-list de ferramentas do grant está vazia. */
function roleAllowsRisk(role: ProjectRole, risk: RiskLevel): boolean {
  switch (role) {
    case ProjectRole.ADMIN:
    case ProjectRole.MAINTAINER:
      return true;
    case ProjectRole.DEVELOPER:
      return risk !== "CRITICAL";
    case ProjectRole.OPERATOR:
    case ProjectRole.VIEWER:
    case ProjectRole.AUDITOR:
    default:
      return risk === "LOW" || risk === "MEDIUM";
  }
}

/**
 * Núcleo de decisão de acesso — PURO (sem I/O). Recebe os grants já carregados.
 * Exposto para testes unitários determinísticos.
 */
export function evaluateToolAccess(
  subject: AccessSubject,
  check: ToolAccessCheck,
  grants: ProjectAccessGrant[],
): ToolAccessResult {
  const risk = riskOf(check.tool);

  // Web local/admin: acesso amplo (retrocompatível)
  if (subject.type === AccessSubjectType.WEB_USER) {
    return { allowed: true, requiresApproval: false };
  }

  // Baixo risco: sempre permitido (lista/leitura de chamados, busca escopada)
  if (risk === "LOW") return { allowed: true, requiresApproval: false };

  if (grants.length === 0) {
    return { allowed: false, requiresApproval: false,
      reason: "Este canal não possui permissões configuradas. Solicite acesso a um administrador." };
  }

  const scopeGrants = grants.filter((g) => grantCoversScope(g, check.projectId, check.componentId));
  if ((check.projectId || check.componentId) && scopeGrants.length === 0) {
    return { allowed: false, requiresApproval: false,
      reason: "Você não possui acesso ao projeto/componente solicitado neste canal." };
  }
  const effective = scopeGrants.length ? scopeGrants : grants;

  if (effective.some((g) => jsonArr(g.deniedTools).includes(check.tool))) {
    return { allowed: false, requiresApproval: false, reason: `Ferramenta ${check.tool} negada explicitamente.` };
  }

  const allowedByGrant = effective.some((g) => {
    const allow = jsonArr(g.allowedTools);
    return allow.length === 0 ? roleAllowsRisk(g.role, risk) : allow.includes(check.tool);
  });
  if (!allowedByGrant) {
    return { allowed: false, requiresApproval: false, reason: `Ferramenta ${check.tool} não permitida para o seu papel neste escopo.` };
  }

  if (check.environment) {
    const envOk = effective.some((g) => {
      const envs = jsonArr(g.allowedEnvironments);
      return envs.length === 0 || envs.includes(check.environment as string);
    });
    if (!envOk) {
      return { allowed: false, requiresApproval: false, reason: `Ambiente ${check.environment} não permitido neste escopo.` };
    }
  }

  const requiresApproval = risk === "CRITICAL"
    || (risk === "HIGH" && check.environment === "prod")
    || effective.some((g) => jsonArr(g.requiresApprovalFor).includes(check.tool));

  return { allowed: true, requiresApproval };
}

export async function canUseTool(subject: AccessSubject, check: ToolAccessCheck): Promise<ToolAccessResult> {
  // Web/baixo-risco não precisam de I/O; demais carregam os grants do sujeito.
  if (subject.type === AccessSubjectType.WEB_USER || riskOf(check.tool) === "LOW") {
    return evaluateToolAccess(subject, check, []);
  }
  return evaluateToolAccess(subject, check, await findGrants(subject));
}

/** Versão que lança erro (e audita) quando a ferramenta não é permitida. */
export async function assertCanUseTool(subject: AccessSubject, check: ToolAccessCheck): Promise<ToolAccessResult> {
  const result = await canUseTool(subject, check);
  if (!result.allowed) {
    await audit.record(subject.key, "tool.denied", "Tool", check.tool,
      { projectId: check.projectId, componentId: check.componentId, environment: check.environment, reason: result.reason });
    const error = new Error(result.reason ?? "Acesso negado") as Error & { code?: string };
    error.code = "ACCESS_DENIED";
    throw error;
  }
  if (result.requiresApproval) {
    await audit.record(subject.key, "tool.approval_required", "Tool", check.tool,
      { projectId: check.projectId, componentId: check.componentId, environment: check.environment });
  }
  return result;
}

export async function canAccessProject(subject: AccessSubject, projectId: string): Promise<boolean> {
  if (subject.type === AccessSubjectType.WEB_USER) return true;
  const grants = await findGrants(subject);
  return grants.some((g) => g.projectId === projectId);
}

export async function canAccessComponent(subject: AccessSubject, componentId: string): Promise<boolean> {
  if (subject.type === AccessSubjectType.WEB_USER) return true;
  const component = await prisma.projectComponent.findUnique({ where: { id: componentId }, select: { projectId: true } });
  if (!component) return false;
  const grants = await findGrants(subject);
  return grants.some((g) => grantCoversScope(g, component.projectId, componentId));
}

export interface AllowedProject {
  id: string;
  name: string;
  projectPath: string;
  componentIds: string[];
}

/** Projetos (e componentes) que o sujeito pode acessar. */
export async function listAllowedProjects(subject: AccessSubject): Promise<AllowedProject[]> {
  if (subject.type === AccessSubjectType.WEB_USER) {
    const projects = await prisma.codebaseProject.findMany({
      select: { id: true, name: true, projectPath: true, components: { select: { id: true } } },
      orderBy: { name: "asc" },
    });
    return projects.map((p) => ({ id: p.id, name: p.name, projectPath: p.projectPath, componentIds: p.components.map((c) => c.id) }));
  }
  const grants = await findGrants(subject);
  const projectIds = [...new Set(grants.map((g) => g.projectId))];
  if (!projectIds.length) return [];
  const projects = await prisma.codebaseProject.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, name: true, projectPath: true, components: { select: { id: true, projectId: true } } },
    orderBy: { name: "asc" },
  });
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    projectPath: p.projectPath,
    componentIds: p.components.filter((c) => grants.some((g) => grantCoversScope(g, c.projectId, c.id))).map((c) => c.id),
  }));
}

export interface KnowledgeScopeFilter {
  /** null = sem restrição (acesso amplo, ex.: web/admin). */
  projectIds: string[] | null;
  componentIds: string[] | null;
}

/** Escopos de conhecimento (RAG) permitidos ao sujeito, para filtrar o Qdrant. */
export async function getAllowedKnowledgeScopes(subject: AccessSubject): Promise<KnowledgeScopeFilter> {
  if (subject.type === AccessSubjectType.WEB_USER) return { projectIds: null, componentIds: null };
  const grants = await findGrants(subject);
  if (!grants.length) return { projectIds: [], componentIds: [] };
  const projectIds = [...new Set(grants.map((g) => g.projectId))];
  const componentIds = [...new Set(grants.map((g) => g.componentId).filter((id): id is string => Boolean(id)))];
  return { projectIds, componentIds };
}

export interface GrantInput {
  subjectType: AccessSubjectType;
  subjectKey: string;
  projectId: string;
  componentId?: string | null;
  role?: ProjectRole;
  inheritChildren?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
  allowedEnvironments?: string[];
  requiresApprovalFor?: string[];
  createdBy?: string;
}

export interface AccessProfileEntry {
  projectId: string;
  componentId?: string | null;
  role?: ProjectRole;
  inheritChildren?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
  allowedEnvironments?: string[];
  requiresApprovalFor?: string[];
}

export interface AccessProfileInput {
  name: string;
  description?: string | null;
  entries: AccessProfileEntry[];
  createdBy?: string;
}

export async function grantAccess(input: GrantInput) {
  const grant = await prisma.projectAccessGrant.create({
    data: {
      subjectType: input.subjectType,
      subjectKey: input.subjectKey,
      projectId: input.projectId,
      componentId: input.componentId ?? null,
      role: input.role ?? ProjectRole.VIEWER,
      inheritChildren: input.inheritChildren ?? false,
      allowedTools: (input.allowedTools ?? []) as object,
      deniedTools: (input.deniedTools ?? []) as object,
      allowedEnvironments: (input.allowedEnvironments ?? []) as object,
      requiresApprovalFor: (input.requiresApprovalFor ?? []) as object,
      createdBy: input.createdBy,
    },
  });
  await audit.record(input.createdBy ?? "system", "project.access.grant", "ProjectAccessGrant", grant.id,
    { subjectType: input.subjectType, subjectKey: input.subjectKey, projectId: input.projectId, componentId: input.componentId });
  logger.info({ grantId: grant.id, subject: input.subjectKey }, "Grant de acesso criado");
  return grant;
}

export async function listProfiles() {
  return prisma.projectAccessProfile.findMany({ orderBy: { name: "asc" } });
}

export async function createProfile(input: AccessProfileInput) {
  const profile = await prisma.projectAccessProfile.create({
    data: {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      entries: input.entries as object,
      createdBy: input.createdBy,
    },
  });
  await audit.record(input.createdBy ?? "system", "project.access_profile.create", "ProjectAccessProfile", profile.id, {
    name: profile.name,
    entries: input.entries.length,
  });
  return profile;
}

export async function updateProfile(profileId: string, input: Partial<AccessProfileInput>, actor?: string) {
  const profile = await prisma.projectAccessProfile.update({
    where: { id: profileId },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.entries !== undefined ? { entries: input.entries as object } : {}),
    },
  });
  await audit.record(actor ?? "system", "project.access_profile.update", "ProjectAccessProfile", profile.id, {
    name: profile.name,
  });
  return profile;
}

export async function deleteProfile(profileId: string, actor?: string): Promise<void> {
  await prisma.projectAccessProfile.delete({ where: { id: profileId } });
  await audit.record(actor ?? "system", "project.access_profile.delete", "ProjectAccessProfile", profileId);
}

export async function applyProfile(input: {
  profileId: string;
  subjectType: AccessSubjectType;
  subjectKey: string;
  createdBy?: string;
}) {
  const profile = await prisma.projectAccessProfile.findUnique({ where: { id: input.profileId } });
  if (!profile) throw new Error("Perfil de acesso nao encontrado");
  const entries = Array.isArray(profile.entries) ? profile.entries as unknown as AccessProfileEntry[] : [];
  const grants = [];
  for (const entry of entries) {
    grants.push(await grantAccess({
      subjectType: input.subjectType,
      subjectKey: input.subjectKey,
      projectId: entry.projectId,
      componentId: entry.componentId ?? null,
      role: entry.role ?? ProjectRole.VIEWER,
      inheritChildren: entry.inheritChildren ?? false,
      allowedTools: entry.allowedTools ?? [],
      deniedTools: entry.deniedTools ?? [],
      allowedEnvironments: entry.allowedEnvironments ?? [],
      requiresApprovalFor: entry.requiresApprovalFor ?? [],
      createdBy: input.createdBy,
    }));
  }
  await audit.record(input.createdBy ?? "system", "project.access_profile.apply", "ProjectAccessProfile", profile.id, {
    subjectType: input.subjectType,
    subjectKey: input.subjectKey,
    grants: grants.length,
  });
  return { profile, grants };
}

export async function revokeAccess(grantId: string, actor?: string): Promise<void> {
  await prisma.projectAccessGrant.delete({ where: { id: grantId } });
  await audit.record(actor ?? "system", "project.access.revoke", "ProjectAccessGrant", grantId);
}

export async function listGrants(projectId: string) {
  return prisma.projectAccessGrant.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
}
