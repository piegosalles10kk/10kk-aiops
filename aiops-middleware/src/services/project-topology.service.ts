import { ProjectComponentStatus, ProjectComponentType, type Prisma } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import * as audit from "./audit.service.js";
import * as tool from "./tool-run.service.js";
import * as pentest from "./pentest.service.js";

/**
 * Topologia de projetos: descobre, persiste e revisa os componentes (sistemas
 * internos/subprojetos) de um CodebaseProject. Para projetos locais usa o
 * runner do host; para remotos, faz uma varredura rasa por SSH.
 *
 * Retrocompatível: um projeto sem componentes continua funcionando como pasta
 * única (o projeto raiz é o próprio CodebaseProject).
 */

const VALID_TYPES = new Set<string>(Object.values(ProjectComponentType));

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "componente";
}

function toComponentType(raw?: string | null): ProjectComponentType {
  const upper = String(raw ?? "").toUpperCase();
  return (VALID_TYPES.has(upper) ? upper : "UNKNOWN") as ProjectComponentType;
}

export interface TopologyComponentDTO {
  name: string;
  slug: string;
  relativePath: string;
  type: ProjectComponentType;
  runtime?: string | null;
  framework?: string | null;
  packageManager?: string | null;
  language?: string | null;
  detectionConfidence: number;
  detectedBy: string[];
  metadata: Record<string, unknown>;
}

export interface ProjectTopologyScanResult {
  projectId: string;
  projectName: string;
  isMonorepo: boolean;
  components: TopologyComponentDTO[];
  summary: Record<string, number>;
}

/** Normaliza a saída do runner (rica) ou da varredura SSH (rasa) em DTOs. */
function normalizeComponents(scan: tool.SubprojectScan): TopologyComponentDTO[] {
  if (Array.isArray(scan.components) && scan.components.length) {
    return scan.components.map((c) => ({
      name: c.name,
      slug: slugify(c.relativePath),
      relativePath: c.relativePath,
      type: toComponentType(c.type),
      runtime: c.runtime ?? null,
      framework: c.framework ?? null,
      packageManager: c.packageManager ?? null,
      language: c.language ?? null,
      detectionConfidence: typeof c.confidence === "number" ? c.confidence : 0.5,
      detectedBy: Array.isArray(c.detectedBy) ? c.detectedBy : [],
      metadata: (c.metadata ?? {}) as Record<string, unknown>,
    }));
  }
  // Varredura rasa (SSH): apenas nome/caminho/tipo.
  return (scan.subprojects ?? []).map((s) => ({
    name: s.name.split("/").pop() ?? s.name,
    slug: slugify(s.path),
    relativePath: s.path,
    type: toComponentType(s.type),
    detectionConfidence: 0.5,
    detectedBy: ["ssh"],
    metadata: {},
  }));
}

/**
 * Escaneia a topologia de um projeto e persiste os componentes detectados.
 * Rescans atualizam os metadados de detecção mas preservam o estado de revisão
 * humana (CONFIRMED/IGNORED não voltam para DETECTED).
 */
