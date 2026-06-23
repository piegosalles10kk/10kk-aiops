import crypto from "node:crypto";
import axios from "axios";
import { Router } from "express";
import { AgentMode, AgentProvider, AgentRunStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import * as agents from "../services/agent.service.js";
import * as audit from "../services/audit.service.js";
import * as glpi from "../services/glpi.service.js";
import * as knowledge from "../services/knowledge.service.js";
import * as approval from "../services/approval.service.js";
import * as chatAccounts from "../services/chat-account.service.js";
import * as manager from "../services/manager.service.js";
import * as plans from "../services/plan.service.js";
import * as settings from "../services/settings.service.js";
import * as usage from "../services/usage.service.js";
import * as observabilityScanner from "../services/observability-scanner.service.js";
import * as reports from "../services/report.service.js";
import { getUsdToBrl } from "../services/exchange-rate.service.js";
import * as codebase from "../services/codebase-analysis.service.js";
import * as ssh from "../services/ssh.service.js";
import { getAiLogs } from "../lib/ai-log-buffer.js";

export const commandCenterRouter = Router();

commandCenterRouter.get("/dashboard", async (_req, res) => {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [incidents, agentCount, runs, recentRuns, tickets, monthCost, totalCost] = await Promise.all([
    prisma.incident.groupBy({ by: ["status"], _count: true }),
    prisma.agent.count(),
    prisma.agentRun.groupBy({ by: ["status"], _count: true }),
    prisma.agentRun.findMany({
      select: {
        id: true,
        kind: true,
        status: true,
        durationMs: true,
        glpiTicketId: true,
        createdAt: true,
        agent: { select: { id: true, name: true, provider: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    glpi.listDashboardTickets(),
    prisma.tokenUsage.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { costUsd: true } }),
    prisma.tokenUsage.aggregate({ _sum: { costUsd: true } }),
  ]);
  const active = tickets.filter((ticket) => ticket.status < glpi.GLPI_TICKET_STATUS.SOLVED);
  const queueItems = await Promise.all(active.map(async (ticket) => ({
    id: ticket.id,
    name: ticket.name,
    status: ticket.status,
    type: ticket.type,
    createdAt: ticket.date_creation ?? ticket.date ?? null,
    technicians: await glpi.getAssignedTechNames(ticket.id).catch(() => []),
  })));
  const oldestFirst = (items: typeof queueItems) => items.sort((a, b) => {
    const left = a.createdAt ? new Date(a.createdAt).getTime() : a.id;
    const right = b.createdAt ? new Date(b.createdAt).getTime() : b.id;
    return left - right;
  });
  const [brlRate, configuredGlpiWebUrl] = await Promise.all([
    getUsdToBrl(),
    settings.getSecret("GLPI_WEB_URL"),
  ]);
  const glpiWebUrl = (configuredGlpiWebUrl || env.GLPI_API_URL.replace(/\/api\.php\/v1\/?$/i, ""))
    .replace(/\/+$/, "");
  res.json({
    incidents,
    agentCount,
    runs,
    recentRuns,
    costs: {
      monthUsd: monthCost._sum.costUsd ?? 0,
      monthBrl: (monthCost._sum.costUsd ?? 0) * brlRate,
      totalUsd: totalCost._sum.costUsd ?? 0,
      totalBrl: (totalCost._sum.costUsd ?? 0) * brlRate,
    },
    exchangeRate: { usdBrl: brlRate },
    glpiWebUrl,
    ticketQueues: {
      open: oldestFirst(queueItems.filter((ticket) => ticket.status === glpi.GLPI_TICKET_STATUS.NEW)),
      inProgress: oldestFirst(queueItems.filter((ticket) =>
        ticket.status === glpi.GLPI_TICKET_STATUS.ASSIGNED ||
        ticket.status === glpi.GLPI_TICKET_STATUS.PLANNED)),
      pending: oldestFirst(queueItems.filter((ticket) => ticket.status === glpi.GLPI_TICKET_STATUS.PENDING)),
    },
  });
});

commandCenterRouter.get("/observability/preview", async (_req, res) => {
  res.json(await observabilityScanner.previewObservability());
});

commandCenterRouter.get("/settings", async (_req, res) => {
  res.json(await settings.listSettings());
});

commandCenterRouter.put("/settings", async (req, res) => {
  await settings.saveSettings(req.body ?? {});
  await audit.record("ui", "settings.update", "Settings");
  res.json({ ok: true });
});

const agentSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional().default(""),
  provider: z.nativeEnum(AgentProvider),
  mode: z.nativeEnum(AgentMode),
  projectPath: z.string().min(2),
  instructions: z.string().optional().default(""),
  model: z.string().optional().nullable(),
  enabled: z.boolean().optional().default(true),
});

commandCenterRouter.get("/agents", async (_req, res) => {
  res.json(await prisma.agent.findMany({ orderBy: { name: "asc" } }));
});

commandCenterRouter.post("/agents", async (req, res) => {
  const data = agentSchema.parse(req.body);
  const agent = await prisma.agent.create({ data });
  await audit.record("ui", "agent.create", "Agent", agent.id);
  res.status(201).json(agent);
});

commandCenterRouter.put("/agents/:id", async (req, res) => {
  const data = agentSchema.partial().parse(req.body);
  const agent = await prisma.agent.update({ where: { id: req.params.id }, data });
  await audit.record("ui", "agent.update", "Agent", agent.id);
  res.json(agent);
});

commandCenterRouter.delete("/agents/:id", async (req, res) => {
  await prisma.agent.delete({ where: { id: req.params.id } });
  await audit.record("ui", "agent.delete", "Agent", req.params.id);
  res.status(204).end();
});

commandCenterRouter.post("/agents/:id/test", async (req, res) => {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: req.params.id } });
  const run = await agents.testAgent(agent, typeof req.body?.message === "string" ? req.body.message : undefined);
  res.json(run);
});

