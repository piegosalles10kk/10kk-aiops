import PDFDocument from "pdfkit";
import * as glpi from "./glpi.service.js";

const STATUS_LABEL: Record<number, string> = {
  1: "Novo",
  2: "Em atendimento",
  3: "Planejado",
  4: "Pendente",
  5: "Solucionado",
  6: "Fechado",
};

const TYPE_LABEL: Record<number, string> = {
  1: "Incidente",
  2: "Requisição",
};

export type ReportDateBasis = "created" | "updated" | "solved";

export interface ReportFilters {
  start: Date;
  end: Date;
  dateBasis: ReportDateBasis;
  technicianIds: number[];
  includeUnassigned: boolean;
  statuses: number[];
  types: number[];
  includeDetails: boolean;
}

interface ReportTicket {
  id: number;
  title: string;
  description: string;
  status: number;
  statusLabel: string;
  type: number;
  typeLabel: string;
  priority: number | null;
  urgency: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  solvedAt: string | null;
  ageHours: number | null;
  resolutionHours: number | null;
  technicians: glpi.GlpiAssignedTech[];
  tasksTotal: number;
  tasksDone: number;
  followups: number;
  taskItems: Array<{ content: string; done: boolean; date: string | null }>;
  followupItems: Array<{ content: string; date: string | null }>;
  latestActivityAt: string | null;
}

function cleanHtml(value: string): string {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPdfText(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u00ff]/g, "")
    .replace(/Ø[^\s]*/g, "")
    .replace(/Â·/g, "|")
    .replace(/â€¢/g, "-")
    .replace(/â€”/g, "-")
    .replace(/â€“/g, "-")
    .replace(/Ã§/g, "c")
    .replace(/Ã£/g, "a")
    .replace(/Ã¡/g, "a")
    .replace(/Ã©/g, "e")
    .replace(/Ã³/g, "o")
    .replace(/Ã­/g, "i")
    .replace(/Ãº/g, "u")
    .replace(/Ãª/g, "e")
    .replace(/Ã´/g, "o")
    .replace(/Ã‡/g, "C")
    .replace(/\s+/g, " ")
    .trim();
}

function validDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ticketDate(ticket: glpi.GlpiTicketSummary, basis: ReportDateBasis): Date | null {
  if (basis === "updated") return validDate(ticket.date_mod ?? ticket.date);
  if (basis === "solved") return validDate(ticket.solvedate ?? ticket.closedate);
  return validDate(ticket.date_creation ?? ticket.date);
}

function hoursBetween(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  return Math.max(0, Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 10) / 10);
}