export async function scanProjectTopology(
  projectId: string,
  opts: { actor?: string } = {},
): Promise<ProjectTopologyScanResult> {
  const project = await prisma.codebaseProject.findUnique({ where: { id: projectId } });
  if (!project?.projectPath) throw new Error("Projeto não encontrado ou sem caminho");

  await prisma.codebaseProject.update({ where: { id: projectId }, data: { topologyStatus: "SCANNING" } });

  // O código-fonte normalmente vive no host do runner (PROJECTS_HOST_ROOT),
  // mesmo quando o projeto tem SSH configurado (a SSH é p/ diagnóstico remoto).
  // Tentamos a detecção local primeiro; só caímos para SSH se o local não achar
  // nada (ou falhar) E houver credencial SSH.
  const hasSsh = Boolean(project.sshAuthType && project.sshAuthType !== "pm2");
  let scan: tool.SubprojectScan;
  try {
    scan = await tool.detectSubprojects(project.projectPath);
    const empty = !scan.components?.length && !scan.subprojects?.length;
    if (empty && hasSsh) {
      const remote = await pentest.detectSubprojects(project).catch(() => null);
      if (remote && (remote.components?.length || remote.subprojects?.length)) scan = remote;
    }
  } catch (localError) {
    if (!hasSsh) {
      await prisma.codebaseProject.update({ where: { id: projectId }, data: { topologyStatus: "FAILED" } });
      throw localError;
    }
    try {
      scan = await pentest.detectSubprojects(project);
    } catch (remoteError) {
      await prisma.codebaseProject.update({ where: { id: projectId }, data: { topologyStatus: "FAILED" } });
      throw remoteError;
    }
  }

  const detected = normalizeComponents(scan);
  const isMonorepo = Boolean(scan.isMonorepo ?? detected.length >= 2);

  // Persiste de forma idempotente, preservando revisão humana.
  const seenPaths = new Set<string>();
  for (const dto of detected) {
    seenPaths.add(dto.relativePath);
    const existing = await prisma.projectComponent.findUnique({
      where: { projectId_relativePath: { projectId, relativePath: dto.relativePath } },
    });
    const detectionData = {
      name: dto.name,
      type: dto.type,
      runtime: dto.runtime ?? null,
      framework: dto.framework ?? null,
      packageManager: dto.packageManager ?? null,
      language: dto.language ?? null,
      detectionConfidence: dto.detectionConfidence,
      detectedBy: dto.detectedBy as unknown as Prisma.InputJsonValue,
      metadata: dto.metadata as Prisma.InputJsonValue,
    };
    if (existing) {
      await prisma.projectComponent.update({ where: { id: existing.id }, data: detectionData });
    } else {
      await prisma.projectComponent.create({
        data: {
          projectId,
          relativePath: dto.relativePath,
          slug: await uniqueSlug(projectId, dto.slug),
          status: ProjectComponentStatus.DETECTED,
          ...detectionData,
        },
      });
    }
  }

  const summary = (scan.summary ?? buildSummary(detected)) as Prisma.InputJsonValue;
  await prisma.codebaseProject.update({
    where: { id: projectId },
    data: {
      isMonorepo,
      topologyStatus: "SCANNED",
      topologyLastScanAt: new Date(),
      topologySummary: summary,
    },
  });

  await audit.record(opts.actor ?? "system", "project.topology.scan", "CodebaseProject", projectId,
    { detected: detected.length, isMonorepo });
  logger.info({ projectId, detected: detected.length, isMonorepo }, "Topologia escaneada");

  return {
    projectId,
    projectName: project.name,
    isMonorepo,
    components: detected,
    summary: (scan.summary ?? buildSummary(detected)) as Record<string, number>,
  };
}

function buildSummary(components: TopologyComponentDTO[]): Record<string, number> {
  const count = (t: string) => components.filter((c) => c.type === t).length;
  return {
    totalComponents: components.length,
    backendCount: count("BACKEND_API") + count("PAYMENT") + count("AI_SERVICE"),
    frontendCount: count("FRONTEND"),
    workerCount: count("WORKER"),
    infraCount: count("INFRA"),
    unknownCount: count("UNKNOWN"),
  };
}

/** Garante slug único dentro do projeto (sufixo numérico em caso de colisão). */
async function uniqueSlug(projectId: string, base: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (await prisma.projectComponent.findUnique({ where: { projectId_slug: { projectId, slug } } })) {
    slug = `${base}-${++n}`;
  }
  return slug;
}

export async function rescanProjectTopology(projectId: string, opts: { actor?: string } = {}) {
  return scanProjectTopology(projectId, opts);
}