commandCenterRouter.post("/agents/:id/glpi-account", async (req, res) => {
  const agent = await prisma.agent.findUniqueOrThrow({ where: { id: req.params.id } });
  if (agent.glpiUserId) return res.status(409).json({ error: "Agente já possui conta GLPI" });
  const profileSetting = await settings.listSettings();
  let profileId = Number(profileSetting.find((item) => item.key === "GLPI_AGENT_PROFILE_ID")?.value);
  if (!profileId) {
    // Sem configuração explícita: autodetecta o perfil Técnico no GLPI
    profileId = (await glpi.findDefaultAgentProfileId()) ?? 0;
  }
  if (!profileId) {
    return res.status(400).json({
      error: "Nenhum perfil Técnico encontrado no GLPI — configure GLPI_AGENT_PROFILE_ID",
    });
  }
  const username = `agent_${agent.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}_${crypto.randomBytes(2).toString("hex")}`;
  const password = crypto.randomBytes(18).toString("base64url");
  const glpiUserId = await glpi.createAgentUser({ username, fullName: agent.name, password, profileId });
  await prisma.agent.update({ where: { id: agent.id }, data: { glpiUserId, glpiUsername: username } });
  await audit.record("ui", "agent.glpi_account.create", "Agent", agent.id, { glpiUserId, username });
  res.status(201).json({ glpiUserId, username, password });
});

commandCenterRouter.get("/runs", async (_req, res) => {
  res.json(await prisma.agentRun.findMany({
    include: { agent: true }, orderBy: { createdAt: "desc" }, take: 100,
  }));
});

commandCenterRouter.get("/runs/:id", async (req, res) => {
  const run = await prisma.agentRun.findUnique({
    where: { id: req.params.id },
    include: { agent: true },
  });
  if (!run) return res.status(404).json({ error: "Execução não encontrada" });
  res.json(run);
});

commandCenterRouter.post("/runs/:id/cancel", async (req, res) => {
  const run = await prisma.agentRun.findUnique({ where: { id: req.params.id } });
  if (!run) return res.status(404).json({ error: "Execução não encontrada" });
  if (run.status !== "RUNNING" && run.status !== "QUEUED") {
    return res.status(400).json({ error: `Execução não está em andamento (status: ${run.status})` });
  }
  try {
    const headers = { Authorization: `Bearer ${process.env.RUNNER_TOKEN ?? "local-runner-token"}` };
    await axios.delete(`${env.RUNNER_URL}/runs/${run.runnerRunId ?? run.id}`, { timeout: 10_000, headers });
  } catch (error) {
    if (!axios.isAxiosError(error) || error.response?.status !== 404) {
      logger.warn({ err: (error instanceof Error ? error.message : String(error)), runId: run.id }, "Falha ao cancelar no runner");
    }
  }
  const updated = await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "CANCELLED" as AgentRunStatus, error: "Cancelado pelo usuário.", finishedAt: new Date() },
  });
  await audit.record("ui", "run.cancel", "AgentRun", run.id);
  res.json(updated);
});

