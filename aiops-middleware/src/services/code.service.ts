import axios from "axios";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

/**
 * Acesso somente-leitura ao código-fonte dos projetos dos agentes,
 * via runner no host (que enxerga o filesystem real, sempre atualizado).
 * Usado pelo Gerente durante o planejamento.
 */

const http = axios.create({
  baseURL: env.RUNNER_URL,
  timeout: 60_000,
  headers: { Authorization: `Bearer ${process.env.RUNNER_TOKEN ?? "local-runner-token"}` },
});

/**
 * Projetos conhecidos = o próprio código do middleware (este sistema) +
 * os projectPaths distintos dos agentes cadastrados +
 * os projetos registrados na tela de Projetos (CodebaseProject).
 */
export async function listProjects(): Promise<
  Array<{ projectPath: string; descricao: string; agentes: string[] }>
> {
  const [agents, codebaseProjects] = await Promise.all([
    prisma.agent.findMany({ where: { enabled: true } }),
    prisma.codebaseProject.findMany({
      where: { status: { in: ["COMPLETED", "PENDING", "FAILED"] } },
      select: { name: true, projectPath: true, description: true },
    }),
  ]);

  const byPath = new Map<string, string[]>();
  for (const agent of agents) {
    const list = byPath.get(agent.projectPath) ?? [];
    list.push(agent.name);
    byPath.set(agent.projectPath, list);
  }

  const seen = new Set<string>([env.SELF_CODE_PATH]);
  const projects: Array<{ projectPath: string; descricao: string; agentes: string[] }> = [
    {
      projectPath: env.SELF_CODE_PATH,
      descricao: "Este sistema — código-fonte do middleware AIOps (Central de Comando, Gerente, sync GLPI/Trello, agentes)",
      agentes: [],
    },
  ];

  for (const [projectPath, agentList] of byPath) {
    if (!seen.has(projectPath)) {
      seen.add(projectPath);
      projects.push({ projectPath, descricao: "Projeto de um agente", agentes: agentList });
    }
  }

  for (const cp of codebaseProjects) {
    if (!seen.has(cp.projectPath)) {
      seen.add(cp.projectPath);
      projects.push({
        projectPath: cp.projectPath,
        descricao: `${cp.name}${cp.description ? ` — ${cp.description}` : ""}`,
        agentes: [],
      });
    }
  }

  return projects;
}

export async function tree(projectPath: string, maxDepth?: number): Promise<unknown> {
  const { data } = await http.post("/fs/tree", { projectPath, maxDepth });
  return data;
}

export async function readFile(projectPath: string, filePath: string): Promise<unknown> {
  const { data } = await http.post("/fs/read", { projectPath, filePath });
  return data;
}

export async function search(projectPath: string, query: string): Promise<unknown> {
  const { data } = await http.post("/fs/search", { projectPath, query });
  return data;
}