export interface ConfirmComponentInput {
  relativePath: string;
  name?: string;
  type?: ProjectComponentType;
  enabled?: boolean;
  status?: ProjectComponentStatus;
  ownerTeam?: string | null;
  riskLevel?: string | null;
}

export interface ConfirmTopologyInput {
  components: ConfirmComponentInput[];
  createGlpiEntities?: boolean;
}

/** Confirma/ignora componentes detectados e (opcionalmente) sincroniza GLPI. */
export async function confirmProjectTopology(
  projectId: string,
  input: ConfirmTopologyInput,
  opts: { actor?: string } = {},
): Promise<void> {
  const project = await prisma.codebaseProject.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Projeto não encontrado");

  for (const c of input.components) {
    const existing = await prisma.projectComponent.findUnique({
      where: { projectId_relativePath: { projectId, relativePath: c.relativePath } },
    });
    if (!existing) continue;
    const status = c.status
      ?? (c.enabled === false ? ProjectComponentStatus.IGNORED : ProjectComponentStatus.CONFIRMED);
    await prisma.projectComponent.update({
      where: { id: existing.id },
      data: {
        status,
        enabled: c.enabled ?? status === ProjectComponentStatus.CONFIRMED,
        ...(c.name ? { name: c.name } : {}),
        ...(c.type ? { type: c.type } : {}),
        ...(c.ownerTeam !== undefined ? { ownerTeam: c.ownerTeam } : {}),
        ...(c.riskLevel !== undefined ? { riskLevel: c.riskLevel } : {}),
      },
    });
  }

  await prisma.codebaseProject.update({ where: { id: projectId }, data: { topologyStatus: "CONFIRMED" } });
  await audit.record(opts.actor ?? "system", "project.topology.confirm", "CodebaseProject", projectId,
    { components: input.components.length, createGlpiEntities: Boolean(input.createGlpiEntities) });

  if (input.createGlpiEntities) {
    try {
      const glpi = await import("./glpi-entity.service.js");
      await glpi.syncProjectEntities(projectId, opts.actor);
    } catch (error) {
      logger.warn({ error, projectId }, "Sincronização de entidades GLPI falhou (topologia confirmada mesmo assim)");
    }
  }
}

export async function confirmComponent(
  componentId: string,
  patch: Partial<ConfirmComponentInput> = {},
  opts: { actor?: string } = {},
): Promise<void> {
  await prisma.projectComponent.update({
    where: { id: componentId },
    data: {
      status: ProjectComponentStatus.CONFIRMED,
      enabled: true,
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.type ? { type: patch.type } : {}),
      ...(patch.ownerTeam !== undefined ? { ownerTeam: patch.ownerTeam } : {}),
      ...(patch.riskLevel !== undefined ? { riskLevel: patch.riskLevel } : {}),
    },
  });
  await audit.record(opts.actor ?? "system", "project.component.confirm", "ProjectComponent", componentId);
}

export async function ignoreComponent(componentId: string, opts: { actor?: string } = {}): Promise<void> {
  await prisma.projectComponent.update({
    where: { id: componentId },
    data: { status: ProjectComponentStatus.IGNORED, enabled: false },
  });
  await audit.record(opts.actor ?? "system", "project.component.ignore", "ProjectComponent", componentId);
}

/** Árvore de topologia persistida de um projeto (para UI e tools do Gerente). */
export async function listProjectTopology(projectId: string) {
  const project = await prisma.codebaseProject.findUnique({
    where: { id: projectId },
    include: { components: { orderBy: { relativePath: "asc" } } },
  });
  if (!project) throw new Error("Projeto não encontrado");
  return {
    id: project.id,
    name: project.name,
    projectPath: project.projectPath,
    slug: project.slug,
    isMonorepo: project.isMonorepo,
    glpiEntityId: project.glpiEntityId,
    topologyStatus: project.topologyStatus,
    topologyLastScanAt: project.topologyLastScanAt,
    topologySummary: project.topologySummary,
    components: project.components,
  };
}