commandCenterRouter.post("/runs/:id/restart", async (req, res) => {
  const run = await prisma.agentRun.findUnique({
    where: { id: req.params.id },
    include: { agent: true },
  });
  if (!run) return res.status(404).json({ error: "Execução não encontrada" });
  if (!run.agent) return res.status(400).json({ error: "Agente não encontrado ou foi excluído" });

  const ticketContext = run.glpiTicketId
    ? await glpi.getTicketContext(run.glpiTicketId).catch(() => undefined)
    : undefined;

  // Move chamado para Em andamento
  if (run.glpiTicketId) {
    try {
      await glpi.updateTicketStatus(run.glpiTicketId, glpi.GLPI_TICKET_STATUS.ASSIGNED);
    } catch (error) {
      logger.warn({ err: (error instanceof Error ? error.message : String(error)), ticketId: run.glpiTicketId }, "Falha ao atualizar status do chamado no restart");
    }
  }

  const newRun = await agents.executeAgent({
    agent: run.agent,
    kind: run.kind as "TEST" | "TICKET" | "CHAT",
    message: "",
    rawPrompt: run.prompt,
    ticketContext,
    glpiTicketId: run.glpiTicketId ?? undefined,
    glpiTaskId: run.glpiTaskId ?? undefined,
    incidentId: run.incidentId ?? undefined,
    elevated: run.elevated,
  });

  await audit.record("ui", "run.restart", "AgentRun", run.id, { newRunId: newRun.id });
  res.json({ restarted: true, oldRunId: run.id, newRun });
});

commandCenterRouter.get("/incidents", async (_req, res) => {
  res.json(await prisma.incident.findMany({ orderBy: { updatedAt: "desc" }, take: 200 }));
});

commandCenterRouter.get("/manager/channels", async (_req, res) => {
  const [rows, accounts] = await Promise.all([
    prisma.managerMessage.groupBy({ by: ["channel"], _count: { _all: true }, _max: { createdAt: true } }),
    prisma.chatAccount.findMany(),
  ]);
  const accByChannel = new Map(accounts.map((a) => [a.channel, a]));
  const channels = rows
    .map((r) => {
      const acc = accByChannel.get(r.channel);
      return {
        channel: r.channel,
        count: r._count._all,
        lastAt: r._max.createdAt,
        glpiUserId: acc?.glpiUserId ?? null,
        glpiUsername: acc?.glpiUsername ?? null,
      };
    })
    .sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0));
  res.json(channels);
});

commandCenterRouter.get("/manager/channels/available-glpi-users", async (_req, res) => {
  res.json(
    (await glpi.listUsers())
      .filter((user) => user.active)
      .map(({ id, username, displayName }) => ({ id, username, displayName })),
  );
});

const chatAccountSchema = z.object({
  channel: z.string().min(1),
  mode: z.enum(["create", "link"]).default("create"),
  username: z.string().trim().min(3).max(64),
  displayName: z.string().trim().max(120).optional(),
});