async function mapLimit<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export async function reportOptions(): Promise<{
  technicians: Array<{ id: number; username: string; name: string }>;
  statuses: Array<{ id: number; label: string }>;
  types: Array<{ id: number; label: string }>;
}> {
  const users = await glpi.listUsers();
  return {
    technicians: users
      .filter((user) => user.active)
      .map((user) => ({ id: user.id, username: user.username, name: user.displayName }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    statuses: Object.entries(STATUS_LABEL).map(([id, label]) => ({ id: Number(id), label })),
    types: Object.entries(TYPE_LABEL).map(([id, label]) => ({ id: Number(id), label })),
  };
}

export async function generateReport(filters: ReportFilters) {
  const raw = await glpi.listReportTickets();
  const dated = raw.filter((ticket) => {
    const date = ticketDate(ticket, filters.dateBasis);
    return date && date >= filters.start && date <= filters.end;
  });

  const enriched = await mapLimit(dated, 8, async (ticket): Promise<ReportTicket> => {
    const [technicians, tasks, followups] = await Promise.all([
      glpi.getAssignedTechs(ticket.id).catch(() => []),
      glpi.getTasks(ticket.id).catch(() => []),
      glpi.getFollowups(ticket.id).catch(() => []),
    ]);
    const created = validDate(ticket.date_creation ?? ticket.date);
    const updated = validDate(ticket.date_mod ?? ticket.date);
    const solved = validDate(ticket.solvedate ?? ticket.closedate);
    const activityDates = [
      updated,
      ...tasks.map((task) => validDate(task.date)),
      ...followups.map((followup) => validDate(followup.date)),
    ].filter((date): date is Date => Boolean(date));
    const latestActivity = activityDates.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    return {
      id: ticket.id,
      title: cleanHtml(ticket.name),
      description: cleanHtml(ticket.content).slice(0, 500),
      status: ticket.status,
      statusLabel: STATUS_LABEL[ticket.status] ?? `Status ${ticket.status}`,
      type: ticket.type,
      typeLabel: TYPE_LABEL[ticket.type] ?? `Tipo ${ticket.type}`,
      priority: ticket.priority ?? null,
      urgency: ticket.urgency ?? null,
      createdAt: created?.toISOString() ?? null,
      updatedAt: updated?.toISOString() ?? null,
      solvedAt: solved?.toISOString() ?? null,
      ageHours: hoursBetween(created, solved ?? new Date()),
      resolutionHours: hoursBetween(created, solved),
      technicians,
      tasksTotal: tasks.length,
      tasksDone: tasks.filter((task) => task.state === glpi.GLPI_TASK_STATE.DONE).length,
      followups: followups.length,
      taskItems: tasks.slice(0, 12).map((task) => ({
        content: cleanHtml(task.content).slice(0, 220),
        done: task.state === glpi.GLPI_TASK_STATE.DONE,
        date: validDate(task.date)?.toISOString() ?? null,
      })),
      followupItems: followups.slice(0, 8).map((followup) => ({
        content: cleanHtml(followup.content).slice(0, 260),
        date: validDate(followup.date)?.toISOString() ?? null,
      })),
      latestActivityAt: latestActivity?.toISOString() ?? null,
    };
  });

  const tickets = enriched
    .filter((ticket) => filters.statuses.length === 0 || filters.statuses.includes(ticket.status))
    .filter((ticket) => filters.types.length === 0 || filters.types.includes(ticket.type))
    .filter((ticket) => {
      if (filters.technicianIds.length === 0 && !filters.includeUnassigned) return true;
      const matches = ticket.technicians.some((tech) => filters.technicianIds.includes(tech.id));
      return matches || (filters.includeUnassigned && ticket.technicians.length === 0);
    })
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

  const resolved = tickets.filter((ticket) => ticket.status >= glpi.GLPI_TICKET_STATUS.SOLVED);
  const resolutionValues = resolved
    .map((ticket) => ticket.resolutionHours)
    .filter((value): value is number => value !== null);
  const activeAges = tickets
    .filter((ticket) => ticket.status < glpi.GLPI_TICKET_STATUS.SOLVED)
    .map((ticket) => ticket.ageHours)
    .filter((value): value is number => value !== null);

  const byStatus = Object.values(STATUS_LABEL).map((label) => ({
    label,
    count: tickets.filter((ticket) => ticket.statusLabel === label).length,
  })).filter((item) => item.count > 0);
  const byType = Object.values(TYPE_LABEL).map((label) => ({
    label,
    count: tickets.filter((ticket) => ticket.typeLabel === label).length,
  })).filter((item) => item.count > 0);

  const techMap = new Map<number | string, {
    id: number | null;
    name: string;
    tickets: Set<number>;
    active: Set<number>;
    resolved: Set<number>;
    tasks: number;
    tasksDone: number;
  }>();
  for (const ticket of tickets) {
    const owners = ticket.technicians.length
      ? ticket.technicians
      : [{ id: "unassigned" as const, name: "Não atribuído" }];
    for (const tech of owners) {
      const current = techMap.get(tech.id) ?? {
        id: typeof tech.id === "number" ? tech.id : null,
        name: tech.name,
        tickets: new Set<number>(),
        active: new Set<number>(),
        resolved: new Set<number>(),
        tasks: 0,
        tasksDone: 0,
      };
      current.tickets.add(ticket.id);
      if (ticket.status >= glpi.GLPI_TICKET_STATUS.SOLVED) current.resolved.add(ticket.id);
      else current.active.add(ticket.id);
      current.tasks += ticket.tasksTotal;
      current.tasksDone += ticket.tasksDone;
      techMap.set(tech.id, current);
    }
  }

  const byTechnician = [...techMap.values()]
    .map((tech) => ({
      id: tech.id,
      name: tech.name,
      tickets: tech.tickets.size,
      active: tech.active.size,
      resolved: tech.resolved.size,
      tasks: tech.tasks,
      tasksDone: tech.tasksDone,
    }))
    .sort((a, b) => b.tickets - a.tickets || a.name.localeCompare(b.name, "pt-BR"));

  const timelineMap = new Map<string, { opened: number; resolved: number }>();
  for (const ticket of tickets) {
    const createdKey = ticket.createdAt?.slice(0, 10);
    if (createdKey) {
      const row = timelineMap.get(createdKey) ?? { opened: 0, resolved: 0 };
      row.opened++;
      timelineMap.set(createdKey, row);
    }
    const solvedKey = ticket.solvedAt?.slice(0, 10);
    if (solvedKey) {
      const row = timelineMap.get(solvedKey) ?? { opened: 0, resolved: 0 };
      row.resolved++;
      timelineMap.set(solvedKey, row);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      start: filters.start.toISOString(),
      end: filters.end.toISOString(),
      dateBasis: filters.dateBasis,
      technicianIds: filters.technicianIds,
      includeUnassigned: filters.includeUnassigned,
      statuses: filters.statuses,
      types: filters.types,
      includeDetails: filters.includeDetails,
    },
    summary: {
      total: tickets.length,
      active: tickets.length - resolved.length,
      resolved: resolved.length,
      resolutionRate: tickets.length ? Math.round((resolved.length / tickets.length) * 1000) / 10 : 0,
      averageResolutionHours: resolutionValues.length
        ? Math.round((resolutionValues.reduce((sum, value) => sum + value, 0) / resolutionValues.length) * 10) / 10
        : null,
      averageActiveAgeHours: activeAges.length
        ? Math.round((activeAges.reduce((sum, value) => sum + value, 0) / activeAges.length) * 10) / 10
        : null,
      tasks: tickets.reduce((sum, ticket) => sum + ticket.tasksTotal, 0),
      tasksDone: tickets.reduce((sum, ticket) => sum + ticket.tasksDone, 0),
      followups: tickets.reduce((sum, ticket) => sum + ticket.followups, 0),
    },
    byStatus,
    byType,
    byTechnician,
    timeline: [...timelineMap.entries()]
      .map(([date, values]) => ({ date, ...values }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    tickets,
  };
}

/**
 * PDF genérico de uma execução de ferramenta (Visual / Pentest / Stress).
 * Renderiza o relatório em markdown de forma simples (títulos, listas, texto).
 */
export async function toolReportPdf(run: {
  kind: string;
  targetUrl: string | null;
  summary: string | null;
  report: string | null;
  totalTokens: number;
  createdAt: Date;
}): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, info: {
    Title: `Relatório ${run.kind} - AIOps`,
    Author: "AIOps Command Center",
  } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const dark = "#17202a";
  const green = "#20b778";
  const muted = "#667085";
  const labels: Record<string, string> = { VISUAL: "Regressão Visual", PENTEST: "Pentest", LOAD: "Teste de Carga" };

  doc.rect(0, 0, doc.page.width, 84).fill(dark);
  doc.fillColor(green).font("Helvetica-Bold").fontSize(11).text("AIOPS COMMAND CENTER", 48, 26);
  doc.fillColor("#ffffff").fontSize(20).text(labels[run.kind] ?? run.kind, 48, 44);
  doc.y = 104;
  doc.fillColor(muted).font("Helvetica").fontSize(9)
    .text(`Alvo: ${run.targetUrl ?? "-"}  ·  Tokens: ${run.totalTokens}  ·  ${new Date(run.createdAt).toLocaleString("pt-BR")}`);
  doc.moveDown(0.6);
  if (run.summary) {
    doc.fillColor(dark).font("Helvetica-Bold").fontSize(11).text(run.summary, { width: doc.page.width - 96 });
    doc.moveDown(0.6);
  }

  for (const rawLine of (run.report ?? "Sem relatório.").split("\n")) {
    const line = rawLine.replace(/\*\*/g, "").replace(/`/g, "");
    if (doc.y > doc.page.height - 60) doc.addPage();
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      const size = [16, 14, 12, 11][heading[1]!.length - 1] ?? 11;
      doc.moveDown(0.4).font("Helvetica-Bold").fontSize(size).fillColor(dark).text(heading[2]!);
    } else if (/^\s*[-*]\s+/.test(line)) {
      doc.font("Helvetica").fontSize(10).fillColor(dark).text(`•  ${line.replace(/^\s*[-*]\s+/, "")}`, { indent: 8, width: doc.page.width - 96 });
    } else if (line.trim()) {
      doc.font("Helvetica").fontSize(10).fillColor(dark).text(line, { width: doc.page.width - 96 });
    } else {
      doc.moveDown(0.3);
    }
  }

  const pages = doc.bufferedPageRange();
  for (let index = 0; index < pages.count; index++) {
    doc.switchToPage(index);
    doc.font("Helvetica").fontSize(8).fillColor(muted)
      .text(`AIOps Command Center | Pagina ${index + 1} de ${pages.count}`, 48, doc.page.height - 68, {
        width: doc.page.width - 96, align: "center", lineBreak: false,
      });
  }
  doc.end();
  return completed;
}

export async function generateReportPdfClean(
  data: Awaited<ReturnType<typeof generateReport>>,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: 44,
    bufferPages: true,
    info: { Title: "Relatorio de Chamados - AIOps", Author: "AIOps Command Center" },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const C = {
    dark: "#17202a",
    ink: "#253040",
    muted: "#667085",
    line: "#d9dee7",
    light: "#f6f8fb",
    white: "#ffffff",
    green: "#1fb87a",
    orange: "#e8922e",
    red: "#d94841",
    blue: "#3478c6",
    purple: "#8e63ce",
    teal: "#11a7a2",
  };
  const M = 44;
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const W = pageWidth - M * 2;
  const bottom = pageHeight - 52;

  function write(
    value: string,
    x: number,
    y: number,
    width: number,
    opts: { size?: number; bold?: boolean; color?: string; align?: "left" | "center" | "right" } = {},
  ) {
    const text = cleanPdfText(value);
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(opts.size ?? 9)
      .fillColor(opts.color ?? C.ink)
      .text(text, x, y, { width, align: opts.align ?? "left" });
  }

  function height(value: string, width: number, size = 9, bold = false): number {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
    return doc.heightOfString(cleanPdfText(value), { width });
  }

  function clamp(value: string, max: number): string {
    const text = cleanPdfText(value);
    return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
  }

  function ensure(minHeight: number) {
    if (doc.y + minHeight > bottom) doc.addPage();
  }

  function section(title: string) {
    ensure(42);
    doc.moveDown(0.7);
    write(title, M, doc.y, W, { size: 13, bold: true, color: C.dark });
    doc.moveTo(M, doc.y + 4).lineTo(pageWidth - M, doc.y + 4).lineWidth(1.2).strokeColor(C.green).stroke();
    doc.moveDown(0.8);
  }

  function metric(x: number, y: number, width: number, label: string, value: string, color: string) {
    doc.roundedRect(x, y, width, 58, 7).fillAndStroke(C.light, C.line);
    doc.roundedRect(x, y, width, 5, 4).fill(color);
    write(label.toUpperCase(), x + 9, y + 15, width - 18, { size: 7, color: C.muted });
    write(value, x + 9, y + 31, width - 18, { size: 15, bold: true, color: C.dark });
  }

  function barList(items: Array<{ label: string; count: number }>, x: number, y: number, width: number) {
    const max = Math.max(...items.map((item) => item.count), 1);
    const colors = [C.blue, C.green, C.orange, C.red, C.purple, C.teal, C.muted];
    let cy = y;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const labelWidth = 92;
      const barWidth = width - labelWidth - 34;
      const filled = Math.max(3, (item.count / max) * barWidth);
      write(clamp(item.label, 22), x, cy + 1, labelWidth, { size: 7.4, color: C.muted });
      doc.rect(x + labelWidth, cy + 1, barWidth, 10).fill("#edf1f6");
      doc.rect(x + labelWidth, cy + 1, filled, 10).fill(colors[i % colors.length]!);
      write(String(item.count), x + labelWidth + barWidth + 6, cy, 24, { size: 8, bold: true, color: C.dark });
      cy += 16;
    }
    return cy;
  }

  function header() {
    doc.rect(0, 0, pageWidth, 96).fill(C.dark);
    write("AIOPS COMMAND CENTER", M, 25, W, { size: 10, bold: true, color: C.green });
    write("Relatorio de Chamados", M, 43, W, { size: 25, bold: true, color: C.white });
    const basis = data.filters.dateBasis === "created"
      ? "Criacao"
      : data.filters.dateBasis === "updated"
        ? "Atualizacao"
        : "Solucao";
    write(`${formatDate(data.filters.start)} ate ${formatDate(data.filters.end)} | Base: ${basis}`, M, 76, W * 0.65, {
      size: 8,
      color: "#a9b5c2",
    });
    write(`Gerado: ${formatDate(data.generatedAt)}`, M, 76, W, { size: 8, color: "#a9b5c2", align: "right" });
    doc.y = 116;
  }

  function technicianTable() {
    section("Produtividade por tecnico");
    if (!data.byTechnician.length) {
      write("Nenhum tecnico com chamados no periodo.", M, doc.y, W, { size: 9, color: C.muted });
      doc.y += 18;
      return;
    }
    const cols = [
      { label: "Tecnico", width: 205, align: "left" as const },
      { label: "Chamados", width: 62, align: "center" as const },
      { label: "Ativos", width: 54, align: "center" as const },
      { label: "Resolvidos", width: 70, align: "center" as const },
      { label: "Tarefas", width: 62, align: "center" as const },
      { label: "Resol.", width: 50, align: "center" as const },
    ];
    const tableWidth = cols.reduce((sum, col) => sum + col.width, 0);
    ensure(24 + Math.min(data.byTechnician.length, 20) * 20);
    let x = M;
    const hy = doc.y;
    doc.roundedRect(M, hy, tableWidth, 20, 4).fill(C.dark);
    for (const col of cols) {
      write(col.label, x + 6, hy + 6, col.width - 12, { size: 7.2, bold: true, color: C.white, align: col.align });
      x += col.width;
    }
    doc.y = hy + 20;
    for (let i = 0; i < data.byTechnician.length; i++) {
      ensure(20);
      const row = data.byTechnician[i]!;
      const y = doc.y;
      const percent = row.tickets ? Math.round((row.resolved / row.tickets) * 100) : 0;
      if (i % 2 === 1) doc.rect(M, y, tableWidth, 20).fill(C.light);
      const values = [
        clamp(row.name, 36),
        String(row.tickets),
        String(row.active),
        String(row.resolved),
        `${row.tasksDone}/${row.tasks}`,
        `${percent}%`,
      ];
      x = M;
      for (let c = 0; c < cols.length; c++) {
        write(values[c]!, x + 6, y + 6, cols[c]!.width - 12, {
          size: 7.5,
          color: c === 5 ? (percent >= 80 ? C.green : C.orange) : C.ink,
          align: cols[c]!.align,
        });
        x += cols[c]!.width;
      }
      doc.y = y + 20;
    }
  }

  function ticketCardModel(ticket: (typeof data.tickets)[number], details: boolean) {
    const title = cleanPdfText(`#${ticket.id} - ${ticket.title}`);
    const summary = clamp(ticket.description || "Sem resumo registrado.", 360);
    const tasks = ticket.taskItems.slice(0, 5).map((task) => ({
      done: task.done,
      content: clamp(task.content, 96),
    }));
    const followups = ticket.followupItems.slice(0, 3).map((followup) => ({
      content: clamp(followup.content, 108),
    }));
    const titleHeight = Math.min(height(title, W - 120, 9.6, true), 24);
    if (!details) return { title, summary, tasks, followups, titleHeight, height: 58 + titleHeight };
    const summaryHeight = Math.min(height(summary, W - 28, 8), 34);
    const taskHeight = 21 + Math.max(12, tasks.length * 11) + (ticket.taskItems.length > 5 ? 10 : 0);
    const followupHeight = 21 + Math.max(12, followups.length * 14);
    return {
      title,
      summary,
      tasks,
      followups,
      titleHeight,
      summaryHeight,
      height: 76 + titleHeight + summaryHeight + taskHeight + followupHeight,
    };
  }

  function ticketCard(ticket: (typeof data.tickets)[number], details: boolean) {
    const model = ticketCardModel(ticket, details);
    const cardHeight = Math.min(model.height, bottom - M);
    ensure(cardHeight + 8);
    const y = doc.y;
    const statusColor = ticket.statusLabel === "Solucionado" || ticket.statusLabel === "Fechado"
      ? C.green
      : ticket.statusLabel === "Pendente"
        ? C.muted
        : ticket.statusLabel === "Em atendimento"
          ? C.orange
          : C.blue;
    doc.roundedRect(M, y, W, cardHeight, 8).fillAndStroke("#fbfcfe", C.line);
    doc.rect(M, y, 5, cardHeight).fill(statusColor);

    const x = M + 14;
    const inner = W - 28;
    doc.font("Helvetica-Bold").fontSize(9.6).fillColor(C.dark)
      .text(model.title, x, y + 11, { width: inner - 88, height: model.titleHeight, ellipsis: true });
    write(ticket.statusLabel, x + inner - 82, y + 12, 72, { size: 7.5, bold: true, color: statusColor, align: "right" });
    const techs = ticket.technicians.map((tech) => tech.name).join(", ") || "Nao atribuido";
    const metaY = y + 14 + model.titleHeight;
    write(`${ticket.typeLabel} | Tecnico: ${clamp(techs, 58)}`, x, metaY, inner, { size: 7.5, color: C.muted });
    write(
      `Criado: ${formatDate(ticket.createdAt)} | Tempo: ${formatDuration(ticket.resolutionHours ?? ticket.ageHours)} | Tarefas: ${ticket.tasksDone}/${ticket.tasksTotal} | Acomp.: ${ticket.followups}`,
      x,
      metaY + 12,
      inner,
      { size: 7.1, color: C.muted },
    );

    let cy = metaY + 31;
    if (details) {
      write("Resumo", x, cy, inner, { size: 8, bold: true, color: C.dark });
      cy += 11;
      const summaryHeight = model.summaryHeight ?? 34;
      doc.font("Helvetica").fontSize(8).fillColor(C.ink)
        .text(model.summary, x, cy, { width: inner, height: summaryHeight, ellipsis: true });
      cy += summaryHeight + 9;

      write(`Tarefas (${ticket.tasksDone}/${ticket.tasksTotal})`, x, cy, inner, { size: 8, bold: true, color: C.dark });
      cy += 12;
      if (model.tasks.length) {
        for (const task of model.tasks) {
          write(`${task.done ? "[x]" : "[ ]"} ${task.content}`, x + 4, cy, inner - 8, {
            size: 7.1,
            color: task.done ? C.green : C.ink,
          });
          cy += 11;
        }
      } else {
        write("Sem tarefas registradas.", x + 4, cy, inner - 8, { size: 7.1, color: C.muted });
        cy += 11;
      }
      if (ticket.taskItems.length > 5) {
        write(`+ ${ticket.taskItems.length - 5} tarefas omitidas.`, x + 4, cy, inner - 8, { size: 7, color: C.muted });
        cy += 10;
      }

      cy += 4;
      write(`Acompanhamentos (${ticket.followups})`, x, cy, inner, { size: 8, bold: true, color: C.dark });
      cy += 12;
      if (model.followups.length) {
        for (const followup of model.followups) {
          write(`- ${followup.content}`, x + 4, cy, inner - 8, { size: 7.1, color: C.ink });
          cy += 14;
        }
      } else {
        write("Sem acompanhamentos registrados.", x + 4, cy, inner - 8, { size: 7.1, color: C.muted });
      }
    }
    doc.y = y + cardHeight + 8;
  }

  header();
  const gap = 8;
  const cardWidth = (W - gap * 4) / 5;
  const metricsY = doc.y;
  const metrics = [
    ["Chamados", String(data.summary.total), C.blue],
    ["Ativos", String(data.summary.active), C.orange],
    ["Resolvidos", String(data.summary.resolved), C.green],
    ["Taxa", `${data.summary.resolutionRate}%`, data.summary.resolutionRate >= 80 ? C.green : C.red],
    ["Tempo medio", formatDuration(data.summary.averageResolutionHours), C.purple],
  ] as const;
  for (let i = 0; i < metrics.length; i++) {
    const item = metrics[i]!;
    metric(M + i * (cardWidth + gap), metricsY, cardWidth, item[0], item[1], item[2]);
  }
  doc.y = metricsY + 76;

  section("Resumo executivo");
  const mode = data.filters.includeDetails
    ? "PDF detalhado: inclui resumo, tarefas e acompanhamentos por chamado."
    : "PDF compacto: oculta resumo, tarefas e acompanhamentos por chamado.";
  [
    `Chamados no periodo: ${data.summary.total}. Ativos: ${data.summary.active}. Resolvidos: ${data.summary.resolved}.`,
    `Tempo medio de resolucao: ${formatDuration(data.summary.averageResolutionHours)}. Idade media dos ativos: ${formatDuration(data.summary.averageActiveAgeHours)}.`,
    `Atividades registradas: ${data.summary.tasksDone}/${data.summary.tasks} tarefas concluidas e ${data.summary.followups} acompanhamentos.`,
    mode,
  ].forEach((line) => {
    write(line, M, doc.y, W, { size: 9, color: C.ink });
    doc.y += 15;
  });

  section("Distribuicao");
  const chartWidth = (W - 18) / 2;
  const chartY = doc.y;
  write("Por status", M, chartY, chartWidth, { size: 8, bold: true, color: C.muted });
  const statusEnd = barList(data.byStatus, M, chartY + 15, chartWidth);
  write("Por tipo", M + chartWidth + 18, chartY, chartWidth, { size: 8, bold: true, color: C.muted });
  const typeEnd = barList(data.byType, M + chartWidth + 18, chartY + 15, chartWidth);
  doc.y = Math.max(statusEnd, typeEnd) + 8;

  technicianTable();

  section(data.filters.includeDetails ? "Chamados do periodo - detalhado" : "Chamados do periodo - compacto");
  if (!data.tickets.length) {
    write("Nenhum chamado corresponde aos filtros selecionados.", M, doc.y, W, { size: 9, color: C.muted });
  } else {
    for (const ticket of data.tickets) ticketCard(ticket, data.filters.includeDetails);
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.font("Helvetica")
      .fontSize(7.5)
      .fillColor(C.muted)
      .text(`AIOps Command Center | Pagina ${i + 1} de ${range.count}`, M, doc.page.height - 68, {
        width: W,
        align: "center",
        lineBreak: false,
      });
  }

  doc.end();
  return completed;
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("pt-BR") : "-";
}

function formatDuration(hours: number | null): string {
  if (hours === null) return "-";
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)} dias`;
}

export async function generateReportPdf(
  data: Awaited<ReturnType<typeof generateReport>>,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, info: {
    Title: "Relatório de Chamados - AIOps",
    Author: "AIOps Command Center",
  } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const C = {
    green: "#20b778", dark: "#17202a", muted: "#667085",
    line: "#d9dee7", white: "#ffffff", bg: "#f8f9fa",
    red: "#e74c3c", orange: "#f39c12", blue: "#3498db",
    purple: "#9b59b6", teal: "#1abc9c",
  };
  const ML = 42;
  const PW = doc.page.width;
  const W = PW - ML * 2;
  const BOTTOM = doc.page.height - 48;

  function nextPage() { doc.addPage(); }

  function fit(h: number) {
    if (doc.y + h > BOTTOM) nextPage();
  }

  function sec(title: string) {
    fit(44);
    doc.moveDown(0.5).font("Helvetica-Bold").fontSize(13).fillColor(C.dark).text(title);
    doc.moveTo(ML, doc.y + 3).lineTo(PW - ML, doc.y + 3).lineWidth(1.5).strokeColor(C.green).stroke();
    doc.moveDown(0.6);
  }

  function rowBg(y: number) {
    doc.rect(ML, y, W, 18).fill(C.bg);
  }

  function cell(text: string, x: number, y: number, w: number, bold?: boolean, color?: string, size?: number, align?: string) {
    doc.fillColor(color ?? C.dark).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size ?? 8)
      .text(text, x, y, { width: w, align: (align as "left" | "center" | "right") ?? "left", ellipsis: true });
  }

  // ═══════════════ HEADER ═══════════════════════════════════════════════════
  doc.rect(0, 0, PW, 100).fill(C.dark);
  doc.fillColor(C.green).font("Helvetica-Bold").fontSize(10).text("AIOPS COMMAND CENTER", ML, 26);
  doc.fillColor(C.white).fontSize(26).text("Relatório de Chamados", ML, 44);

  const basisLabel = data.filters.dateBasis === "created" ? "Criação"
    : data.filters.dateBasis === "updated" ? "Atualização" : "Solução";
  doc.fillColor("#8899aa").font("Helvetica").fontSize(8)
    .text(`${formatDate(data.filters.start)}  →  ${formatDate(data.filters.end)}  ·  Base: ${basisLabel}`, ML, 78);
  doc.text(`Gerado: ${formatDate(data.generatedAt)}`, ML, 78, { align: "right" });

  // ═══════════════ METRICS CARDS ════════════════════════════════════════════
  doc.y = 126;
  const gap = 8;
  const cw = (W - gap * 3) / 4;
  const my = doc.y + 12;
  const cards = [
    { label: "Chamados", value: String(data.summary.total), color: C.blue },
    { label: "Ativos", value: String(data.summary.active), color: C.orange },
    { label: "Resolvidos", value: String(data.summary.resolved), color: C.green },
    { label: "Taxa Resolução", value: `${data.summary.resolutionRate}%`, color: data.summary.resolutionRate >= 80 ? C.green : C.red },
  ];
  for (let i = 0; i < cards.length; i++) {
    const cx = ML + (cw + gap) * i;
    doc.roundedRect(cx, my, cw, 62, 6).fillAndStroke(C.bg, C.line);
    doc.rect(cx, my, cw, 4).fill(cards[i]!.color);
    cell(cards[i]!.label.toUpperCase(), cx + 10, my + 14, cw - 20, false, C.muted, 7);
    cell(cards[i]!.value, cx + 10, my + 32, cw - 20, true, C.dark, 18);
  }
  doc.y = my + 76;

  // ═══════════════ EXECUTIVE SUMMARY ════════════════════════════════════════
  sec("Resumo Executivo");
  const rows = [
    ["Tempo médio de resolução", formatDuration(data.summary.averageResolutionHours)],
    ["Idade média dos chamados ativos", formatDuration(data.summary.averageActiveAgeHours)],
    ["Tarefas concluídas", `${data.summary.tasksDone} de ${data.summary.tasks}`],
    ["Acompanhamentos registrados", String(data.summary.followups)],
  ];
  const sy0 = doc.y;
  for (let i = 0; i < rows.length; i++) {
    const sx = ML + (i % 2) * (W / 2);
    const sy = sy0 + Math.floor(i / 2) * 24;
    cell(rows[i]![0]!, sx, sy, W / 2 - 16, false, C.muted, 8);
    cell(rows[i]![1]!, sx, sy + 11, W / 2 - 16, true, C.dark, 12);
  }
  doc.y = sy0 + 56;

  // ═══════════════ DISTRIBUTION ═════════════════════════════════════════════
  sec("Distribuição");

  const chartColors = [C.blue, C.green, C.orange, C.red, C.purple, C.teal, C.muted];
  const chartW = (W - 20) / 2;

  function drawBars(items: { label: string; count: number }[], x: number, max: number, lw: number) {
    let cy = doc.y;
    for (const item of items) {
      const bw = max > 0 ? (item.count / max) * (chartW - lw - 34) : 0;
      cell(item.label, x, cy, lw, false, C.muted, 7.5);
      doc.rect(x + lw + 2, cy, Math.max(bw, 2), 12).fill(chartColors[items.indexOf(item) % chartColors.length]!);
      cell(String(item.count), x + lw + 6 + Math.max(bw, 2), cy - 1, 24, true, C.dark, 8, "left");
      cy += 17;
    }
    return cy;
  }

  fit(Math.max(data.byStatus.length, data.byType.length) * 18 + 12);
  cell("POR STATUS", ML, doc.y, 100, true, C.muted, 8);
  doc.y += 14;
  const se = drawBars(data.byStatus, ML, Math.max(...data.byStatus.map((s) => s.count), 1), 90);
  const tx = ML + chartW + 20;
  cell("POR TIPO", tx, doc.y - 14, 80, true, C.muted, 8);
  drawBars(data.byType, tx, Math.max(...data.byType.map((t) => t.count), 1), 70);
  doc.y = Math.max(se, doc.y) + 4;

  // ═══════════════ TECHNICIAN PRODUCTIVITY ══════════════════════════════════
  sec("Produtividade por Técnico");

  if (!data.byTechnician.length) {
    cell("Nenhum técnico com chamados no período.", ML, doc.y, W, false, C.muted, 10);
    doc.y += 16;
  } else {
    const tc = [
      { x: ML, w: 170, a: "left" as const },
      { x: ML + 174, w: 56, a: "center" as const },
      { x: ML + 234, w: 48, a: "center" as const },
      { x: ML + 286, w: 56, a: "center" as const },
      { x: ML + 346, w: 56, a: "center" as const },
      { x: ML + 406, w: 48, a: "center" as const },
    ];
    fit(data.byTechnician.length * 18 + 22);

    let hy = doc.y;
    doc.rect(ML, hy, W, 18).fill(C.dark);
    const hdrs = ["Técnico", "Chamados", "Ativos", "Resolvidos", "Tarefas", "Rend."];
    for (let i = 0; i < hdrs.length; i++) {
      cell(hdrs[i]!, tc[i]!.x, hy + 4, tc[i]!.w, true, C.white, 7.5, tc[i]!.a);
    }
    doc.y = hy + 18;

    for (let i = 0; i < data.byTechnician.length; i++) {
      fit(18);
      const ry = doc.y;
      const t = data.byTechnician[i]!;
      const pct = t.tickets > 0 ? Math.round((t.resolved / t.tickets) * 100) : 0;
      if (i % 2 === 1) rowBg(ry);
      cell(t.name, tc[0]!.x, ry + 3, tc[0]!.w, false, C.dark, 8);
      cell(String(t.tickets), tc[1]!.x, ry + 3, tc[1]!.w, false, C.dark, 8, "center");
      cell(String(t.active), tc[2]!.x, ry + 3, tc[2]!.w, false, C.dark, 8, "center");
      cell(String(t.resolved), tc[3]!.x, ry + 3, tc[3]!.w, false, C.dark, 8, "center");
      cell(`${t.tasksDone}/${t.tasks}`, tc[4]!.x, ry + 3, tc[4]!.w, false, C.dark, 8, "center");
      cell(`${pct}%`, tc[5]!.x, ry + 3, tc[5]!.w, false, pct >= 80 ? C.green : C.orange, 8, "center");
      doc.y = ry + 18;
    }
    doc.y += 4;
  }

  // ═══════════════ TICKET LISTING ═══════════════════════════════════════════
  sec("Chamados do Período");

  if (!data.tickets.length) {
    cell("Nenhum chamado corresponde aos filtros selecionados.", ML, doc.y, W, false, C.muted, 10);
    doc.y += 16;
  } else {
    const sc: Record<string, string> = {
      Novo: C.blue, "Em atendimento": C.orange, Planejado: C.purple,
      Pendente: C.muted, Solucionado: C.green, Fechado: C.dark,
    };
    const det = data.filters.includeDetails;
    const tc = det
      ? [
          { x: ML, w: 28, a: "center" as const },
          { x: ML + 30, w: 136, a: "left" as const },
          { x: ML + 168, w: 50, a: "center" as const },
          { x: ML + 220, w: 54, a: "center" as const },
          { x: ML + 276, w: 64, a: "left" as const },
          { x: ML + 342, w: 48, a: "center" as const },
          { x: ML + 392, w: 62, a: "left" as const },
          { x: ML + 456, w: 56, a: "left" as const },
        ]
      : [
          { x: ML, w: 30, a: "center" as const },
          { x: ML + 32, w: 198, a: "left" as const },
          { x: ML + 232, w: 58, a: "center" as const },
          { x: ML + 292, w: 58, a: "center" as const },
          { x: ML + 352, w: 86, a: "left" as const },
          { x: ML + 440, w: 54, a: "center" as const },
        ];
    const hdr = det
      ? ["#", "Título", "Tipo", "Status", "Técnico", "Tempo", "Criação", "Atividade"]
      : ["#", "Título", "Tipo", "Status", "Técnico", "Tempo"];

    fit(data.tickets.length * 18 + 22);

    let th = doc.y;
    doc.rect(ML, th, W, 18).fill(C.dark);
    for (let i = 0; i < hdr.length; i++) {
      cell(hdr[i]!, tc[i]!.x, th + 4, tc[i]!.w, true, C.white, 7, tc[i]!.a);
    }
    doc.y = th + 18;

    for (let i = 0; i < data.tickets.length; i++) {
      fit(18);
      const tr = doc.y;
      const ticket = data.tickets[i]!;
      if (i % 2 === 1) rowBg(tr);
      doc.rect(ML, tr, 3, 18).fill(sc[ticket.statusLabel] ?? C.muted);
      cell(String(ticket.id), tc[0]!.x, tr + 3, tc[0]!.w, false, C.muted, 7.5, "center");
      cell(ticket.title.slice(0, det ? 30 : 40), tc[1]!.x, tr + 3, tc[1]!.w, false, C.dark, 7.5);
      cell(ticket.typeLabel, tc[2]!.x, tr + 3, tc[2]!.w, false, C.dark, 7.5, "center");
      cell(ticket.statusLabel, tc[3]!.x, tr + 3, tc[3]!.w, false, sc[ticket.statusLabel] ?? C.dark, 7.5, "center");
      cell(ticket.technicians.map((t) => t.name).join(", ").slice(0, 12) || "-", tc[4]!.x, tr + 3, tc[4]!.w, false, C.muted, 7);
      cell(formatDuration(ticket.resolutionHours ?? ticket.ageHours), tc[5]!.x, tr + 3, tc[5]!.w, false, C.dark, 7.5, "center");
      if (det) {
        cell(formatDate(ticket.createdAt).slice(0, 10), tc[6]!.x, tr + 3, tc[6]!.w, false, C.muted, 7);
        cell(formatDate(ticket.latestActivityAt).slice(0, 10), tc[7]!.x, tr + 3, tc[7]!.w, false, C.muted, 7);
      }
      doc.y = tr + 18;
    }
    doc.y += 4;
  }

  // ═══════════════ PAGE NUMBERS ═════════════════════════════════════════════
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.font("Helvetica").fontSize(7.5).fillColor(C.muted)
      .text(`AIOps Command Center | Pagina ${i + 1} de ${range.count}`, ML, doc.page.height - 68, {
        width: W, align: "center", lineBreak: false,
      });
  }

  doc.end();
  return completed;
}
