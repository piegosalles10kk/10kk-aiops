import { prisma } from "../lib/prisma.js";
import * as audit from "./audit.service.js";

/**
 * Escopo ativo de um chat do Gerente: "sobre o que estamos falando agora"
 * (projeto + componente + ambiente). Persistido por canal em ManagerSessionScope.
 */

export interface ManagerScope {
  channel: string;
  activeProjectId: string | null;
  activeProjectName: string | null;
  activeComponentId: string | null;
  activeComponentName: string | null;
  activeEnvironment: string | null;
}

export async function getScope(channel: string): Promise<ManagerScope> {
  const scope = await prisma.managerSessionScope.findUnique({
    where: { channel },
    include: { activeProject: { select: { name: true } }, activeComponent: { select: { name: true } } },
  });
  return {
    channel,
    activeProjectId: scope?.activeProjectId ?? null,
    activeProjectName: scope?.activeProject?.name ?? null,
    activeComponentId: scope?.activeComponentId ?? null,
    activeComponentName: scope?.activeComponent?.name ?? null,
    activeEnvironment: scope?.activeEnvironment ?? null,
  };
}

export interface SetScopeInput {
  projectId?: string;
  projectName?: string;
  componentId?: string;
  componentName?: string;
  environment?: string | null;
  updatedBy?: string;
}

export interface ScopeResolution {
  ok: boolean;
  scope?: ManagerScope;
  /** Quando há ambiguidade, candidatos para o Gerente perguntar. */
  candidates?: Array<{ id: string; name: string; relativePath: string; type: string }>;
  error?: string;
}

/** Resolve o projeto por id ou nome (case-insensitive, match parcial). */
async function resolveProject(input: SetScopeInput) {
  if (input.projectId) return prisma.codebaseProject.findUnique({ where: { id: input.projectId } });
  if (!input.projectName) return null;
  const all = await prisma.codebaseProject.findMany();
  const q = input.projectName.trim().toLowerCase();
  return all.find((p) => p.name.toLowerCase() === q)
    ?? all.find((p) => p.name.toLowerCase().includes(q))
    ?? null;
}

export async function setScope(channel: string, input: SetScopeInput): Promise<ScopeResolution> {
  const project = await resolveProject(input);
  if (!project) return { ok: false, error: `Projeto não encontrado: ${input.projectName ?? input.projectId ?? "—"}` };

  let componentId: string | null = null;
  if (input.componentId || input.componentName) {
    const components = await prisma.projectComponent.findMany({
      where: { projectId: project.id, status: { in: ["DETECTED", "CONFIRMED"] }, enabled: true },
    });
    let matches = input.componentId
      ? components.filter((c) => c.id === input.componentId)
      : components.filter((c) => {
          const q = (input.componentName ?? "").trim().toLowerCase();
          return c.name.toLowerCase() === q || c.relativePath.toLowerCase() === q;
        });
    if (!matches.length && input.componentName) {
      const q = input.componentName.trim().toLowerCase();
      matches = components.filter((c) => c.name.toLowerCase().includes(q) || c.relativePath.toLowerCase().includes(q));
    }
    if (matches.length === 0) {
      return { ok: false, error: `Componente não encontrado em ${project.name}: ${input.componentName ?? input.componentId}` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        candidates: matches.map((c) => ({ id: c.id, name: c.name, relativePath: c.relativePath, type: c.type })),
        error: "Mais de um componente corresponde — escolha um.",
      };
    }
    componentId = matches[0]!.id;
  }

  await prisma.managerSessionScope.upsert({
    where: { channel },
    create: {
      channel,
      activeProjectId: project.id,
      activeComponentId: componentId,
      activeEnvironment: input.environment ?? null,
      updatedBy: input.updatedBy,
    },
    update: {
      activeProjectId: project.id,
      activeComponentId: componentId,
      ...(input.environment !== undefined ? { activeEnvironment: input.environment } : {}),
      updatedBy: input.updatedBy,
    },
  });
  await audit.record(input.updatedBy ?? channel, "manager.scope.set", "ManagerSessionScope", channel,
    { projectId: project.id, componentId, environment: input.environment ?? null });

  return { ok: true, scope: await getScope(channel) };
}

export async function clearScope(channel: string, actor?: string): Promise<void> {
  await prisma.managerSessionScope.deleteMany({ where: { channel } });
  await audit.record(actor ?? channel, "manager.scope.clear", "ManagerSessionScope", channel);
}