// Cria ou vincula conta GLPI para uma sessão de chat (Telegram/Slack)
commandCenterRouter.post("/manager/channels/account", async (req, res) => {
  try {
    const data = chatAccountSchema.parse(req.body);
    const { channel } = data;
    if (channel === "web") return res.status(400).json({ error: "A sessão web não recebe conta GLPI." });
    const account = data.mode === "link"
      ? await chatAccounts.linkExistingAccount(channel, data.username)
      : await chatAccounts.createAccount(channel, data.username, data.displayName);
    await audit.record(
      "ui",
      `chat.glpi_account.${data.mode}`,
      "ChatAccount",
      channel,
      { glpiUserId: account.glpiUserId, username: account.username },
    );
    res.status(201).json({ ...account, mode: data.mode });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

commandCenterRouter.get("/manager/messages", async (req, res) => {
  const channel = String(req.query.channel ?? "web");
  // As 100 mais RECENTES (desc + take), devolvidas em ordem cronológica.
  const rows = await prisma.managerMessage.findMany({
    where: { channel }, orderBy: { createdAt: "desc" }, take: 100,
  });
  res.json(rows.reverse());
});

commandCenterRouter.get("/manager/models", async (_req, res) => {
  res.json({
    selected: env.MANAGER_MODEL,
    models: await manager.listManagerModels(),
  });
});

const attachmentSchema = z.object({
  mimeType: z.string().min(1),
  data: z.string().min(1),
  name: z.string().optional(),
});

commandCenterRouter.post("/manager/chat", async (req, res) => {
  const attachments = z.array(attachmentSchema).optional().parse(req.body?.attachments) ?? [];
  // Com anexo, a mensagem de texto é opcional
  const message = z
    .string()
    .optional()
    .parse(req.body?.message)
    ?? "";
  if (!message && attachments.length === 0) {
    return res.status(400).json({ error: "Mensagem vazia" });
  }
  // Console central: o web pode conversar em qualquer sessão (web, telegram:<id>, slack:<id>)
  const channel = z.string().min(1).optional().parse(req.body?.channel) ?? "web";
  const result = await manager.chat(message, channel, undefined, undefined, attachments);
  // Se o operador respondeu numa sessão de outra plataforma, entrega a resposta lá também
  if (channel.startsWith("telegram:") || channel.startsWith("slack:")) {
    await approval.notifyChannel(channel, result.answer).catch(() => undefined);
  }
  res.json(result);
});

commandCenterRouter.get("/plans", async (_req, res) => {
  res.json(await plans.listPlans());
});

commandCenterRouter.post("/knowledge/reindex", async (_req, res) => {
  res.json({ indexed: await knowledge.indexRecentTickets() });
});

commandCenterRouter.get("/logs/ai", (_req, res) => {
  const since = Number(_req.query.since) || 0;
  res.json(getAiLogs(since));
});

// ---------- Telas personalizadas (webviews na barra lateral) ----------
const viewSchema = z.object({
  label: z.string().min(1),
  url: z.string().url(),
  icon: z.string().max(4).optional().nullable(),
  position: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

commandCenterRouter.get("/views", async (_req, res) => {
  res.json(await prisma.customView.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] }));
});

commandCenterRouter.post("/views", async (req, res) => {
  const data = viewSchema.parse(req.body);
  const view = await prisma.customView.create({ data });
  await audit.record("ui", "view.create", "CustomView", view.id);
  res.status(201).json(view);
});

commandCenterRouter.put("/views/:id", async (req, res) => {
  const data = viewSchema.partial().parse(req.body);
  const view = await prisma.customView.update({ where: { id: req.params.id }, data });
  await audit.record("ui", "view.update", "CustomView", view.id);
  res.json(view);
});

commandCenterRouter.delete("/views/:id", async (req, res) => {
  await prisma.customView.delete({ where: { id: req.params.id } });
  await audit.record("ui", "view.delete", "CustomView", req.params.id);
  res.status(204).end();
});

commandCenterRouter.get("/usage", async (req, res) => {
  const range = ["day", "week", "month"].includes(String(req.query.range))
    ? (req.query.range as "day" | "week" | "month")
    : "day";
  const data = await usage.summary(range);
  const usdBrl = await getUsdToBrl();
  data.totals.costBrl = data.totals.costUsd * usdBrl;
  data.byModel = data.byModel.map((m) => ({ ...m, costBrl: m.costUsd * usdBrl }));
  data.byFeature = data.byFeature.map((f) => ({ ...f, costBrl: f.costUsd * usdBrl }));
  data.series = data.series.map((s) => ({ ...s, costBrl: s.costUsd * usdBrl }));
  res.json({ ...data, exchangeRate: { usdBrl } });
});

const reportSchema = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
  dateBasis: z.enum(["created", "updated", "solved"]).default("created"),
  technicianIds: z.array(z.number().int().positive()).default([]),
  includeUnassigned: z.boolean().default(false),
  statuses: z.array(z.number().int().min(1).max(6)).default([]),
  types: z.array(z.number().int().min(1).max(2)).default([]),
  includeDetails: z.boolean().default(true),
}).refine((data) => data.end >= data.start, {
  message: "A data final deve ser igual ou posterior à data inicial.",
  path: ["end"],
});

commandCenterRouter.get("/reports/options", async (_req, res) => {
  res.json(await reports.reportOptions());
});

commandCenterRouter.post("/reports/preview", async (req, res) => {
  const filters = reportSchema.parse(req.body ?? {});
  res.json(await reports.generateReport(filters));
});

