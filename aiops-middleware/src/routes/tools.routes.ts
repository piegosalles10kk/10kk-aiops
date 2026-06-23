import { Router } from "express";
import { ToolKind } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import * as toolRun from "../services/tool-run.service.js";
import * as visualTest from "../services/visual-test.service.js";
import * as pentest from "../services/pentest.service.js";
import * as loadtest from "../services/loadtest.service.js";
import { toolReportPdf } from "../services/report.service.js";

/**
 * API das 3 ferramentas de qualidade (Visual / Pentest / Stress). Alimenta as
 * abas de histórico do Command Center e permite disparo direto pela UI.
 */
export const toolsRouter = Router();

const KIND_BY_SLUG: Record<string, ToolKind> = {
  visual: ToolKind.VISUAL,
  pentest: ToolKind.PENTEST,
  load: ToolKind.LOAD,
  stress: ToolKind.LOAD,
};

/** Projetos cadastrados disponíveis para SAST/SCA. */
toolsRouter.get("/projects", async (_req, res) => {
  const projects = await prisma.codebaseProject.findMany({
    select: { id: true, name: true, projectPath: true, sshAuthType: true, sshHost: true },
    orderBy: { name: "asc" },
  });
  res.json(projects);
});

/** Subprojetos (apps) dentro de um projeto cadastrado — para escopo do SAST/SCA. */
toolsRouter.get("/projects/:id/subprojects", async (req, res) => {
  const project = await prisma.codebaseProject.findUnique({ where: { id: req.params.id } });
  if (!project?.projectPath) return res.json({ root: "", rootHasManifest: false, rootType: null, subprojects: [] });
  try {
    res.json(await pentest.detectSubprojects(project));
  } catch (error) {
    res.json({ root: project.projectPath, rootHasManifest: false, rootType: null, subprojects: [],
      error: error instanceof Error ? error.message : String(error) });
  }
});

/** Histórico de execuções (lista), opcionalmente filtrado por tipo e desde quando. */
toolsRouter.get("/runs", async (req, res) => {
  const kind = req.query.kind ? KIND_BY_SLUG[String(req.query.kind).toLowerCase()] : undefined;
  const since = req.query.since ? new Date(String(req.query.since)) : undefined;
  res.json(await toolRun.listRuns(kind, since && !Number.isNaN(since.getTime()) ? since : undefined));
});

/** Detalhe de uma execução (steps, relatório, achados, tokens). */
toolsRouter.get("/runs/:id", async (req, res) => {
  const run = await toolRun.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Execução não encontrada" });
  res.json(run);
});

/** PDF do relatório. */
toolsRouter.get("/runs/:id/report.pdf", async (req, res) => {
  const run = await toolRun.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Execução não encontrada" });
  const pdf = await toolReportPdf(run);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="relatorio-${run.kind.toLowerCase()}-${run.id.slice(0, 8)}.pdf"`);
  res.send(pdf);
});

/** Cancela uma execução em andamento. */
toolsRouter.post("/runs/:id/cancel", async (req, res) => {
  const ok = await toolRun.cancel(req.params.id);
  res.status(ok ? 200 : 400).json({ cancelled: ok });
});

/** Dispara uma execução direto pela UI: POST /api/tools/:kind/run */
toolsRouter.post("/:kind/run", async (req, res) => {
  const kind = KIND_BY_SLUG[String(req.params.kind).toLowerCase()];
  if (!kind) return res.status(400).json({ error: "Ferramenta inválida" });
  const body = req.body ?? {};
  const input = {
    channel: "web",
    targetUrl: body.targetUrl ? String(body.targetUrl) : undefined,
    projectId: body.projectId ? String(body.projectId) : undefined,
    params: (body.params ?? {}) as Record<string, unknown>,
  };
  const run = kind === ToolKind.VISUAL
    ? await visualTest.start(input)
    : kind === ToolKind.PENTEST
      ? await pentest.start(input)
      : await loadtest.start(input);
  res.status(202).json({ id: run.id, kind: run.kind });
});