commandCenterRouter.post("/reports/pdf", async (req, res) => {
  const filters = reportSchema.parse(req.body ?? {});
  const data = await reports.generateReport(filters);
  const pdf = await reports.generateReportPdfClean(data);
  const start = filters.start.toISOString().slice(0, 10);
  const end = filters.end.toISOString().slice(0, 10);
  await audit.record("ui", "report.pdf.generate", "Report", undefined, {
    start,
    end,
    tickets: data.summary.total,
  });
  res
    .status(200)
    .set({
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      "Content-Disposition": `attachment; filename="relatorio-chamados-${start}-${end}.pdf"`,
      "Cache-Control": "no-store",
    })
    .send(pdf);
});

commandCenterRouter.get("/audit", async (_req, res) => {
  res.json(await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 }));
});

commandCenterRouter.post("/system/pick-folder", async (_req, res) => {
  const { data } = await axios.post<{ path: string | null }>(
    `${env.RUNNER_URL}/pick-folder`,
    {},
    {
      timeout: 120_000,
      headers: { Authorization: `Bearer ${process.env.RUNNER_TOKEN ?? "local-runner-token"}` },
    },
  );
  res.json(data);
});

// ---------- Projetos (Codebases) ----------
const projectSchema = z.object({
  name: z.string().min(2),
  projectPath: z.string().min(2),
  description: z.string().optional().default(""),
  sshHost: z.string().optional().nullable(),
  sshPort: z.number().int().min(1).max(65535).optional().default(22),
  sshUser: z.string().optional().nullable(),
  sshAuthType: z.enum(["key", "password", "pm2"]).optional().default("pm2"),
  sshKeyPath: z.string().optional().nullable(),
  sshPassword: z.string().optional().nullable(),
  instructions: z.string().optional().nullable(),
});

commandCenterRouter.get("/projects", async (_req, res) => {
  res.json(await prisma.codebaseProject.findMany({ orderBy: { createdAt: "desc" } }));
});

commandCenterRouter.post("/projects", async (req, res) => {
  const data = projectSchema.parse(req.body);
  const project = await prisma.codebaseProject.create({ data });
  await audit.record("ui", "project.create", "CodebaseProject", project.id);
  res.status(201).json(project);
});

commandCenterRouter.put("/projects/:id", async (req, res) => {
  const data = projectSchema.partial().parse(req.body);
  const project = await prisma.codebaseProject.update({ where: { id: req.params.id }, data });
  await audit.record("ui", "project.update", "CodebaseProject", project.id);
  res.json(project);
});

commandCenterRouter.delete("/projects/:id", async (req, res) => {
  await prisma.codebaseProject.delete({ where: { id: req.params.id } });
  await audit.record("ui", "project.delete", "CodebaseProject", req.params.id);
  res.status(204).end();
});

commandCenterRouter.post("/projects/:id/analyze", async (req, res) => {
  const project = await prisma.codebaseProject.findUniqueOrThrow({ where: { id: req.params.id } });
  if (project.status === "ANALYZING") {
    return res.status(409).json({ error: "Projeto já está em análise" });
  }
  // Dispara a análise assíncrona (não aguarda)
  codebase.analyzeCodebase(project).catch(() => undefined);
  await prisma.codebaseProject.update({
    where: { id: project.id },
    data: { status: "ANALYZING", error: null },
  });
  await audit.record("ui", "project.analyze", "CodebaseProject", project.id);
  res.json({ ok: true, message: "Análise iniciada. Atualize a página para ver o resultado." });
});

commandCenterRouter.post("/projects/:id/ssh-test", async (req, res) => {
  const project = await prisma.codebaseProject.findUniqueOrThrow({ where: { id: req.params.id } });
  try {
    const result = await ssh.testConnection(project);
    await prisma.codebaseProject.update({
      where: { id: project.id },
      data: { sshConnected: result.success },
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
});

/** MCP Streamable HTTP/JSON-RPC básico para o Gerente e clientes externos. */
commandCenterRouter.post("/mcp", async (req, res) => {
  const { id, method, params } = req.body ?? {};
  try {
    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "aiops-command-center", version: "1.0.0" },
        },
      });
    }
    if (method === "tools/list") {
      return res.json({ jsonrpc: "2.0", id, result: { tools: manager.managerTools } });
    }
    if (method === "tools/call") {
      const result = await manager.callTool(String(params?.name), params?.arguments ?? {});
      return res.json({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      });
    }
    return res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Método não encontrado" } });
  } catch (error) {
    return res.status(500).json({
      jsonrpc: "2.0", id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    });
  }
});
