import { createHash } from "node:crypto";
import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponse,
  type Schema,
} from "@google/genai";
import { ApprovalStatus } from "@prisma/client";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { errorSummary } from "../utils/retry.js";
import * as approval from "./approval.service.js";
import * as chatAccounts from "./chat-account.service.js";
import * as code from "./code.service.js";
import * as glpi from "./glpi.service.js";
import * as grafana from "./grafana.service.js";
import * as knowledge from "./knowledge.service.js";
import * as loki from "./loki.service.js";
import * as plan from "./plan.service.js";
import * as ssh from "./ssh.service.js";
import * as telegram from "./telegram.service.js";
import * as usage from "./usage.service.js";
import * as visualTest from "./visual-test.service.js";
import * as pentest from "./pentest.service.js";
import * as loadtest from "./loadtest.service.js";

export interface ManagerModelOption {
  id: string;
  name: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

let modelCache: { expiresAt: number; models: ManagerModelOption[] } | null = null;

export async function listManagerModels(): Promise<ManagerModelOption[]> {
  if (modelCache && modelCache.expiresAt > Date.now()) return modelCache.models;

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const pager = await ai.models.list({ config: { queryBase: true, pageSize: 100 } });
  const models: ManagerModelOption[] = [];

  for await (const model of pager) {
    if (!model.name || !model.supportedActions?.includes("generateContent")) continue;
    const id = model.name.replace(/^models\//, "");
    models.push({
      id,
      name: model.displayName || id,
      description: model.description,
      inputTokenLimit: model.inputTokenLimit,
      outputTokenLimit: model.outputTokenLimit,
    });
  }

  const unique = [...new Map(models.map((model) => [model.id, model])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!unique.some((model) => model.id === env.MANAGER_MODEL)) {
    unique.unshift({ id: env.MANAGER_MODEL, name: env.MANAGER_MODEL });
  }
  modelCache = { expiresAt: Date.now() + 5 * 60_000, models: unique };
  return unique;
}

// ---------------------------------------------------------------------------
// Tools expostas via MCP (/api/mcp). plan_confirm fica fora do MCP de
// propósito: a confirmação explícita só é validável no fluxo de chat.
// ---------------------------------------------------------------------------

export const managerTools = [
  {
    name: "tickets_list",
    description: "Lista os chamados recentes do GLPI",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ticket_get",
    description: "Obtém o conteúdo completo de um chamado",
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "number" } },
      required: ["ticketId"],
    },
  },
  {
    name: "ticket_comment",
    description: "Adiciona comentário a um chamado",
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "number" }, text: { type: "string" } },
      required: ["ticketId", "text"],
    },
  },
  {
    name: "ticket_assign_agent",
    description: "Atribui chamado a um agente",
    inputSchema: {
      type: "object",
      properties: { ticketId: { type: "number" }, agentId: { type: "string" } },
      required: ["ticketId", "agentId"],
    },
  },
  {
    name: "telegram_send",
    description: "Envia uma mensagem pelo Telegram",
    inputSchema: {
      type: "object",
      properties: { chatId: { type: "string" }, text: { type: "string" } },
      required: ["chatId", "text"],
    },
  },
  {
    name: "search_knowledge",
    description: "Pesquisa na base de conhecimento vetorial (RAG) por chamados anteriores similares ao texto informado.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Descrição do problema ou termo de busca (mínimo 3 caracteres)" },
        limit: { type: "number", description: "Quantidade máxima de resultados (padrão 6, máximo 15)" },
      },
      required: ["query"],
    },
  },
  {
    name: "ssh_exec",
    description:
      "Executa um comando shell em um servidor remoto (se projectName informado) " +
      "ou localmente no host do middleware (se projectName omitido). " +
      "Use para verificar status de serviços, logs (docker logs, journalctl), " +
      "processos, uso de disco, Docker (docker ps, docker stats), " +
      "health checks e qualquer depuração no servidor do projeto ou no próprio ambiente do middleware. " +
      "Quando executado localmente (sem projectName), tem acesso ao Docker Desktop, " +
      "aos containers do middleware (aiops_middleware) e GLPI, e ao sistema de arquivos do host.",
    inputSchema: {
      type: "object",
      properties: {
        projectName: { type: "string", description: "Nome do projeto cadastrado (de code_projects). Opcional — se omitido, executa localmente no host do middleware." },
        command: { type: "string", description: "Comando shell completo para executar" },
      },
      required: ["command"],
    },
  },
  {
    name: "project_update",
    description:
      "Atualiza as configurações de UM projeto cadastrado: host SSH, porta, usuário, " +
      "tipo de autenticação, chave/password SSH, descrição ou caminho da pasta. " +
      "Use code_projects primeiro para ver os projetos disponíveis e valores atuais. " +
      "Exemplo: alterar IP do SSH para um projeto.",
    inputSchema: {
      type: "object",
      properties: {
        projectName: { type: "string", description: "Nome do projeto a atualizar (de code_projects)" },
        sshHost: { type: "string", description: "Novo host/IP SSH. Vazio para remover." },
        sshPort: { type: "number", description: "Nova porta SSH (padrão 22)" },
        sshUser: { type: "string", description: "Novo usuário SSH (ex: root)" },
        sshAuthType: { type: "string", description: "Tipo: pm2, key ou password" },
        sshKeyPath: { type: "string", description: "Caminho da chave privada SSH" },
        sshPassword: { type: "string", description: "Senha SSH (se authType = password)" },
        description: { type: "string", description: "Nova descrição do projeto" },
        projectPath: { type: "string", description: "Novo caminho da pasta no Windows" },
      },
      required: ["projectName"],
    },
  },
];

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "tickets_list") return glpi.listRecentTickets();
  if (name === "ticket_get") return glpi.getTicketContext(Number(args.ticketId));
  if (name === "ticket_comment") {
    return glpi.addFollowup(Number(args.ticketId), String(args.text));
  }
  if (name === "ticket_assign_agent") {
    const agent = await prisma.agent.findUnique({ where: { id: String(args.agentId) } });
    if (!agent?.glpiUserId) throw new Error("Agente sem conta GLPI");
    await glpi.assignUser(Number(args.ticketId), agent.glpiUserId);
    return { assigned: true, ticketId: args.ticketId, agent: agent.name };
  }
  if (name === "telegram_send") {
    await telegram.sendMessage(String(args.chatId), String(args.text));
    return { sent: true };
  }
  if (name === "search_knowledge") {
    const query = String(args.query ?? "");
    const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 15);
    return { results: await knowledge.searchKnowledge(query, limit) };
  }
  if (name === "ssh_exec") {
    const projectName = String(args.projectName ?? "").trim();
    const command = String(args.command ?? "").trim();
    if (!command) throw new Error("Informe o comando a executar.");
    const project = projectName
      ? await prisma.codebaseProject.findFirst({ where: { name: { equals: projectName, mode: "insensitive" } } })
      : null;
    if (projectName && !project) throw new Error(`Projeto "${projectName}" não encontrado.`);
    const target = project ?? { sshAuthType: "pm2" as const, projectPath: ".", sshHost: null, sshPort: 22, sshUser: null, sshKeyPath: null, sshPassword: null };
    const result = await ssh.execCommand(target, command, 60_000);
    const strip = (s: string) => s.replace(/\x1B\[[\d;]*[A-Za-z]/g, "").replace(/\r/g, "").trim();
    return { project: project?.name ?? "host", command, success: result.success, stdout: strip(result.stdout ?? "").slice(0, 10_000), stderr: strip(result.stderr ?? "").slice(0, 5_000), exitCode: result.exitCode, durationMs: result.durationMs };
  }
  if (name === "project_update") {
    const projectName = String(args.projectName ?? "").trim();
    if (!projectName) throw new Error("Informe o nome do projeto.");
    const project = await prisma.codebaseProject.findFirst({
      where: { name: { equals: projectName, mode: "insensitive" } },
    });
    if (!project) throw new Error(`Projeto "${projectName}" não encontrado.`);
    const data: Record<string, unknown> = {};
    if (args.sshHost !== undefined) data.sshHost = String(args.sshHost).trim() || null;
    if (args.sshPort !== undefined) data.sshPort = Number(args.sshPort);
    if (args.sshUser !== undefined) data.sshUser = String(args.sshUser).trim() || null;
    if (args.sshAuthType !== undefined) data.sshAuthType = String(args.sshAuthType).trim();
    if (args.sshKeyPath !== undefined) data.sshKeyPath = String(args.sshKeyPath).trim() || null;
    if (args.sshPassword !== undefined) data.sshPassword = String(args.sshPassword).trim() || null;
    if (args.description !== undefined) data.description = String(args.description).trim();
    if (args.projectPath !== undefined) data.projectPath = String(args.projectPath).trim();
    await prisma.codebaseProject.update({ where: { id: project.id }, data });
    return { atualizado: true, project: project.name, sshHost: data.sshHost ?? project.sshHost, sshPort: data.sshPort ?? project.sshPort, sshUser: data.sshUser ?? project.sshUser, sshAuthType: data.sshAuthType ?? project.sshAuthType };
  }
  if (name === "tickets_comment_multi" || name === "tickets_solve_multi") {
    const ticketIds = (Array.isArray(args.ticketIds) ? args.ticketIds : [Number(args.ticketId)])
      .map(Number).filter((id) => Number.isInteger(id) && id > 0);
    if (name === "tickets_comment_multi") {
      const comentario = String(args.comentario ?? "").trim();
      if (!comentario) throw new Error("O comentário está vazio.");
      const results: Array<{ ticketId: number; ok: boolean; erro?: string }> = [];
      for (const ticketId of ticketIds) {
        try { await glpi.addFollowup(ticketId, comentario); results.push({ ticketId, ok: true }); }
        catch (error) { results.push({ ticketId, ok: false, erro: String(error) }); }
      }
      return { processados: results.length, sucesso: results.filter((r) => r.ok).map((r) => r.ticketId), falhas: results.filter((r) => r.erro) };
    }
    const solucao = String(args.solucao ?? "").trim();
    if (!solucao) throw new Error("A nota de solução está vazia.");
    const results: Array<{ ticketId: number; ok: boolean; erro?: string }> = [];
    for (const ticketId of ticketIds) {
      try { await glpi.solveTicket(ticketId, solucao); results.push({ ticketId, ok: true }); }
      catch (error) { results.push({ ticketId, ok: false, erro: String(error) }); }
    }
    return { processados: results.length, sucesso: results.filter((r) => r.ok).map((r) => r.ticketId), falhas: results.filter((r) => r.erro) };
  }
  throw new Error(`Tool desconhecida: ${name}`);
}

// ---------------------------------------------------------------------------
// Function calling nativo do Gemini (fluxo de chat do Gerente)
// ---------------------------------------------------------------------------

const PLAN_ITEM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    ordem: { type: Type.NUMBER, description: "Posição sugerida de execução (1, 2, 3...)" },
    titulo: { type: Type.STRING },
    descricao: { type: Type.STRING, description: "Descrição completa do que deve ser feito" },
    criteriosAceite: { type: Type.ARRAY, items: { type: Type.STRING } },
    prioridade: { type: Type.STRING, enum: ["baixa", "media", "alta", "critica"] },
    dependeDe: {
      type: Type.ARRAY,
      items: { type: Type.NUMBER },
      description: "Ordens dos itens dos quais este depende",
    },
    responsavel: { type: Type.STRING, description: "Agente ou pessoa sugerida" },
  },
  required: ["ordem", "titulo", "descricao"],
} satisfies Schema;

const FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "tickets_list",
    description: "Lista os chamados recentes do GLPI (id, título, status, tipo).",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "ticket_get",
    description: "Obtém o conteúdo completo de um chamado do GLPI.",
    parameters: {
      type: Type.OBJECT,
      properties: { ticketId: { type: Type.NUMBER } },
      required: ["ticketId"],
    },
  },
  {
    name: "ticket_comment",
    description: "Adiciona um comentário (followup) a um chamado do GLPI.",
    parameters: {
      type: Type.OBJECT,
      properties: { ticketId: { type: Type.NUMBER }, text: { type: Type.STRING } },
      required: ["ticketId", "text"],
    },
  },
  {
    name: "ticket_create",
    description:
      "Cria UM chamado avulso no GLPI com título e descrição. Use quando o usuário pedir para " +
      "abrir/criar um chamado único (ex.: registrar uma pesquisa, demanda ou problema discutido). " +
      "Para uma SEQUÊNCIA de chamados planejados, use plan_propose/plan_confirm.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        titulo: { type: Type.STRING, description: "Título curto e claro do chamado" },
        descricao: {
          type: Type.STRING,
          description:
            "Descrição COMPLETA. Inclua todo o conteúdo relevante já produzido na conversa " +
            "(ex.: a pesquisa feita, critérios de aceite), sem resumir demais.",
        },
        tipo: { type: Type.STRING, description: "'incidente' ou 'requisicao' (default requisicao)" },
        urgencia: { type: Type.NUMBER, description: "1 (muito baixa) a 5 (muito alta); default 3" },
        atribuirParaMim: {
          type: Type.BOOLEAN,
          description: "true para atribuir o chamado à conta GLPI vinculada a esta conversa",
        },
      },
      required: ["titulo", "descricao"],
    },
  },
  {
    name: "agents_list",
    description: "Lista os agentes cadastrados (nome, modo, se têm conta GLPI).",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "glpi_users_list",
    description:
      "Lista as contas humanas ativas disponíveis no GLPI. Use para descobrir o username " +
      "ou confirmar uma pessoa antes de atribuir um chamado.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "tickets_by_glpi_user",
    description:
      "Lista os chamados recentes atribuídos a um técnico humano específico do GLPI, " +
      "independentemente da conta vinculada à conversa. Use para 'o que Diego está fazendo?', " +
      "'quais chamados estão com Carla?' ou consultas de carga por responsável.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        username: { type: Type.STRING, description: "Username GLPI do técnico" },
        userName: { type: Type.STRING, description: "Nome do técnico, se o username não for conhecido" },
        includeClosed: { type: Type.BOOLEAN, description: "Inclui solucionados e fechados; default false" },
      },
    },
  },
  {
    name: "manager_requests_status",
    description:
      "Consulta as perguntas enviadas a técnicos e informa se já houve resposta. " +
      "Use para 'ele respondeu?', 'a Carla informou?' ou 'qual foi o retorno do Diego?'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        username: { type: Type.STRING },
        userName: { type: Type.STRING },
      },
    },
  },
  {
    name: "message_glpi_user",
    description:
      "Envia uma mensagem direta a uma pessoa pelos canais Slack e/ou Telegram vinculados " +
      "à conta GLPI dela. Use para cobranças, lembretes e avisos solicitados pelo usuário.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        username: { type: Type.STRING, description: "Username GLPI da pessoa" },
        userName: { type: Type.STRING, description: "Nome da pessoa, se o username não for conhecido" },
        text: { type: Type.STRING, description: "Mensagem completa a enviar" },
        ticketId: { type: Type.NUMBER, description: "Chamado relacionado, quando houver" },
      },
      required: ["text"],
    },
  },
  {
    name: "plan_propose",
    description:
      "Registra (ou substitui) o RASCUNHO do plano de chamados deste canal. " +
      "Use depois de entender o objetivo e sempre que o usuário pedir ajustes. " +
      "NÃO cria nada no GLPI — apenas salva a proposta para revisão.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        objetivo: { type: Type.STRING, description: "Objetivo geral do plano" },
        itens: { type: Type.ARRAY, items: PLAN_ITEM_SCHEMA },
      },
      required: ["objetivo", "itens"],
    },
  },
  {
    name: "plan_show",
    description: "Retorna o plano em rascunho deste canal, se existir.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "plan_cancel",
    description: "Descarta o plano em rascunho deste canal.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "plan_confirm",
    description:
      "Cria no GLPI os chamados (tipo Requisição) do plano em rascunho. " +
      "Chame SOMENTE quando a mensagem atual do usuário aprovar explicitamente o plano final.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "code_projects",
    description: "Lista os projetos de código-fonte disponíveis (caminho + agentes vinculados).",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "code_tree",
    description: "Lista a estrutura de arquivos de um projeto (sempre o estado atual do disco).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        projectPath: { type: Type.STRING, description: "Caminho do projeto (de code_projects)" },
        maxDepth: { type: Type.NUMBER, description: "Profundidade máxima (default 4)" },
      },
      required: ["projectPath"],
    },
  },
  {
    name: "code_read",
    description: "Lê o conteúdo atual de um arquivo do projeto.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        projectPath: { type: Type.STRING },
        filePath: { type: Type.STRING, description: "Caminho relativo dentro do projeto" },
      },
      required: ["projectPath", "filePath"],
    },
  },
  {
    name: "code_search",
    description: "Busca um trecho de texto nos arquivos do projeto (retorna arquivo, linha e conteúdo).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        projectPath: { type: Type.STRING },
        query: { type: Type.STRING, description: "Texto a procurar (mínimo 3 caracteres)" },
      },
      required: ["projectPath", "query"],
    },
  },
  {
    name: "search_knowledge",
    description: "Pesquisa na base de conhecimento vetorial (RAG) por chamados anteriores similares ao texto informado. Retorna contexto detalhado dos chamados mais relevantes, incluindo descrição, comentários, tarefas e técnicos envolvidos. Útil para depuração, encontrar soluções de problemas parecidos e entender o histórico de tickets.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Descrição do problema ou termo de busca (mínimo 3 caracteres)" },
        limit: { type: Type.NUMBER, description: "Quantidade máxima de resultados (padrão 6, máximo 15)" },
      },
      required: ["query"],
    },
  },
  {
    name: "ssh_exec",
    description:
      "Executa um comando shell em um servidor remoto (se projectName informado) " +
      "ou localmente no host do middleware (se projectName omitido). " +
      "Use para verificar status de serviços, logs (docker logs, journalctl), " +
      "processos, uso de disco, Docker (docker ps, docker stats), " +
      "health checks e qualquer depuração no servidor do projeto ou no próprio " +
      "ambiente do middleware. Quando executado localmente (sem projectName), " +
      "tem acesso ao Docker Desktop e aos containers do middleware e GLPI.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        projectName: { type: Type.STRING, description: "Nome do projeto (opcional — se omitido, executa localmente no host do middleware)" },
        command: { type: Type.STRING, description: "Comando shell completo para executar" },
      },
      required: ["command"],
    },
  },
  {
    name: "project_update",
    description:
      "Atualiza as configurações de UM projeto cadastrado: host SSH, porta, usuário, " +
      "tipo de autenticação, chave/password SSH, descrição ou caminho da pasta. " +
      "Use code_projects primeiro para ver os projetos disponíveis e valores atuais.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        projectName: { type: Type.STRING, description: "Nome do projeto a atualizar (de code_projects)" },
        sshHost: { type: Type.STRING, description: "Novo host/IP SSH. Vazio para remover." },
        sshPort: { type: Type.NUMBER, description: "Nova porta SSH (padrão 22)" },
        sshUser: { type: Type.STRING, description: "Novo usuário SSH (ex: root)" },
        sshAuthType: { type: Type.STRING, description: "Tipo: pm2, key ou password" },
        sshKeyPath: { type: Type.STRING, description: "Caminho da chave privada SSH" },
        sshPassword: { type: Type.STRING, description: "Senha SSH (se authType = password)" },
        description: { type: Type.STRING, description: "Nova descrição do projeto" },
        projectPath: { type: Type.STRING, description: "Novo caminho da pasta no Windows" },
      },
      required: ["projectName"],
    },
  },
  {
    name: "ticket_assign_agent",
    description:
      "Atribui (ou reatribui) um chamado a um agente, pelo nome do agente. " +
      "Remove agentes anteriores, atribui o novo e destrava o reprocessamento. " +
      "Use para 'atribua o chamado #N ao agente X' ou 'passe para o Claude'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticketId: { type: Type.NUMBER },
        agentName: { type: Type.STRING, description: "Nome do agente (ex.: Claude, Code)" },
      },
      required: ["ticketId", "agentName"],
    },
  },
  {
    name: "ticket_delegate_agent",
    description:
      "Delega um trabalho a um agente automático: registra a instrução no chamado e atribui " +
      "o chamado ao agente para execução no próximo ciclo. Use para pedidos como " +
      "'no chamado #39, pede pro Claude subir para homologação'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticketId: { type: Type.NUMBER },
        agentName: { type: Type.STRING },
        instruction: { type: Type.STRING, description: "Instrução completa para o agente executar" },
      },
      required: ["ticketId", "agentName", "instruction"],
    },
  },
  {
    name: "ticket_assign_glpi_user",
    description:
      "Atribui um chamado a uma conta humana do GLPI. Para pedidos como 'coloque no meu nome', " +
      "use self=true e a conta vinculada a esta conversa será usada. Para outra pessoa, informe " +
      "username ou nome. Não use ticket_assign_agent para usuários humanos.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticketId: { type: Type.NUMBER },
        self: { type: Type.BOOLEAN, description: "true quando o usuário disser 'meu nome' ou 'para mim'" },
        username: { type: Type.STRING, description: "Username GLPI da pessoa" },
        userName: { type: Type.STRING, description: "Nome de exibição da pessoa, se o username não for conhecido" },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "logs_services",
    description:
      "Lista os serviços (valores do label service_name) que enviam logs ao Loki/Grafana. " +
      "Use para descobrir o que pode ser consultado antes de pedir logs.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "logs_query",
    description:
      "Consulta os logs reais no Grafana/Loki sob demanda. Filtra por serviço/ambiente, " +
      "janela de tempo e texto. Use quando o usuário perguntar sobre erros, falhas ou logs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        service: { type: Type.STRING, description: "service_name (opcional; veja logs_services)" },
        environment: { type: Type.STRING, description: "prod, homolog etc. (opcional)" },
        filter: { type: Type.STRING, description: "texto/regex a procurar nas linhas (opcional)" },
        onlyErrors: { type: Type.BOOLEAN, description: "só erros/exceções/timeouts/5xx" },
        minutes: { type: Type.NUMBER, description: "janela em minutos até agora (default 30)" },
        limit: { type: Type.NUMBER, description: "máximo de linhas (default 100)" },
      },
    },
  },
  {
    name: "metrics_query",
    description:
      "Executa uma consulta PromQL no Prometheus através do Grafana. Use para CPU, memória, " +
      "disco, disponibilidade, taxa HTTP, latência, containers e outras métricas.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        expression: { type: Type.STRING, description: "Expressão PromQL completa" },
      },
      required: ["expression"],
    },
  },
  {
    name: "security_events_query",
    description:
      "Consulta eventos reais do Wazuh/OpenSearch através do Grafana. Use para alertas SIEM, " +
      "agentes, regras, níveis de severidade, MITRE e eventos de segurança.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Consulta Lucene/OpenSearch, por exemplo rule.level:[12 TO 15]",
        },
        minutes: { type: Type.NUMBER, description: "Janela em minutos, default 60" },
        limit: { type: Type.NUMBER, description: "Máximo de eventos, default 50" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_search",
    description:
      "Pesquisa informações atualizadas na internet (Google) e retorna um resumo com as fontes. " +
      "Use para preços, planos, documentação de fornecedores, comparativos de produtos, notícias " +
      "e qualquer dúvida sobre o mundo externo que as outras ferramentas não cobrem.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "O que pesquisar, em linguagem natural e com contexto suficiente",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "my_tickets",
    description:
      "Lista os chamados atribuídos à pessoa DESTA conversa (quando o chat tem conta GLPI). " +
      "Use para saber de qual chamado a pessoa está falando.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "ticket_attach",
    description:
      "Anexa ao chamado os arquivos que a pessoa enviou nesta mensagem (imagens, documentos). " +
      "Use quando ela mandar mídia para registrar no chamado.",
    parameters: {
      type: Type.OBJECT,
      properties: { ticketId: { type: Type.NUMBER } },
      required: ["ticketId"],
    },
  },
  {
    name: "ticket_task",
    description:
      "Cria uma TAREFA (TicketTask) no chamado — diferente de comentário. " +
      "Use quando a pessoa pedir explicitamente uma 'tarefa'. done=true cria já concluída.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticketId: { type: Type.NUMBER },
        descricao: { type: Type.STRING, description: "Descrição da tarefa" },
        done: { type: Type.BOOLEAN, description: "true = tarefa concluída; false = pendente" },
      },
      required: ["ticketId", "descricao"],
    },
  },
  {
    name: "ticket_tasks_create",
    description:
      "Cria várias tarefas no mesmo chamado em uma única operação. Use quando o usuário " +
      "pedir duas ou mais tarefas. Cada item pode ser criado pendente ou concluído.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticketId: { type: Type.NUMBER },
        tasks: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              descricao: { type: Type.STRING },
              done: { type: Type.BOOLEAN },
            },
            required: ["descricao"],
          },
        },
      },
      required: ["ticketId", "tasks"],
    },
  },
  {
    name: "ticket_solve",
    description:
      "Marca o chamado como Solucionado no GLPI com uma nota de solução. " +
      "Use quando a pessoa disser que terminou / pode finalizar.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticketId: { type: Type.NUMBER },
        solucao: { type: Type.STRING, description: "Resumo do que foi feito" },
      },
      required: ["ticketId", "solucao"],
    },
  },
  {
    name: "tickets_bulk_comment_solve",
    description:
      "Adiciona o mesmo comentário e soluciona vários chamados em uma única operação administrativa. " +
      "Use quando o usuário disser 'todos esses chamados', 'esses incidentes' ou listar vários IDs e " +
      "pedir para comentar/documentar a causa e depois finalizar/solucionar. Não exige que os chamados " +
      "estejam atribuídos à conta humana do chat, pois usa a conta técnica da integração.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticketIds: {
          type: Type.ARRAY,
          items: { type: Type.NUMBER },
          description: "IDs de todos os chamados mencionados ou listados no contexto imediato.",
        },
        comentario: {
          type: Type.STRING,
          description: "Comentário fiel à causa ou justificativa informada pelo usuário.",
        },
        solucao: {
          type: Type.STRING,
          description: "Nota de solução. Pode repetir a causa com uma conclusão operacional.",
        },
      },
      required: ["ticketIds", "comentario", "solucao"],
    },
  },
  {
    name: "tickets_comment_multi",
    description:
      "Adiciona o MESMO comentário a VÁRIOS chamados em uma única operação. " +
      "Use quando o usuário listar vários IDs e pedir para colocar o mesmo comentário " +
      "(ex.: 'coloca esse comentário nos chamados 5, 8, 12'). " +
      "Não exige atribuição prévia, pois usa a conta técnica da integração.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticketIds: {
          type: Type.ARRAY,
          items: { type: Type.NUMBER },
          description: "IDs de todos os chamados que devem receber o comentário.",
        },
        comentario: { type: Type.STRING, description: "O comentário a ser registrado em cada chamado." },
      },
      required: ["ticketIds", "comentario"],
    },
  },
  {
    name: "tickets_solve_multi",
    description:
      "Soluciona VÁRIOS chamados de uma vez com a mesma nota de solução. " +
      "Use quando o usuário disser 'finaliza os chamados X, Y, Z' ou " +
      "'encerra esses chamados' listando IDs. " +
      "Não exige atribuição prévia, pois usa a conta técnica da integração.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticketIds: {
          type: Type.ARRAY,
          items: { type: Type.NUMBER },
          description: "IDs de todos os chamados a solucionar.",
        },
        solucao: { type: Type.STRING, description: "Nota de solução comum a todos." },
      },
      required: ["ticketIds", "solucao"],
    },
  },
  {
    name: "runs_recent",
    description:
      "Lista as execuções (one-shot) recentes dos agentes: agente, tipo, status, " +
      "duração, chamado. Use para ver o andamento e quais falharam.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          description: "Filtro opcional: SUCCEEDED, FAILED, TIMED_OUT, RUNNING, QUEUED",
        },
        limit: { type: Type.NUMBER, description: "Quantidade (default 15)" },
      },
    },
  },
  {
    name: "run_get",
    description:
      "Detalha uma execução de agente: saída completa, erro, código de saída e prompt. " +
      "Use para triar uma falha. Sem id, pega a execução mais recente (ou a mais recente do chamado informado).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        runId: { type: Type.STRING, description: "Id da execução (de runs_recent)" },
        ticketId: { type: Type.NUMBER, description: "Alternativa: pega a execução mais recente deste chamado" },
      },
    },
  },
  {
    name: "approvals_list",
    description:
      "Lista as pendências de aprovação dos agentes (chamados onde um agente foi " +
      "bloqueado por falta de permissão e aguarda aval humano).",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "approval_resolve",
    description:
      "Aprova ou nega a pendência de um chamado. Aprovar reexecuta o agente com " +
      "permissões elevadas. Use apenas quando o usuário pedir claramente.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ticketId: { type: Type.NUMBER, description: "Número do chamado GLPI com a pendência" },
        decision: { type: Type.STRING, enum: ["aprovar", "negar"] },
      },
      required: ["ticketId", "decision"],
    },
  },
  {
    name: "visual_regression_test",
    description:
      "Roda um teste de REGRESSÃO VISUAL (Playwright) numa aplicação web alvo e gera relatório. " +
      "Use para 'rode o teste visual', 'tira print das telas', 'verifica se a UI quebrou'. " +
      "Informe targetUrl ou configure TOOLS_DEFAULT_URL nas Configurações. A execução roda " +
      "em segundo plano — responda com o link da aba Ferramentas › Visual.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetUrl: { type: Type.STRING, description: "URL base da aplicação alvo (obrigatório se não houver default configurado)" },
        repoPath: { type: Type.STRING, description: "Caminho do repositório do alvo, relativo à raiz do runner" },
        screens: { type: Type.STRING, description: "'all' para todas as telas, ou o nome de uma tela (login, inbox, crm, financeiro, campanhas, configuracoes, calendario, automacoes)" },
      },
    },
  },
  {
    name: "pentest",
    description:
      "Roda um PENTEST (segurança) na aplicação alvo: cabeçalhos, CORS, TLS, cookies, vazamento em erros, " +
      "webhook sem HMAC, rate limit de login e (opcional) OWASP ZAP. Gera relatório com plano de correção. " +
      "Use para 'faz um pentest', 'testa a segurança'. Roda em segundo plano — responda com o link da aba Ferramentas › Pentest.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetUrl: { type: Type.STRING, description: "URL base do alvo (obrigatório se não houver default configurado)" },
        projectId: { type: Type.STRING, description: "ID UUID do projeto cadastrado para análise estática (SAST) e de dependências (SCA). Se omitido, roda só DAST." },
        zap: { type: Type.BOOLEAN, description: "true para também rodar o OWASP ZAP baseline (requer Docker no host)" },
        authorized: { type: Type.BOOLEAN, description: "true autoriza sondas ativas (brute force) em alvo público; só com permissão explícita" },
      },
    },
  },
  {
    name: "load_test",
    description:
      "Roda um TESTE DE CARGA/ESTRESSE (k6) na API alvo, mede p50/p95/p99 e ponto de ruptura, e gera relatório. " +
      "Use para 'teste de stress', 'simula carga', 'aguenta quantos usuários'. Roda em segundo plano — responda " +
      "com o link da aba Ferramentas › Stress.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetUrl: { type: Type.STRING, description: "URL base da API alvo (obrigatório se não houver default configurado)" },
        repoPath: { type: Type.STRING, description: "Caminho do repositório do alvo" },
        scenario: { type: Type.STRING, description: "Cenário: baseline (10VU/2m), pico (50VU/5m), thundering (100VU/30s), sustained (30VU/30m) ou cpu (80VU/5m)" },
      },
    },
  },
];

/** Confirmação explícita do usuário na mensagem ATUAL (guard determinístico). */
const CONFIRM_REGEX =
  /\b(confirm\w*|aprov\w*|autoriz\w*|pode criar|pode gravar|pode mandar|cria(?:r)?\s+(?:os\s+)?chamados|manda ver|vai em frente|sim|ok|beleza|fechado|fechou)\b/i;

interface ToolContext {
  channel: string;
  userMessage: string;
  /** Anexos da mensagem atual (para anexar a chamados via ticket_attach). */
  attachments: ChatAttachment[];
}

/** Normaliza texto para comparação de comentários (ignora espaços/caixa). */
function normForCompare(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Já existe um followup com o mesmo conteúdo neste chamado? (anti-duplicação) */
async function commentAlreadyExists(ticketId: number, text: string): Promise<boolean> {
  const snippet = normForCompare(text).slice(0, 100);
  if (snippet.length < 12) return false;
  try {
    const followups = await glpi.getFollowups(ticketId);
    return followups.some((f) => normForCompare(f.content ?? "").includes(snippet));
  } catch {
    return false;
  }
}

async function findActiveGlpiUser(args: Record<string, unknown>) {
  const users = (await glpi.listUsers()).filter((user) => user.active);
  const wanted = String(args.username ?? args.userName ?? "").trim().toLowerCase();
  if (!wanted) return { user: null, options: [] as typeof users };

  const exact =
    users.find((item) => item.username.toLowerCase() === wanted) ??
    users.find((item) => item.displayName.toLowerCase() === wanted);
  if (exact) return { user: exact, options: [] as typeof users };

  const options = users.filter(
    (item) =>
      item.displayName.toLowerCase().includes(wanted) ||
      item.username.toLowerCase().includes(wanted),
  );
  return { user: options.length === 1 ? options[0] : null, options };
}

function explicitlyTargetsTicket(message: string, ticketId: number, action: RegExp): boolean {
  const mentionsTicket = new RegExp(`(?:chamado|ticket|#)\\s*#?${ticketId}\\b`, "i").test(message);
  return mentionsTicket && action.test(message);
}

function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, max = 240): string {
  const clean = plainText(value);
  return clean.length > max ? `${clean.slice(0, max - 1).trim()}…` : clean;
}

function estimateTicketProgress(input: {
  status: number;
  tasks: glpi.GlpiTask[];
  followups: glpi.GlpiFollowup[];
  latestRun?: { status: string; output: string | null; error: string | null } | null;
}): { percent: number; confidence: "baixa" | "média" | "alta"; basis: string[] } {
  if (input.status >= glpi.GLPI_TICKET_STATUS.SOLVED) {
    return { percent: 100, confidence: "alta", basis: ["Chamado solucionado ou fechado no GLPI."] };
  }

  const statusBaseline: Record<number, number> = {
    [glpi.GLPI_TICKET_STATUS.NEW]: 10,
    [glpi.GLPI_TICKET_STATUS.ASSIGNED]: 35,
    [glpi.GLPI_TICKET_STATUS.PLANNED]: 25,
    [glpi.GLPI_TICKET_STATUS.PENDING]: 80,
  };
  let percent = statusBaseline[input.status] ?? 15;
  const basis = [`Status atual: ${GLPI_STATUS_LABEL[input.status] ?? input.status}.`];
  let evidence = 1;

  if (input.tasks.length > 0) {
    const done = input.tasks.filter((task) => task.state === glpi.GLPI_TASK_STATE.DONE).length;
    const ratio = done / input.tasks.length;
    const taskEstimate = 15 + Math.round(ratio * 75);
    percent = Math.round(percent * 0.35 + taskEstimate * 0.65);
    basis.push(`${done} de ${input.tasks.length} tarefas concluídas.`);
    evidence += 2;
  }

  if (input.latestRun) {
    const runFloor: Record<string, number> = {
      SUCCEEDED: 75,
      RUNNING: 50,
      QUEUED: 30,
      FAILED: 30,
      TIMED_OUT: 40,
    };
    percent = Math.max(percent, runFloor[input.latestRun.status] ?? percent);
    basis.push(`Última execução de agente: ${input.latestRun.status}.`);
    evidence += 2;
  }

  if (input.followups.length > 0) {
    basis.push(`${input.followups.length} acompanhamentos registrados.`);
    evidence += 1;
  }

  if (input.status === glpi.GLPI_TICKET_STATUS.NEW) percent = Math.min(percent, 25);
  if (input.status === glpi.GLPI_TICKET_STATUS.ASSIGNED) percent = Math.min(percent, 75);
  if (input.status === glpi.GLPI_TICKET_STATUS.PLANNED) percent = Math.min(percent, 60);
  if (input.status === glpi.GLPI_TICKET_STATUS.PENDING) percent = Math.max(70, Math.min(percent, 95));

  return {
    percent: Math.max(5, Math.min(Math.round(percent / 5) * 5, 95)),
    confidence: evidence >= 5 ? "alta" : evidence >= 3 ? "média" : "baixa",
    basis,
  };
}

async function routePendingManagerResponse(
  channel: string,
  message: string,
): Promise<{ requesterChannel: string; targetName: string; question: string } | null> {
  if (!message.trim()) return null;
  const account = await chatAccounts.getAccountByChannel(channel);
  if (!account) return null;

  const pending = await prisma.managerRequest.findFirst({
    where: {
      targetGlpiUserId: account.glpiUserId,
      status: "PENDING",
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) return null;

  await prisma.managerRequest.update({
    where: { id: pending.id },
    data: {
      status: "ANSWERED",
      response: message.trim(),
      answeredChannel: channel,
      answeredAt: new Date(),
    },
  });

  const ticket = pending.ticketId ? ` sobre o chamado #${pending.ticketId}` : "";
  const forwarded = [
    `📬 Retorno de ${pending.targetName}${ticket}`,
    "",
    `Pergunta enviada: ${pending.question}`,
    "",
    `Resposta: ${message.trim()}`,
  ].join("\n");
  await approval.notifyChannel(pending.requesterChannel, forwarded).catch(() => undefined);
  await prisma.managerMessage.create({
    data: {
      channel: pending.requesterChannel,
      role: "assistant",
      content: forwarded,
      metadata: {
        source: "manager_response",
        requestId: pending.id,
        fromChannel: channel,
        targetUsername: pending.targetUsername,
      },
    },
  });
  return {
    requesterChannel: pending.requesterChannel,
    targetName: pending.targetName,
    question: pending.question,
  };
}

async function actionAuthor(
  ctx: ToolContext,
  ticketId: number,
  action: RegExp,
): Promise<number | undefined> {
  if (hasNoWriteIntent(ctx.userMessage)) {
    throw new Error("A mensagem atual proíbe alterações nos chamados.");
  }
  const account = await chatAccounts.getAccountByChannel(ctx.channel);
  if (!account) return undefined;
  if (await chatAccounts.canManageTicket(ctx.channel, ticketId)) return account.glpiUserId;
  if (explicitlyTargetsTicket(ctx.userMessage, ticketId, action)) return undefined;
  throw new Error(`O chamado #${ticketId} não está atribuído à conta GLPI desta conversa.`);
}

// ---------------------------------------------------------------------------
// Context caching: as regras fixas do Gerente + declarações de ferramentas são
// cacheadas na API do Gemini (TTL 1h). As requisições seguintes pagam ~10% do
// preço de entrada sobre essa parte. Qualquer falha cai para o fluxo sem cache.
// ---------------------------------------------------------------------------

const MANAGER_CACHE_TTL_SECONDS = 3600;
let managerCacheState: { key: string; name: string; expiresAt: number } | null = null;
let cacheUnavailableUntil = 0;

function contextCacheEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(
    String(env.MANAGER_CONTEXT_CACHE_ENABLED).toLowerCase().trim(),
  );
}

async function getManagerContextCache(
  ai: GoogleGenAI,
  model: string,
  staticInstruction: string,
): Promise<string | null> {
  if (!contextCacheEnabled() || Date.now() < cacheUnavailableUntil) return null;
  const key = createHash("sha256")
    .update(model)
    .update(staticInstruction)
    .update(FUNCTION_DECLARATIONS.map((f) => f.name).join(","))
    .digest("hex");
  // Renova com 2 min de folga antes do TTL expirar
  if (managerCacheState?.key === key && managerCacheState.expiresAt > Date.now() + 120_000) {
    return managerCacheState.name;
  }
  try {
    const cache = await ai.caches.create({
      model,
      config: {
        displayName: "aiops-manager-rules",
        systemInstruction: staticInstruction,
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
        ttl: `${MANAGER_CACHE_TTL_SECONDS}s`,
      },
    });
    if (!cache.name) throw new Error("cache criado sem nome");
    managerCacheState = {
      key,
      name: cache.name,
      expiresAt: Date.now() + MANAGER_CACHE_TTL_SECONDS * 1000,
    };
    logger.info({ model, cache: cache.name }, "Context cache do Gerente criado");
    return cache.name;
  } catch (error) {
    // Modelo sem suporte ou bloco abaixo do mínimo de tokens: opera sem cache
    cacheUnavailableUntil = Date.now() + 6 * 60 * 60_000;
    logger.warn(
      { err: errorSummary(error), model },
      "Context caching indisponível; seguindo sem cache por 6h",
    );
    return null;
  }
}

/**
 * Pesquisa na web via grounding (Google Search) do Gemini. A API não permite
 * combinar googleSearch com functionDeclarations na mesma requisição, então a
 * pesquisa roda numa chamada aninhada e o resultado volta como tool response.
 */
async function runWebSearch(query: string): Promise<unknown> {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const models = [...new Set([env.MANAGER_MODEL, env.GEMINI_MODEL, "gemini-2.5-flash"])];
  let lastError: unknown;

  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: query }] }],
        config: {
          tools: [{ googleSearch: {} }],
          systemInstruction:
            "Pesquise na web e responda em português, de forma objetiva e factual. " +
            "Inclua valores, datas e nomes exatos encontrados nas fontes.",
        },
      });
      void usage.record({ model, feature: "manager", usage: response.usageMetadata });

      const text = (response.text ?? "").trim();
      if (!text) continue;

      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const fontes = [
        ...new Map(
          chunks
            .filter((chunk) => chunk.web?.uri)
            .map((chunk) => [chunk.web!.uri!, { titulo: chunk.web?.title ?? "", url: chunk.web!.uri! }]),
        ).values(),
      ].slice(0, 8);

      return { resultado: text, fontes };
    } catch (error) {
      lastError = error;
      logger.warn({ err: errorSummary(error), model }, "web_search falhou neste modelo, tentando o próximo");
    }
  }
  return { erro: `A pesquisa na web falhou: ${errorSummary(lastError)}` };
}

/** Ferramentas que escrevem no GLPI — usadas no guard de "não altere" e no anti-alucinação de ação. */
const TICKET_MUTATION_TOOLS = new Set([
  "ticket_create",
  "ticket_comment",
  "ticket_attach",
  "ticket_task",
  "ticket_tasks_create",
  "ticket_solve",
  "tickets_bulk_comment_solve",
  "tickets_comment_multi",
  "tickets_solve_multi",
  "ticket_assign_agent",
  "ticket_assign_glpi_user",
  "ticket_delegate_agent",
]);

export function allowsBulkCommentAndSolve(message: string): boolean {
  if (hasNoWriteIntent(message)) return false;
  const hasBulkReference =
    /\b(?:todos?\s+(?:esses?|estes?|os)|esses?|estes?)\s+(?:chamados?|tickets?|incidentes?)\b/i.test(message) ||
    (message.match(/#\d+/g)?.length ?? 0) >= 2;
  const asksComment = /\b(?:coment\w*|registr\w*|document\w*|coloc\w*)\b/i.test(message);
  const asksSolve = /\b(?:finaliz\w*|solucion\w*|fech\w*|encerr\w*)\b/i.test(message);
  return hasBulkReference && asksComment && asksSolve;
}

async function executeManagerFunction(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  if (TICKET_MUTATION_TOOLS.has(name) && hasNoWriteIntent(ctx.userMessage)) {
    return {
      erro: "A mensagem atual proíbe alterações nos chamados. Nenhuma ação foi executada.",
    };
  }

  if (name === "agents_list") {
    const agents = await prisma.agent.findMany({ where: { enabled: true } });
    return agents.map((a) => ({
      id: a.id,
      nome: a.name,
      modo: a.mode,
      descricao: a.description,
      temContaGlpi: Boolean(a.glpiUserId),
    }));
  }

  if (name === "glpi_users_list") {
    const accounts = await prisma.chatAccount.findMany();
    const channelsByUser = new Map<number, string[]>();
    for (const account of accounts) {
      const channels = channelsByUser.get(account.glpiUserId) ?? [];
      channels.push(account.channel);
      channelsByUser.set(account.glpiUserId, channels);
    }
    return (await glpi.listUsers())
      .filter((user) => user.active)
      .map((user) => ({
        id: user.id,
        username: user.username,
        nome: user.displayName,
        canaisVinculados: channelsByUser.get(user.id) ?? [],
      }));
  }

  if (name === "tickets_by_glpi_user") {
    const { user, options } = await findActiveGlpiUser(args);
    if (!user) {
      return options.length > 1
        ? {
            erro: "Encontrei mais de uma pessoa. Informe o username GLPI exato.",
            opcoes: options.slice(0, 10).map((item) => ({
              username: item.username,
              nome: item.displayName,
            })),
          }
        : { erro: `Não encontrei a pessoa "${args.username ?? args.userName ?? ""}" no GLPI.` };
    }

    const includeClosed = Boolean(args.includeClosed);
    const tickets = await glpi.listRecentTickets();
    const assigned: Array<{
      chamado: number;
      tituloOriginal: string;
      resumo: string;
      atividadeAtual: string;
      status: string | number;
      tipo: string;
      progressoEstimado: number;
      confiancaEstimativa: string;
      baseEstimativa: string[];
      proximoPasso: string;
    }> = [];
    for (const ticket of tickets) {
      if (!includeClosed && ticket.status >= glpi.GLPI_TICKET_STATUS.SOLVED) continue;
      const userIds = await glpi.getAssignedUserIds(ticket.id).catch((): number[] => []);
      if (!userIds.includes(user.id)) continue;
      const [tasks, followups, latestRun] = await Promise.all([
        glpi.getTasks(ticket.id).catch((): glpi.GlpiTask[] => []),
        glpi.getFollowups(ticket.id).catch((): glpi.GlpiFollowup[] => []),
        prisma.agentRun.findFirst({
          where: { glpiTicketId: ticket.id },
          orderBy: { createdAt: "desc" },
          select: { status: true, output: true, error: true },
        }),
      ]);
      const progress = estimateTicketProgress({
        status: ticket.status,
        tasks,
        followups,
        latestRun,
      });
      const pendingTask = tasks.find((task) => task.state !== glpi.GLPI_TASK_STATE.DONE);
      const latestFollowup = [...followups]
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
      const latestRunText = latestRun ? truncate(latestRun.output || latestRun.error || "", 220) : "";
      const activity =
        (pendingTask && `Tarefa pendente: ${truncate(pendingTask.content, 220)}`) ||
        (latestRunText && `Última execução do agente: ${latestRunText}`) ||
        (latestFollowup && `Última atualização: ${truncate(latestFollowup.content, 220)}`) ||
        "Ainda não há atividade detalhada registrada.";
      const nextStep =
        pendingTask
          ? truncate(pendingTask.content, 180)
          : ticket.status === glpi.GLPI_TICKET_STATUS.PENDING
            ? "Revisão ou validação humana antes da conclusão."
            : tasks.length > 0 && tasks.every((task) => task.state === glpi.GLPI_TASK_STATE.DONE)
              ? "Validar o resultado e decidir pela solução do chamado."
              : "Registrar uma próxima tarefa ou atualização de andamento.";
      assigned.push({
        chamado: ticket.id,
        tituloOriginal: ticket.name,
        resumo: truncate(ticket.content || ticket.name, 280),
        atividadeAtual: activity,
        status: GLPI_STATUS_LABEL[ticket.status] ?? ticket.status,
        tipo: ticket.type === glpi.GLPI_TICKET_TYPE.REQUEST ? "Requisição" : "Incidente",
        progressoEstimado: progress.percent,
        confiancaEstimativa: progress.confidence,
        baseEstimativa: progress.basis,
        proximoPasso: nextStep,
      });
    }
    return {
      tecnico: user.displayName,
      username: user.username,
      total: assigned.length,
      chamados: assigned,
    };
  }

  if (name === "manager_requests_status") {
    const { user, options } = await findActiveGlpiUser(args);
    if (!user) {
      return options.length > 1
        ? {
            erro: "Encontrei mais de uma pessoa. Informe o username GLPI exato.",
            opcoes: options.slice(0, 10).map((item) => ({
              username: item.username,
              nome: item.displayName,
            })),
          }
        : { erro: `Não encontrei a pessoa "${args.username ?? args.userName ?? ""}" no GLPI.` };
    }
    const requests = await prisma.managerRequest.findMany({
      where: {
        requesterChannel: ctx.channel,
        targetGlpiUserId: user.id,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return {
      tecnico: user.displayName,
      solicitacoes: requests.map((request) => ({
        pergunta: request.question,
        chamado: request.ticketId,
        status: request.status,
        resposta: request.response,
        enviadaEm: request.createdAt,
        respondidaEm: request.answeredAt,
      })),
    };
  }

  if (name === "message_glpi_user") {
    const text = String(args.text ?? "").trim();
    if (!text) return { erro: "A mensagem está vazia." };
    const { user, options } = await findActiveGlpiUser(args);
    if (!user) {
      return options.length > 1
        ? {
            erro: "Encontrei mais de uma pessoa. Informe o username GLPI exato.",
            opcoes: options.slice(0, 10).map((item) => ({
              username: item.username,
              nome: item.displayName,
            })),
          }
        : { erro: `Não encontrei a pessoa "${args.username ?? args.userName ?? ""}" no GLPI.` };
    }

    const accounts = await prisma.chatAccount.findMany({ where: { glpiUserId: user.id } });
    if (accounts.length === 0) {
      return {
        erro: `${user.displayName} não possui Slack ou Telegram vinculado à conta GLPI.`,
      };
    }

    const ticketId = args.ticketId ? Number(args.ticketId) : undefined;
    const request = await prisma.managerRequest.create({
      data: {
        requesterChannel: ctx.channel,
        targetGlpiUserId: user.id,
        targetUsername: user.username,
        targetName: user.displayName,
        question: text,
        ticketId,
      },
    });
    const delivered: string[] = [];
    const body = ticketId
      ? `📣 Mensagem sobre o chamado #${ticketId}\n\n${text}\n\nResponda por aqui; seu retorno será encaminhado a quem solicitou.`
      : `📣 Mensagem do Gerente AIOps\n\n${text}\n\nResponda por aqui; seu retorno será encaminhado a quem solicitou.`;
    for (const account of accounts) {
      await approval.notifyChannel(account.channel, body);
      await prisma.managerMessage.create({
        data: {
          channel: account.channel,
          role: "assistant",
          content: body,
          metadata: {
            source: "manager_notification",
            fromChannel: ctx.channel,
            requestId: request.id,
            ...(ticketId ? { ticketId } : {}),
          },
        },
      });
      delivered.push(account.channel);
    }
    return {
      enviadoPara: user.displayName,
      username: user.username,
      canais: delivered,
      ticketId: ticketId ?? null,
      requestId: request.id,
      status: "aguardando_resposta",
    };
  }

  if (name === "plan_propose") {
    const created = await plan.proposePlan(
      ctx.channel,
      String(args.objetivo ?? ""),
      args.itens,
    );
    return {
      planId: created.id,
      status: created.status,
      itens: created.items,
      aviso: "Rascunho salvo. Apresente o plano ao usuário e pergunte se aprova ou quer ajustes.",
    };
  }

  if (name === "plan_show") {
    const draft = await plan.getDraft(ctx.channel);
    return draft
      ? { planId: draft.id, objetivo: draft.goal, itens: draft.items }
      : { vazio: true, aviso: "Não há plano em rascunho neste canal." };
  }

  if (name === "plan_cancel") {
    const cancelled = await plan.cancelDraft(ctx.channel);
    return { cancelado: cancelled };
  }

  if (name === "plan_confirm") {
    if (!CONFIRM_REGEX.test(ctx.userMessage)) {
      return {
        erro:
          "Bloqueado: a mensagem atual do usuário não contém uma aprovação explícita. " +
          "Apresente o plano final e pergunte se ele confirma a criação dos chamados.",
      };
    }
    const result = await plan.confirmDraft(ctx.channel);
    // Esta sessão é dona dos chamados criados (aprovações voltam para cá)
    for (const t of result.created) {
      await approval.setTicketOwner(t.ticketId, ctx.channel).catch(() => undefined);
    }
    return {
      criados: result.created,
      aviso: "Chamados criados no GLPI. Os cards do Trello serão criados automaticamente pela sincronização.",
    };
  }

  if (name === "ticket_assign_agent") {
    const ticketId = Number(args.ticketId);
    const wanted = String(args.agentName ?? args.agentId ?? "").trim().toLowerCase();
    const agents = await prisma.agent.findMany({ where: { enabled: true } });
    const agent =
      agents.find((a) => a.id === String(args.agentId)) ??
      agents.find((a) => a.name.toLowerCase() === wanted) ??
      agents.find((a) => a.name.toLowerCase().includes(wanted));
    if (!agent) return { erro: `Não encontrei o agente "${args.agentName ?? args.agentId}".` };
    if (!agent.glpiUserId) return { erro: `O agente ${agent.name} não tem conta GLPI. Crie a conta antes.` };

    // Remove agentes atualmente atribuídos (deixa o chamado só com o novo agente)
    const assignedIds = await glpi.getAssignedUserIds(ticketId);
    const agentUserIds = new Set(
      agents.map((a) => a.glpiUserId).filter((id): id is number => Boolean(id)),
    );
    const replacingAnotherAgent = assignedIds.some(
      (id) => agentUserIds.has(id) && id !== agent.glpiUserId,
    );
    if (replacingAnotherAgent) {
      await glpi.unassignAllTechs(ticketId);
    }
    if (replacingAnotherAgent || !assignedIds.includes(agent.glpiUserId)) {
      await glpi.assignUser(ticketId, agent.glpiUserId);
    }

    // Cancela pendências do agente anterior e destrava o monitor com um followup
    await prisma.agentApproval.updateMany({
      where: { glpiTicketId: ticketId, status: ApprovalStatus.PENDING },
      data: { status: ApprovalStatus.DENIED, resolvedBy: "reassign", resolvedAt: new Date() },
    });
    await glpi.updateTicketStatus(ticketId, glpi.GLPI_TICKET_STATUS.ASSIGNED);
    await glpi.addFollowup(
      ticketId,
      `🔄 Chamado reatribuído ao agente <b>${agent.name}</b>. Ele assumirá o trabalho no próximo ciclo.`,
    );
    // Esta sessão passa a ser dona do chamado: aprovações voltam para cá.
    await approval.setTicketOwner(ticketId, ctx.channel);
    return { atribuido: agent.name, ticketId };
  }

  if (name === "ticket_delegate_agent") {
    const ticketId = Number(args.ticketId);
    const instruction = String(args.instruction ?? "").trim();
    if (!instruction) return { erro: "A instrução para o agente está vazia." };

    const assignment = await executeManagerFunction(
      "ticket_assign_agent",
      { ticketId, agentName: args.agentName },
      ctx,
    ) as Record<string, unknown>;
    if (assignment.erro) return assignment;

    await glpi.addFollowup(
      ticketId,
      `📋 <b>Instrução para o agente ${assignment.atribuido}</b><br>${instruction}`,
    );
    return {
      delegado: assignment.atribuido,
      ticketId,
      instrucao: instruction,
      aviso: "O agente receberá o chamado e a instrução no próximo ciclo do monitor.",
    };
  }

  if (name === "ticket_create") {
    const titulo = String(args.titulo ?? "").trim();
    const descricao = String(args.descricao ?? "").trim();
    if (!titulo || !descricao) return { erro: "Informe título e descrição do chamado." };

    const tipo = /incid/i.test(String(args.tipo ?? ""))
      ? glpi.GLPI_TICKET_TYPE.INCIDENT
      : glpi.GLPI_TICKET_TYPE.REQUEST;
    const urgency = Math.min(Math.max(Number(args.urgencia) || 3, 1), 5);

    const ticketId = await glpi.createRawTicket({
      title: titulo,
      content: descricao.replace(/\n/g, "<br>"),
      urgency,
      type: tipo,
    });
    // A sessão que criou vira a dona do chamado (aprovações roteadas a ela)
    await approval.setTicketOwner(ticketId, ctx.channel);

    // Anexa arquivos se houver
    const anexados: string[] = [];
    for (const att of ctx.attachments) {
      const buffer = Buffer.from(att.data, "base64");
      const name = att.name || `anexo-${Date.now()}`;
      await glpi.uploadDocument(ticketId, name, att.mimeType, buffer);
      anexados.push(name);
    }

    let atribuido: string | undefined;
    if (args.atribuirParaMim) {
      const account = await chatAccounts.getAccountByChannel(ctx.channel);
      if (account) {
        await glpi.assignUser(ticketId, account.glpiUserId);
        await glpi.updateTicketStatus(ticketId, glpi.GLPI_TICKET_STATUS.ASSIGNED);
        atribuido = account.glpiUsername;
      }
    }

    logger.info({ ticketId, tipo, channel: ctx.channel }, "Chamado criado pelo Gerente");
    return {
      criado: true,
      ticketId,
      titulo,
      tipo: tipo === glpi.GLPI_TICKET_TYPE.INCIDENT ? "Incidente" : "Requisição",
      ...(atribuido ? { atribuido } : {}),
      ...(anexados.length ? { anexos: anexados } : {}),
    };
  }

  if (name === "ticket_assign_glpi_user") {
    const ticketId = Number(args.ticketId);
    if (!Number.isInteger(ticketId) || ticketId <= 0) return { erro: "Informe o número do chamado." };

    const self = Boolean(args.self);
    const linkedAccount = self ? await chatAccounts.getAccountByChannel(ctx.channel) : null;
    if (self && !linkedAccount) {
      return { erro: "Esta conversa ainda não está vinculada a uma conta GLPI." };
    }

    const users = (await glpi.listUsers()).filter((user) => user.active);
    const wanted = String(args.username ?? args.userName ?? "").trim().toLowerCase();
    let user = linkedAccount
      ? users.find((item) => item.id === linkedAccount.glpiUserId)
      : users.find((item) => item.username.toLowerCase() === wanted);

    if (!user && wanted) {
      const exactName = users.filter((item) => item.displayName.toLowerCase() === wanted);
      if (exactName.length === 1) user = exactName[0];
    }
    if (!user && wanted) {
      const partial = users.filter(
        (item) =>
          item.displayName.toLowerCase().includes(wanted) ||
          item.username.toLowerCase().includes(wanted),
      );
      if (partial.length === 1) user = partial[0];
      if (partial.length > 1) {
        return {
          erro: "Encontrei mais de uma conta. Informe o username exato.",
          opcoes: partial.slice(0, 10).map((item) => ({
            username: item.username,
            nome: item.displayName,
          })),
        };
      }
    }
    if (!user) {
      return {
        erro: wanted
          ? `Não encontrei uma conta GLPI ativa para "${args.username ?? args.userName}".`
          : "Informe a pessoa ou use self=true para atribuir à conta desta conversa.",
      };
    }

    const assignedIds = await glpi.getAssignedUserIds(ticketId);
    if (!assignedIds.includes(user.id)) await glpi.assignUser(ticketId, user.id);
    await glpi.updateTicketStatus(ticketId, glpi.GLPI_TICKET_STATUS.ASSIGNED);
    await glpi.addFollowup(
      ticketId,
      `👤 Chamado atribuído a <b>${user.displayName}</b> (${user.username}) pelo Gerente AIOps.`,
    );
    if (self) await approval.setTicketOwner(ticketId, ctx.channel);
    return {
      atribuido: user.displayName,
      username: user.username,
      ticketId,
      jaEstavaAtribuido: assignedIds.includes(user.id),
    };
  }

  if (name === "logs_services") {
    return { servicos: await loki.listLabelValues("service_name") };
  }

  if (name === "logs_query") {
    const selectors: Record<string, string> = {};
    if (args.service) selectors.service_name = String(args.service);
    if (args.environment) selectors.environment = String(args.environment);
    const result = await loki.queryLogs({
      selectors,
      filter: args.filter ? String(args.filter) : undefined,
      onlyErrors: Boolean(args.onlyErrors),
      minutes: args.minutes ? Number(args.minutes) : undefined,
      limit: args.limit ? Number(args.limit) : undefined,
    });
    // Limita o volume devolvido ao modelo
    return {
      consulta: result.query,
      total: result.count,
      linhas: result.lines.slice(0, 80),
    };
  }

  if (name === "metrics_query") {
    const expression = String(args.expression ?? "").trim();
    if (!expression) return { erro: "A expressão PromQL está vazia." };
    return {
      expression,
      series: (await grafana.queryPrometheus(expression)).slice(0, 100),
    };
  }

  if (name === "security_events_query") {
    const query = String(args.query ?? "").trim();
    if (!query) return { erro: "A consulta de segurança está vazia." };
    const rows = await grafana.queryWazuh({
      query,
      minutes: Math.min(Math.max(Number(args.minutes) || 60, 1), 1440),
      limit: Math.min(Math.max(Number(args.limit) || 50, 1), 200),
    });
    return { query, eventos: rows.slice(0, 100) };
  }

  if (name === "web_search") {
    const query = String(args.query ?? "").trim();
    if (!query) return { erro: "A consulta de pesquisa está vazia." };
    return runWebSearch(query);
  }

  if (name === "my_tickets") {
    const links = await chatAccounts.activeTickets(ctx.channel);
    if (links.length === 0) return { vazio: true, aviso: "Nenhum chamado vinculado a esta conversa." };
    return links.map((l) => ({
      chamado: l.glpiTicketId,
      titulo: l.ticketName,
      status: GLPI_STATUS_LABEL[l.status] ?? l.status,
    }));
  }

  if (name === "ticket_comment") {
    const ticketId = Number(args.ticketId);
    if (!allowsTicketComment(ctx.userMessage)) {
      return {
        erro:
          "A mensagem atual é investigativa, hipotética ou não autoriza registro. " +
          "Responda à pergunta sem alterar o chamado.",
      };
    }
    const authorId = await actionAuthor(
      ctx,
      ticketId,
      /\b(coment\w*|document\w*|registr\w*|formaliz\w*|adicion\w*)\b/i,
    );
    const text = String(args.text ?? "").trim();
    if (!text) return { erro: "O comentário está vazio." };
    // Anti-duplicação: não repete um comentário idêntico já registrado no chamado
    if (await commentAlreadyExists(ticketId, text)) {
      return { jaRegistrado: true, chamado: ticketId };
    }
    // Atribui a autoria à conta da pessoa do chat (não ao usuário da integração)
    await glpi.addFollowup(ticketId, text, authorId);
    return { comentado: ticketId };
  }

  if (name === "ticket_attach") {
    const ticketId = Number(args.ticketId);
    if (ctx.attachments.length === 0) return { erro: "Nenhum arquivo nesta mensagem para anexar." };
    const authorId = await actionAuthor(
      ctx,
      ticketId,
      /\b(anex\w*|attach\w*|arquiv\w*|document\w*)\b/i,
    );
    const anexados: string[] = [];
    for (const att of ctx.attachments) {
      const buffer = Buffer.from(att.data, "base64");
      const name = att.name || `anexo-${Date.now()}`;
      await glpi.uploadDocument(ticketId, name, att.mimeType, buffer, authorId);
      anexados.push(name);
    }
    await glpi.addFollowup(
      ticketId,
      `Arquivos anexados ao chamado: ${anexados.join(", ")}.`,
      authorId,
    );
    return { anexadosNoChamado: ticketId, arquivos: anexados };
  }

  if (name === "ticket_task") {
    const ticketId = Number(args.ticketId);
    const authorId = await actionAuthor(ctx, ticketId, /\btarefas?\b/i);
    const descricao = String(args.descricao ?? "").trim();
    if (!descricao) return { erro: "A descrição da tarefa está vazia." };
    const state = args.done ? glpi.GLPI_TASK_STATE.DONE : glpi.GLPI_TASK_STATE.TODO;
    const taskId = await glpi.addTask(ticketId, descricao, state, authorId);
    return { tarefaCriada: taskId, chamado: ticketId, concluida: Boolean(args.done) };
  }

  if (name === "ticket_tasks_create") {
    const ticketId = Number(args.ticketId);
    const authorId = await actionAuthor(ctx, ticketId, /\btarefas?\b/i);
    const tasks = Array.isArray(args.tasks) ? args.tasks : [];
    if (tasks.length === 0) return { erro: "Nenhuma tarefa foi informada." };
    const created: Array<{ id: number; descricao: string; concluida: boolean }> = [];
    for (const raw of tasks.slice(0, 20)) {
      const item = raw as Record<string, unknown>;
      const descricao = String(item.descricao ?? "").trim();
      if (!descricao) continue;
      const done = Boolean(item.done);
      const id = await glpi.addTask(
        ticketId,
        descricao,
        done ? glpi.GLPI_TASK_STATE.DONE : glpi.GLPI_TASK_STATE.TODO,
        authorId,
      );
      created.push({ id, descricao, concluida: done });
    }
    return created.length
      ? { chamado: ticketId, tarefasCriadas: created }
      : { erro: "As descrições das tarefas estão vazias." };
  }

  if (name === "ticket_solve") {
    const ticketId = Number(args.ticketId);
    const authorId = await actionAuthor(
      ctx,
      ticketId,
      /\b(fech\w*|finaliz\w*|solucion\w*|resolv\w*)\b/i,
    );
    await glpi.solveTicket(
      ticketId,
      String(args.solucao || "Resolvido pelo responsável via chat."),
      authorId,
    );
    return { solucionado: ticketId };
  }

  if (name === "tickets_bulk_comment_solve") {
    if (!allowsBulkCommentAndSolve(ctx.userMessage)) {
      return {
        erro:
          "A mensagem atual não contém uma ordem explícita para comentar e finalizar vários chamados.",
      };
    }

    const ticketIds = [...new Set(
      (Array.isArray(args.ticketIds) ? args.ticketIds : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0),
    )].slice(0, 50);
    const comentario = String(args.comentario ?? "").trim();
    const solucao = String(args.solucao ?? "").trim();
    if (ticketIds.length === 0) return { erro: "Nenhum chamado válido foi informado." };
    if (!comentario || !solucao) {
      return { erro: "Informe o comentário e a nota de solução para a operação em lote." };
    }

    const resultados: Array<{
      ticketId: number;
      comentado: boolean;
      solucionado: boolean;
      jaSolucionado?: boolean;
      erro?: string;
    }> = [];

    for (const ticketId of ticketIds) {
      let comentado = false;
      let solucionado = false;
      try {
        const ticket = await glpi.getTicket(ticketId);
        if (!ticket) {
          resultados.push({
            ticketId,
            comentado: false,
            solucionado: false,
            erro: "Chamado não encontrado.",
          });
          continue;
        }

        const jaComentado = await commentAlreadyExists(ticketId, comentario);
        if (!jaComentado) await glpi.addFollowup(ticketId, comentario);
        comentado = true;

        const jaSolucionado = ticket.status >= glpi.GLPI_TICKET_STATUS.SOLVED;
        if (!jaSolucionado) await glpi.solveTicket(ticketId, solucao);
        solucionado = true;

        resultados.push({
          ticketId,
          comentado,
          solucionado,
          ...(jaSolucionado ? { jaSolucionado: true } : {}),
        });
      } catch (error) {
        resultados.push({
          ticketId,
          comentado,
          solucionado,
          erro: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const sucesso = resultados.filter((item) => item.solucionado).map((item) => item.ticketId);
    const falhas = resultados.filter((item) => item.erro);
    logger.info(
      { ticketIds, sucesso, falhas: falhas.map((item) => ({ ticketId: item.ticketId, erro: item.erro })) },
      "Operação administrativa em lote concluída",
    );
    return {
      processados: resultados.length,
      sucesso,
      falhas,
      resultados,
    };
  }

  if (name === "tickets_comment_multi") {
    const ticketIds = [...new Set(
      (Array.isArray(args.ticketIds) ? args.ticketIds : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0),
    )].slice(0, 50);
    const comentario = String(args.comentario ?? "").trim();
    if (ticketIds.length === 0) return { erro: "Nenhum chamado válido informado." };
    if (!comentario) return { erro: "O comentário está vazio." };

    const resultados: Array<{ ticketId: number; ok: boolean; erro?: string }> = [];
    for (const ticketId of ticketIds) {
      try {
        const jaExiste = await commentAlreadyExists(ticketId, comentario);
        if (!jaExiste) await glpi.addFollowup(ticketId, comentario);
        resultados.push({ ticketId, ok: true });
      } catch (error) {
        resultados.push({
          ticketId,
          ok: false,
          erro: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const sucesso = resultados.filter((item) => item.ok).map((item) => item.ticketId);
    const falhas = resultados.filter((item) => item.erro);
    logger.info(
      { ticketIds, sucesso, falhas: falhas.map((f) => ({ ticketId: f.ticketId, erro: f.erro })) },
      "Comentário em lote concluído",
    );
    return { processados: resultados.length, sucesso, falhas };
  }

  if (name === "tickets_solve_multi") {
    const ticketIds = [...new Set(
      (Array.isArray(args.ticketIds) ? args.ticketIds : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0),
    )].slice(0, 50);
    const solucao = String(args.solucao ?? "").trim();
    if (ticketIds.length === 0) return { erro: "Nenhum chamado válido informado." };
    if (!solucao) return { erro: "A nota de solução está vazia." };

    const resultados: Array<{ ticketId: number; ok: boolean; jaSolucionado?: boolean; erro?: string }> = [];
    for (const ticketId of ticketIds) {
      try {
        const ticket = await glpi.getTicket(ticketId);
        if (!ticket) {
          resultados.push({ ticketId, ok: false, erro: "Chamado não encontrado." });
          continue;
        }
        const jaSolucionado = ticket.status >= glpi.GLPI_TICKET_STATUS.SOLVED;
        if (!jaSolucionado) await glpi.solveTicket(ticketId, solucao);
        resultados.push({ ticketId, ok: true, jaSolucionado });
      } catch (error) {
        resultados.push({
          ticketId,
          ok: false,
          erro: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const sucesso = resultados.filter((item) => item.ok).map((item) => item.ticketId);
    const falhas = resultados.filter((item) => item.erro);
    logger.info(
      { ticketIds, sucesso, falhas: falhas.map((f) => ({ ticketId: f.ticketId, erro: f.erro })) },
      "Solução em lote concluída",
    );
    return { processados: resultados.length, sucesso, falhas };
  }

  if (name === "runs_recent") {
    const status = args.status ? String(args.status).toUpperCase() : undefined;
    const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
    const runs = await prisma.agentRun.findMany({
      where: status ? { status: status as never } : {},
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { agent: true },
    });
    return runs.map((r) => ({
      runId: r.id,
      agente: r.agent?.name ?? "—",
      tipo: r.kind,
      status: r.status,
      elevada: r.elevated,
      chamado: r.glpiTicketId,
      duracaoSeg: r.durationMs ? Math.round(r.durationMs / 1000) : null,
      quando: r.createdAt,
      resumoErro: r.error ? r.error.slice(0, 200) : null,
    }));
  }

  if (name === "run_get") {
    const run = args.runId
      ? await prisma.agentRun.findUnique({ where: { id: String(args.runId) }, include: { agent: true } })
      : await prisma.agentRun.findFirst({
          where: args.ticketId ? { glpiTicketId: Number(args.ticketId) } : {},
          orderBy: { createdAt: "desc" },
          include: { agent: true },
        });
    if (!run) return { erro: "Execução não encontrada." };
    return {
      runId: run.id,
      agente: run.agent?.name ?? "—",
      tipo: run.kind,
      status: run.status,
      elevada: run.elevated,
      chamado: run.glpiTicketId,
      codigoSaida: run.exitCode,
      duracaoSeg: run.durationMs ? Math.round(run.durationMs / 1000) : null,
      saida: (run.output ?? "").slice(0, 6000),
      erro: (run.error ?? "").slice(0, 4000),
    };
  }

  if (name === "approvals_list") {
    const pending = await approval.listPending();
    return pending.map((p) => ({
      chamado: p.glpiTicketId,
      precisaDe: p.summary,
      desde: p.createdAt,
    }));
  }

  if (name === "approval_resolve") {
    const ticketId = Number(args.ticketId);
    const pending = await approval.findPendingByTicket(ticketId);
    if (!pending) return { erro: `Não há pendência aberta para o chamado #${ticketId}.` };
    const deny = /neg|recus|rejeit|não|nao/i.test(String(args.decision));
    return {
      resultado: deny
        ? await approval.deny(pending.id, "usuário")
        : await approval.grant(pending.id, "usuário"),
    };
  }

  if (name === "code_projects") return code.listProjects();
  if (name === "code_tree") {
    return code.tree(String(args.projectPath), args.maxDepth ? Number(args.maxDepth) : undefined);
  }
  if (name === "code_read") {
    return code.readFile(String(args.projectPath), String(args.filePath));
  }
  if (name === "code_search") {
    return code.search(String(args.projectPath), String(args.query));
  }
  if (name === "search_knowledge") {
    const query = String(args.query ?? "");
    const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 15);
    return { results: await knowledge.searchKnowledge(query, limit) };
  }

  if (name === "ssh_exec") {
    const projectName = String(args.projectName ?? "").trim();
    const command = String(args.command ?? "").trim();
    if (!command) return { erro: "Informe o comando a executar." };
    const project = projectName
      ? await prisma.codebaseProject.findFirst({ where: { name: { equals: projectName, mode: "insensitive" } } })
      : null;
    if (projectName && !project) {
      const all = await prisma.codebaseProject.findMany({ select: { name: true } });
      return { erro: `Projeto "${projectName}" não encontrado. Projetos disponíveis: ${all.map((p) => p.name).join(", ")}` };
    }
    const target = project ?? { sshAuthType: "pm2" as const, projectPath: ".", sshHost: null, sshPort: 22, sshUser: null, sshKeyPath: null, sshPassword: null };
    const result = await ssh.execCommand(target, command, 60_000);
    const strip = (s: string) => s.replace(/\x1B\[[\d;]*[A-Za-z]/g, "").replace(/\r/g, "").trim();
    return {
      project: project?.name ?? "host",
      host: target.sshHost || "PM2 (local)",
      command,
      success: result.success,
      stdout: strip(result.stdout ?? "").slice(0, 10_000),
      stderr: strip(result.stderr ?? "").slice(0, 5_000),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  }

  if (name === "project_update") {
    const projectName = String(args.projectName ?? "").trim();
    if (!projectName) return { erro: "Informe o nome do projeto." };
    const project = await prisma.codebaseProject.findFirst({
      where: { name: { equals: projectName, mode: "insensitive" } },
    });
    if (!project) {
      const all = await prisma.codebaseProject.findMany({ select: { name: true } });
      return { erro: `Projeto "${projectName}" não encontrado. Projetos disponíveis: ${all.map((p) => p.name).join(", ")}` };
    }
    const data: Record<string, unknown> = {};
    if (args.sshHost !== undefined) data.sshHost = String(args.sshHost).trim() || null;
    if (args.sshPort !== undefined) data.sshPort = Number(args.sshPort);
    if (args.sshUser !== undefined) data.sshUser = String(args.sshUser).trim() || null;
    if (args.sshAuthType !== undefined) data.sshAuthType = String(args.sshAuthType).trim();
    if (args.sshKeyPath !== undefined) data.sshKeyPath = String(args.sshKeyPath).trim() || null;
    if (args.sshPassword !== undefined) data.sshPassword = String(args.sshPassword).trim() || null;
    if (args.description !== undefined) data.description = String(args.description).trim();
    if (args.projectPath !== undefined) data.projectPath = String(args.projectPath).trim();
    await prisma.codebaseProject.update({ where: { id: project.id }, data });
    return { atualizado: true, project: project.name, sshHost: data.sshHost ?? project.sshHost, sshPort: data.sshPort ?? project.sshPort, sshUser: data.sshUser ?? project.sshUser, sshAuthType: data.sshAuthType ?? project.sshAuthType };
  }

  if (name === "visual_regression_test" || name === "pentest" || name === "load_test") {
    const common = {
      channel: ctx.channel,
      targetUrl: args.targetUrl ? String(args.targetUrl) : undefined,
      repoPath: args.repoPath ? String(args.repoPath) : undefined,
    };
    if (name === "visual_regression_test") {
      const run = await visualTest.start({ ...common, params: { screens: args.screens ?? "all" } });
      return { iniciado: true, runId: run.id, ferramenta: "Visual", aba: "Ferramentas › Visual",
        aviso: "Execução em segundo plano. Acompanhe o passo-a-passo e o relatório na aba Ferramentas › Visual." };
    }
    if (name === "pentest") {
      const run = await pentest.start({
        ...common,
        projectId: args.projectId ? String(args.projectId) : undefined,
        params: { zap: Boolean(args.zap), authorized: Boolean(args.authorized) },
      });
      return { iniciado: true, runId: run.id, ferramenta: "Pentest", aba: "Ferramentas › Pentest",
        aviso: "Pentest em segundo plano. Achados e plano de correção aparecem na aba Ferramentas › Pentest." };
    }
    const run = await loadtest.start({ ...common, params: { scenario: args.scenario ?? "baseline" } });
    return { iniciado: true, runId: run.id, ferramenta: "Stress", aba: "Ferramentas › Stress",
      aviso: "Teste de carga em segundo plano. Métricas e relatório na aba Ferramentas › Stress." };
  }

  // Demais ferramentas compartilham a implementação do MCP
  return callTool(name, args);
}

// ---------------------------------------------------------------------------

export function extractTaskDescriptions(message: string): string[] {
  const normalized = message.replace(/\r\n?/g, "\n").trim();
  const numbered = [...normalized.matchAll(/(?:^|\n)\s*(\d{1,2})[.)]\s+([^\n]+)/g)];
  if (numbered.length >= 2) {
    return numbered
      .map((match, index) => {
        const start = (match.index ?? 0) + match[0].indexOf(match[1]!);
        const end = numbered[index + 1]?.index ?? normalized.length;
        return normalized
          .slice(start, end)
          .replace(/^\d{1,2}[.)]\s+/, "")
          .trim();
      })
      .filter(Boolean);
  }

  const quoted = [...normalized.matchAll(/["“]([^"”]+)["”]/g)]
    .map((match) => match[1]?.trim())
    .filter((text): text is string => Boolean(text));
  if (quoted.length > 0) return quoted;

  const commaList = normalized.match(/\b(?:tarefas?|atividades?)\b[^,]{0,80},\s*(.+)$/is)?.[1];
  if (commaList) {
    return commaList
      .split(/\s*,\s*|\s+;\s+|\s+\be\b\s+(?=[a-záéíóúãõç])/i)
      .map((item) => item.replace(/^\s*[-*•]\s*/, "").trim())
      .filter((item) => item.length >= 4);
  }

  const body = normalized.split(/\n\s*\n/, 2)[1];
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((line) => line.length >= 4);
}

export function parseCommand(message: string): { tool: string; args: Record<string, unknown> } | null {
  if (hasNoWriteIntent(message)) return null;

  // Aprovação/recusa de pendência por linguagem natural (resposta instantânea)
  const approve = message.match(
    /^\s*(?:pode\s+)?(?:aprov\w*|autoriz\w*|liber\w*|pode\s+prosseguir|pode\s+seguir)\s+(?:(?:a\s+)?pend[eê]ncia\s+(?:do\s+)?)?(?:(?:chamado|ticket)\s*#?(\d+)|#(\d+))\s*[.!]?\s*$/i,
  );
  if (approve) {
    return {
      tool: "approval_resolve",
      args: { ticketId: Number(approve[1] ?? approve[2]), decision: "aprovar" },
    };
  }
  const refuse = message.match(
    /^\s*(?:neg\w*|recus\w*|rejeit\w*|n[aã]o\s+autoriz\w*)\s+(?:(?:a\s+)?pend[eê]ncia\s+(?:do\s+)?)?(?:(?:chamado|ticket)\s*#?(\d+)|#(\d+))\s*[.!]?\s*$/i,
  );
  if (refuse) {
    return {
      tool: "approval_resolve",
      args: { ticketId: Number(refuse[1] ?? refuse[2]), decision: "negar" },
    };
  }

  // "atribua/reatribua/passe o chamado #N ao/para (o agente) X"
  const assign = message.match(
    /\b(atrib\w*|reatrib\w*|passe?|reassign\w*)\b[^#\d]*#?(\d+).*?\b(?:agente|ao|para|pro|pra)\s+(?:o\s+|a\s+|agente\s+)?([\wçãõáéíóúâêô.-]+)/i,
  );
  if (assign) {
    return {
      tool: "ticket_assign_agent",
      args: { ticketId: Number(assign[2]), agentName: assign[3]?.trim() },
    };
  }
  const assignSelf = message.match(
    /\b(?:coloc\w*|atrib\w*|pass\w*)\b.*?\bchamado\s*#?(\d+).*?\b(?:meu nome|para mim|pra mim)\b/i,
  );
  if (assignSelf) {
    return {
      tool: "ticket_assign_glpi_user",
      args: { ticketId: Number(assignSelf[1]), self: true },
    };
  }
  const taskRequest = message.match(
    /\b(?:cri\w*|adicion\w*|coloc\w*)\b.*?\b(?:tarefas?|atividades?)\b.*?\bchamado\s*#?(\d+)/i,
  );
  if (taskRequest) {
    const descriptions = extractTaskDescriptions(message);
    if (descriptions.length > 0) {
      const done = /\b(pront\w*|conclu[ií]d\w*|finalizad\w*|como\s+feit\w*)\b/i.test(message);
      return {
        tool: "ticket_tasks_create",
        args: {
          ticketId: Number(taskRequest[1]),
          tasks: descriptions.map((descricao) => ({ descricao, done })),
        },
      };
    }
  }
  const comment = message.match(/coment(?:e|ar).*?chamado\s*#?(\d+)\s*[:,-]\s*(.+)/i);
  if (comment) {
    return {
      tool: "ticket_comment",
      args: { ticketId: Number(comment[1]), text: comment[2] },
    };
  }
  return null;
}

async function lastContextTicketId(channel: string, message: string): Promise<number | null> {
  const current = message.match(/(?:chamado|ticket|#)\s*#?(\d+)/i)?.[1];
  if (current) return Number(current);

  const recent = await prisma.managerMessage.findMany({
    where: { channel },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  for (const item of recent) {
    const match = item.content.match(/(?:chamado|ticket|#)\s*#?(\d+)/i)?.[1];
    if (match) return Number(match);
  }

  const active = await chatAccounts.activeTickets(channel).catch(() => []);
  return active.length === 1 ? active[0]?.glpiTicketId ?? null : null;
}

async function parseContextualCommand(
  channel: string,
  message: string,
): Promise<{ tool: string; args: Record<string, unknown> } | null> {
  if (hasNoWriteIntent(message)) return null;
  const asksTasks =
    /\b(?:cri\w*|adicion\w*|coloc\w*)\b/i.test(message) &&
    /\b(?:tarefas?|atividades?)\b/i.test(message);
  if (!asksTasks) return null;

  const descriptions = extractTaskDescriptions(message);
  if (descriptions.length === 0) return null;

  const ticketId = await lastContextTicketId(channel, message);
  if (!ticketId) return null;
  const done = /\b(pront\w*|conclu[ií]d\w*|finalizad\w*|como\s+feit\w*)\b/i.test(message);
  return {
    tool: "ticket_tasks_create",
    args: {
      ticketId,
      tasks: descriptions.map((descricao) => ({ descricao, done })),
    },
  };
}

export function hasNoWriteIntent(message: string): boolean {
  return /\b(?:n[aã]o|nem)\b[^.!?\n]{0,45}\b(?:registr\w*|coment\w*|escrev\w*|adicion\w*|alter\w*|atualiz\w*|anex\w*|atrib\w*|deleg\w*|cri\w*\s+tarefas?|finaliz\w*|fech\w*|solucion\w*)\b|\b(?:sem|nada\s+de)\s+(?:registr\w*|coment\w*|alter\w*|atualiz\w*|escrev\w*)\b|\b(?:s[oó]|apenas)\s+(?:investig\w*|analis\w*|verific\w*)\b/i.test(
    message,
  );
}

export function isInvestigativeMessage(message: string): boolean {
  const text = message.trim();
  return (
    text.includes("?") ||
    /\b(?:ser[aá]\s+que|pode\s+ter|poderia\s+ter|teria\s+causado|originou|causou|rela[cç][aã]o|relacionad\w*|investig\w*|analis\w*|verific\w*|acha\s+que|por\s+qu[eê]|pq|como|o\s+que|qual|quais)\b/i.test(
      text,
    )
  );
}

function hasExplicitCommentIntent(message: string): boolean {
  return /\b(?:faz|fa[cç]a|pode\s+fazer|manda|envia|cria)\b[^.!?\n]{0,40}\b(?:o\s+)?coment[áa]rio\b|\b(?:coment\w*|document\w*|registr\w*|formaliz\w*|adicion\w*|coloc\w*|p[õo]e|grav\w*)\b[^.!?\n]{0,80}\b(?:coment[áa]rio|chamado|ticket|hist[óo]rico|glpi|isso)\b|\b(?:no|como)\s+coment[áa]rio\b/i.test(
    message,
  );
}

function looksLikeProgressStatement(message: string): boolean {
  return /\b(?:fiz|conclu[ií]|terminei|finalizei|resolvi|avancei|atualiza[cç][aã]o|trabalhei|implementei|corrigi|ajustei|validei|testei|configurei|publiquei|subi|executei)\b/i.test(
    message,
  );
}

export function allowsTicketComment(message: string): boolean {
  if (hasNoWriteIntent(message)) return false;
  if (hasExplicitCommentIntent(message)) return true;
  return looksLikeProgressStatement(message) && !isInvestigativeMessage(message);
}

async function parseChatAccountUpdate(
  channel: string,
  message: string,
): Promise<Array<{ tool: string; args: Record<string, unknown> }> | null> {
  if (hasNoWriteIntent(message) || isInvestigativeMessage(message)) return null;

  const account = await chatAccounts.getAccountByChannel(channel);
  if (!account) return null;

  const explicitId = message.match(/(?:chamado|ticket|#)\s*#?(\d+)/i)?.[1];
  const active = await chatAccounts.activeTickets(channel);
  const ticketId = explicitId
    ? Number(explicitId)
    : active.length === 1
      ? active[0]?.glpiTicketId
      : undefined;

  const looksLikeUpdate = looksLikeProgressStatement(message);
  const wantsSolve =
    /\b(pode\s+(?:finalizar|encerrar|fechar|solucionar)|pode\s+dar\s+como\s+(?:feito|resolvido)|j[aá]\s+(?:terminei|resolvi)|est[aá]\s+(?:resolvido|conclu[ií]do))\b/i.test(
      message,
    );

  if (!looksLikeUpdate && !wantsSolve) return null;
  // Chamado ambíguo (vários ativos e sem número): deixa o modelo inferir/perguntar.
  if (!ticketId) return null;

  await chatAccounts.assertCanManageTicket(channel, ticketId);
  const actions: Array<{ tool: string; args: Record<string, unknown> }> = [];
  if (wantsSolve) {
    actions.push({
      tool: "ticket_solve",
      args: {
        ticketId,
        solucao: message.trim() || "Responsável confirmou a conclusão via chat.",
      },
    });
  } else if (message.trim()) {
    actions.push({ tool: "ticket_comment", args: { ticketId, text: message.trim() } });
  }
  return actions.length ? actions : null;
}

const GLPI_STATUS_LABEL: Record<number, string> = {
  1: "Novo",
  2: "Em atendimento",
  3: "Planejado",
  4: "Pendente",
  5: "Solucionado",
  6: "Fechado",
};

let snapshotCache: { expiresAt: number; text: string } | null = null;

/**
 * Visão completa do ambiente para o Gerente: TODOS os chamados recentes
 * (id, tipo, status, título) e os agentes disponíveis. Garante que o
 * planejamento considere o que já existe, sem depender só do top-k do RAG.
 */
async function operationalSnapshot(): Promise<string> {
  if (snapshotCache && snapshotCache.expiresAt > Date.now()) return snapshotCache.text;

  const [tickets, agents, pending] = await Promise.all([
    glpi.listRecentTickets().catch(() => []),
    prisma.agent.findMany({ where: { enabled: true } }),
    approval.listPending().catch(() => []),
  ]);

  const ticketLines = tickets
    .filter((t) => !t.is_deleted)
    .map(
      (t) =>
        `#${t.id} [${t.type === glpi.GLPI_TICKET_TYPE.REQUEST ? "Requisição" : "Incidente"} | ${GLPI_STATUS_LABEL[t.status] ?? t.status}] ${t.name}`,
    );

  const agentLines = agents.map(
    (a) => `- ${a.name} (modo ${a.mode})${a.glpiUserId ? " — tem conta GLPI, pode ser atribuído" : ""}`,
  );

  const approvalLines = pending.map(
    (p) => `- Chamado #${p.glpiTicketId}: agente aguarda aprovação para ${p.summary}`,
  );

  const text = [
    `## Inventário completo de chamados do GLPI (${ticketLines.length})`,
    ticketLines.join("\n") || "(nenhum chamado)",
    "",
    "## Agentes disponíveis",
    agentLines.join("\n") || "(nenhum agente cadastrado)",
    "",
    "## Pendências de aprovação de agentes (aguardando o usuário)",
    approvalLines.join("\n") || "(nenhuma pendência)",
    approvalLines.length
      ? 'Para liberar, o usuário pode dizer "aprovar #N" ou "negar #N".'
      : "",
  ].filter(Boolean).join("\n");

  snapshotCache = { expiresAt: Date.now() + 30_000, text };
  return text;
}

function needsOperationalContext(message: string): boolean {
  return /\b(chamado|ticket|incidente|alerta|glpi|trello|agente|erro|falha|aberto|fechado|resolvido|pendente|crítico|critico|atribuir|responsável|responsavel|tarefa|relatório|relatorio|plano|planejar|planeje|lote|requisiç\w*|requisic\w*|sprint|log|logs|grafana|loki|exceç\w*|excec\w*|timeout|execuç\w*|execuc\w*|\brun\b|runs|one.?shot|triar|triagem|diagnostic\w*)\b/i.test(message);
}

/** Remove marcações markdown de ênfase que o usuário não quer ver (asteriscos). */
function sanitizeStyle(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **negrito**
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1$2") // *itálico*
    .replace(/^\s*[*•]\s+/gm, "- ") // bullets com * ou •
    .replace(/__([^_]+)__/g, "$1"); // __negrito__
}

async function saveAssistantMessage(
  channel: string,
  content: string,
  model: string,
  source?: string,
): Promise<string> {
  const clean = sanitizeStyle(content);
  await prisma.managerMessage.create({
    data: { channel, role: "assistant", content: clean, metadata: { model, ...(source ? { source } : {}) } },
  });
  return clean;
}

/** Anexo de mídia enviado pelo usuário (imagem, áudio, vídeo, PDF, texto). */
export interface ChatAttachment {
  mimeType: string;
  /** Conteúdo em base64 (sem o prefixo data:). */
  data: string;
  name?: string;
}

function attachmentNote(attachments: ChatAttachment[]): string {
  if (!attachments.length) return "";
  const kinds = attachments.map((a) => {
    if (a.mimeType.startsWith("image/")) return "imagem";
    if (a.mimeType.startsWith("audio/")) return "áudio";
    if (a.mimeType.startsWith("video/")) return "vídeo";
    if (a.mimeType.includes("pdf")) return "PDF";
    return "documento";
  });
  return `(anexo: ${kinds.join(", ")})`;
}

export async function chat(
  message: string,
  channel = "web",
  requestedModel?: string,
  source?: string,
  attachments: ChatAttachment[] = [],
): Promise<{ answer: string; model: string }> {
  const availableModels = await listManagerModels();
  const model = availableModels.some((item) => item.id === requestedModel)
    ? requestedModel!
    : env.MANAGER_MODEL;

  const savedText = message || attachmentNote(attachments) || "(mensagem vazia)";
  const attachMeta = attachments.length > 0
    ? { attachments: attachments.map((a) => ({
        mimeType: a.mimeType,
        name: a.name,
        // Para imagens, armazena o base64 para exibir no chat; para outros tipos, apenas metadados
        ...(a.mimeType.startsWith("image/") && a.data.length < 500_000
          ? { data: a.data, dataUrl: `data:${a.mimeType};base64,${a.data}` }
          : {}),
      })) }
    : {};
  await prisma.managerMessage.create({
    data: {
      channel, role: "user", content: savedText,
      metadata: { model, ...(source ? { source } : {}), ...attachMeta },
    },
  });

  const routedResponse = attachments.length === 0
    ? await routePendingManagerResponse(channel, message)
    : null;
  if (routedResponse) {
    const answer = "Obrigado. Sua resposta foi encaminhada ao solicitante.";
    return { answer: await saveAssistantMessage(channel, answer, model, source), model };
  }

  // Atalho determinístico para atualizações de texto SEM anexo e sem ambiguidade.
  // Com mídia (ou múltiplos chamados), o modelo conduz: lê a imagem, identifica
  // o chamado certo pela legenda/contexto, anexa e responde de forma natural.
  const accountActions =
    attachments.length === 0 ? await parseChatAccountUpdate(channel, message) : null;
  if (accountActions) {
    for (const action of accountActions) {
      await executeManagerFunction(action.tool, action.args, {
        channel,
        userMessage: message,
        attachments,
      });
    }
    const tid = accountActions[0]?.args.ticketId;
    const solved = accountActions.some((action) => action.tool === "ticket_solve");
    const answer = solved
      ? `Pronto, registrei a conclusão e marquei o chamado #${tid} como solucionado.`
      : `Pronto, registrei sua atualização no chamado #${tid}.`;
    return { answer: await saveAssistantMessage(channel, answer, model, source), model };
  }

  const command = attachments.length === 0
    ? parseCommand(message) ?? await parseContextualCommand(channel, message)
    : null;
  if (command) {
    let answer: string;
    try {
      const result = (await executeManagerFunction(command.tool, command.args, {
        channel,
        userMessage: message,
        attachments,
      })) as Record<string, unknown>;
      if (command.tool === "approval_resolve") {
        answer = String(result.resultado ?? result.erro ?? "Pendência processada.");
      } else if (command.tool === "ticket_assign_agent") {
        answer = result.erro
          ? String(result.erro)
          : `Pronto, reatribuí o chamado #${command.args.ticketId} ao agente ${result.atribuido}. Ele assume no próximo ciclo.`;
      } else if (command.tool === "ticket_assign_glpi_user") {
        answer = result.erro
          ? String(result.erro)
          : `Pronto, atribuí o chamado #${command.args.ticketId} a ${result.atribuido} (${result.username}).`;
      } else if (command.tool === "ticket_tasks_create") {
        const tasks = Array.isArray(result.tarefasCriadas)
          ? result.tarefasCriadas as Array<Record<string, unknown>>
          : [];
        answer = result.erro
          ? String(result.erro)
          : `Pronto, criei ${tasks.length} tarefas no chamado #${command.args.ticketId}${tasks.every((task) => task.concluida) ? " e marquei todas como concluídas" : ""}.`;
      } else {
        answer = "Pronto, ação executada com sucesso.";
      }
    } catch (error) {
      answer = `Não consegui executar a ação: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { answer: await saveAssistantMessage(channel, answer, model, source), model };
  }

  const directUserWorkloadQuery =
    /\b(?:o\s+que|oq|quais?|list\w*|mostr\w*)\b.*?\b(?:fazendo|chamados?|tickets?|nome\s+d[oa]|atribu[ií]d\w*)\b/i.test(
      message,
    );
  const operational = needsOperationalContext(message) && !directUserWorkloadQuery;
  const [contexts, snapshot] = operational
    ? await Promise.all([knowledge.searchKnowledge(message), operationalSnapshot()])
    : [[], ""];
  const recent = await prisma.managerMessage.findMany({
    where: { channel },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const hasDraft = Boolean(await plan.getDraft(channel));

  const systemInstruction = [
    "Você é o Gerente da Central AIOps e conversa naturalmente em português do Brasil.",
    "Seja humano, direto e contextual. Cumprimentos e conversa casual recebem respostas casuais.",
    "ESTILO: escreva em texto corrido e natural, como uma pessoa conversando. NÃO use markdown: nada de asteriscos para negrito ou itálico, nada de ** ou *. Se precisar enumerar, use hífens simples ou números (1., 2.), sem asteriscos. Evite títulos com # e tabelas.",
    "Você recebe e interpreta anexos enviados pelo usuário (imagens, áudios, vídeos e documentos PDF) em qualquer plataforma — web, Telegram e Slack. Quando houver um anexo, analise-o e responda ao que o usuário pediu (transcreva o áudio, descreva a imagem/vídeo, resuma o documento etc.).",
    "Não apresente chamados, alertas ou relatórios sem que o usuário peça ou sem que sejam necessários.",
    "Quando a pergunta for operacional, use o contexto recuperado como evidência e cite os chamados relevantes.",
    "Nunca invente estado, responsável, ação executada ou conteúdo de chamado.",
    "REGRA CRÍTICA: você só pode afirmar que comentou, registrou, anexou, criou tarefa/chamado, atribuiu ou solucionou se REALMENTE chamou a ferramenta correspondente (ticket_comment, ticket_attach, ticket_task, ticket_create, ticket_assign_glpi_user, ticket_solve ou tickets_bulk_comment_solve) NESTA resposta. É PROIBIDO dizer 'Pronto, atribuído/registrado/criado' sem ter chamado a ferramenta. Se o usuário pedir para registrar um texto que ele já enviou antes, chame ticket_comment com o conteúdo EXATO e COMPLETO daquela mensagem (não resuma).",
    "REGRA DE NÃO ALTERAÇÃO: frases como 'não registre', 'não comente', 'não altere', 'não quero que você registre' ou 'só investigue' têm prioridade absoluta. Nesses casos, não chame nenhuma ferramenta que escreva no GLPI, mesmo que a mensagem mencione verbos como fiz, testei, deploy ou números de chamados.",
    "Perguntas, hipóteses e pedidos de análise não são atualizações de chamado. Expressões como 'será que isso causou?', 'pode ter ocorrido algo?', 'isso originou o problema?' e referências cruzadas entre chamados servem como evidência para investigação, não como autorização para comentar.",
    "Quando não houver evidência suficiente, diga isso de forma simples e faça uma pergunta útil.",
    "",
    "## Produtos e acessos canônicos da Omni-Inbox",
    "BACKOFFICE é o produto Web administrativo da Omni-Inbox. Não confunda Backoffice com GLPI, Trello, Grafana, a Central AIOps ou os processos internos de suporte.",
    "Ambientes oficiais do Backoffice:",
    "- Desenvolvimento (dev): https://backoffice.omni-inbox.com",
    "- Homologação (homolog): https://backoffice.omni-inbox.com.br",
    "- Produção (prod): https://backoffice.omni-inbox.ai",
    "Quando perguntarem 'o que é o backoffice', explique que é o sistema Web administrativo da Omni-Inbox.",
    "Quando perguntarem onde acessar, conectar ou qual é o caminho do Backoffice, forneça diretamente esses três endereços e pergunte qual ambiente a pessoa deseja apenas se isso for necessário.",
    "",
    "## Contas GLPI vinculadas ao chat",
    "Quando esta conversa tiver conta GLPI, use my_tickets para identificar os chamados atribuídos à pessoa.",
    "Para 'coloque o chamado no meu nome' ou 'atribua para mim', use ticket_assign_glpi_user com self=true. A conta vem do vínculo desta conversa; não peça o nome novamente.",
    "Para atribuir a outra pessoa, use glpi_users_list e ticket_assign_glpi_user. ticket_assign_agent é exclusivo para agentes automáticos OpenCode/Claude.",
    "Você PODE enviar mensagens diretas a técnicos com message_glpi_user quando eles tiverem Slack e/ou Telegram vinculados à conta GLPI. Use para cobranças, lembretes e avisos. Nunca diga que essa capacidade não existe antes de consultar glpi_users_list.",
    "Para perguntas como 'o que o Diego está fazendo?' ou 'quais chamados estão no nome da Carla?', use tickets_by_glpi_user. Essa consulta é pelo técnico atribuído no GLPI e NÃO depende do vínculo da conversa. Não use my_tickets nesses casos.",
    "Ao apresentar a carga de um técnico, NÃO despeje o título bruto como explicação. Para cada chamado, mostre: número e status; resumo do que é; o que está sendo feito agora; progresso estimado em porcentagem; confiança da estimativa; próximo passo.",
    "O progresso retornado por tickets_by_glpi_user é uma ESTIMATIVA GERENCIAL baseada em status, tarefas, acompanhamentos e execução de agentes. Você pode e deve fornecê-la quando pedirem porcentagem ou previsão, mas sinalize que não é um campo oficial do GLPI e explique brevemente a base.",
    "Se a pergunta seguinte for 'quantos por cento?', 'qual a previsão?' ou equivalente, reutilize o técnico do contexto e chame tickets_by_glpi_user novamente para obter dados atuais.",
    "Se a mensagem estiver relacionada a um chamado, informe ticketId em message_glpi_user e preserve no texto o prazo, urgência e instruções solicitadas pelo usuário.",
    "Toda mensagem enviada com message_glpi_user gera uma solicitação rastreável. Quando o técnico responder no Slack ou Telegram, o sistema encaminha automaticamente a resposta ao canal solicitante. Para perguntas como 'ele respondeu?' ou 'qual foi o retorno?', use manager_requests_status e nunca diga que a comunicação é unidirecional.",
    "Para pedidos como 'no chamado #39, pede pro Claude subir para homologação', use ticket_delegate_agent. Essa ferramenta registra a instrução no chamado e atribui ao agente; não tente simular isso apenas com comentário.",
    "Atualizações de progresso declarativas e inequívocas ('fiz X', 'configurei Y'), sem pergunta, hipótese ou negativa, podem virar comentário no chamado com ticket_comment. Se a pessoa estiver explicando contexto para investigar outro problema, apenas investigue e responda.",
    "Mídia enviada deve ser anexada com ticket_attach (o ticket_attach já registra os arquivos; não duplique com um comentário manual).",
    "Ao receber imagem/arquivo numa conversa com conta GLPI: descreva brevemente o que a imagem mostra, identifique o chamado certo (pela legenda/contexto; se houver só um ativo, é esse; em dúvida real, pergunte qual) e chame ticket_attach com esse ticketId. Se a legenda trouxer uma informação (ex.: 'índice criado em prod'), registre-a também com ticket_comment. Na resposta, confirme o número do chamado e o que você entendeu — nunca responda de forma genérica.",
    "Use my_tickets e o histórico da conversa para escolher o chamado quando a pessoa não disser o número explicitamente.",
    "Comentário (ticket_comment) e TAREFA (ticket_task) são coisas diferentes no GLPI. Se a pessoa pedir 'tarefa' (concluída ou pendente), use ticket_task — nunca registre tarefa como comentário. done=true cria a tarefa já concluída.",
    "Quando pedirem duas ou mais tarefas, use ticket_tasks_create uma única vez com todos os itens. Expressões como 'prontas', 'concluídas' ou 'como feitas' significam done=true.",
    "Ordens administrativas explícitas que citam o número do chamado (criar tarefa, documentar/comentar ou finalizar) podem ser executadas mesmo que o chamado não esteja atribuído à conta humana da conversa; nesse caso a ação usa a conta técnica da integração. Relatos espontâneos de progresso continuam restritos aos chamados atribuídos à própria pessoa.",
    "Para comentar VÁRIOS chamados com o mesmo texto (ex.: 'coloca esse comentário nos chamados 5, 8, 12'), use tickets_comment_multi com todos os IDs de uma vez.",
    "Para SOLUCIONAR VÁRIOS chamados de uma só vez (ex.: 'finaliza os chamados X, Y, Z'), use tickets_solve_multi com todos os IDs de uma vez.",
    "Quando o usuário pedir para comentar E finalizar vários chamados, use tickets_bulk_comment_solve UMA única vez com todos os IDs. Expressões como 'todos esses chamados' e 'esses incidentes' referem-se à lista imediatamente anterior. Preserve a justificativa do usuário no comentário e não exija atribuição prévia.",
    "COMANDOS MISTOS: você pode chamar VÁRIAS ferramentas diferentes na MESMA resposta. Por exemplo, se o usuário disser 'coloca chamado 5 pra Carla, 8 pro Diego e adiciona comentário no 12', chame ticket_assign_glpi_user duas vezes e ticket_comment uma vez, TUDO na mesma rodada. Não precisa perguntar separadamente — execute tudo de uma só vez e resuma o que fez.",
    "O mesmo vale para combinações como 'coloca o 5 no nome do Diego e já coloca as tarefas que ele precisa': chame ticket_assign_glpi_user + ticket_get para analisar o chamado + ticket_tasks_create. Faça tudo em paralelo na mesma resposta.",
    "Quando a pessoa disser claramente 'pode finalizar', use ticket_solve com um resumo fiel do que ela informou.",
    "Relatos espontâneos só podem atualizar chamados atribuídos à conta GLPI da conversa. Ordens administrativas explícitas para IDs determinados, inclusive em lote, podem usar a conta técnica e não exigem atribuição prévia.",
    "",
    "## Criação de chamado avulso",
    "Você PODE criar chamados no GLPI com ticket_create. Quando o usuário pedir UM chamado (ex.: 'crie o chamado', 'abre um chamado com essa pesquisa'), chame ticket_create imediatamente com título claro e a descrição COMPLETA do que foi discutido/produzido na conversa (inclua a pesquisa inteira, critérios e fontes — não resuma demais). Nunca diga que não consegue criar chamados.",
    "Use tipo incidente só para problemas/falhas; demandas, pesquisas e melhorias são requisição.",
    "",
    "## Plano de chamados (lote de requisições)",
    "Quando o usuário pedir para planejar um objetivo (ex.: 'precisamos implantar SSO, planeje os chamados'):",
    "O planejamento é COLABORATIVO: o usuário desenha as tarefas junto com você, em quantas rodadas precisar.",
    "1. Faça perguntas para esclarecer escopo, ordem e dependências — só o necessário.",
    "2. Considere o inventário completo de chamados abaixo: não proponha duplicados e referencie chamados existentes como dependência quando fizer sentido (use ticket_get para ver detalhes).",
    "3. Use agents_list para sugerir responsáveis reais quando fizer sentido.",
    "4. Chame plan_propose com os itens (título, descrição, critérios de aceite, prioridade, dependências por ordem, responsável).",
    "5. Apresente o plano ao usuário em texto claro (numerado) e pergunte se aprova ou quer ajustes.",
    "6. Para ajustes, chame plan_propose novamente com o plano COMPLETO revisado.",
    "7. SOMENTE quando o usuário aprovar explicitamente na mensagem atual, chame plan_confirm.",
    "8. Após confirmar, informe os números dos chamados criados.",
    "NUNCA chame plan_confirm sem aprovação explícita — a ferramenta bloqueia e devolve erro.",
    "",
    "## Código-fonte (sempre atualizado)",
    "Você tem acesso de LEITURA ao código-fonte real dos projetos via code_projects, code_tree, code_read e code_search.",
    "Ao planejar tarefas técnicas, consulte o código para propor itens precisos (arquivos, módulos, dependências reais).",
    "O conteúdo vem direto do disco no momento da consulta — nunca presuma estrutura sem verificar.",
    "IMPORTANTE: o seu PRÓPRIO código-fonte (este middleware AIOps — Gerente, agentes, sync GLPI/Trello) também está em code_projects (a entrada marcada como 'Este sistema'). Quando perguntarem como você funciona ou pedirem para investigar seu comportamento, leia o seu código real com code_read/code_search em vez de adivinhar.",
    "",
    "## Execuções (one-shot) dos agentes",
    "Você acompanha o andamento das execuções dos agentes via runs_recent e detalha qualquer uma com run_get (saída, erro, código de saída).",
    "Quando o usuário perguntar por que um agente falhou, ou pedir para triar/diagnosticar uma execução, use runs_recent para achar a falha e run_get para ler a saída/erro reais e explicar a causa de forma direta.",
    "",
    "## Observabilidade do Grafana (ao vivo)",
    "Você acessa os três datasources reais: Loki via logs_query, Prometheus via metrics_query e Wazuh/OpenSearch via security_events_query.",
    "Quando perguntarem sobre logs ou erros de aplicação, use logs_query. Para CPU, RAM, disco, disponibilidade, HTTP ou latência, use metrics_query. Para SIEM, segurança, agentes Wazuh, regras ou MITRE, use security_events_query.",
    "Ao investigar se um deploy ligado a um chamado causou um alerta de outro chamado, consulte os dois chamados e correlacione horários, logs e métricas. Não registre comentários em nenhum deles sem um pedido explícito de escrita.",
    "Nunca diga que só tem acesso ao Loki. Cite dados reais retornados pelas ferramentas e diferencie logs, métricas e eventos de segurança.",
    "",
    "## Acesso SSH a servidores de projetos e Docker local",
    "Você TEM acesso SSH aos servidores remotos dos projetos cadastrados via ssh_exec. Use para verificar status de serviços (systemctl, docker ps, pm2 status), ler logs do sistema, checar processos em execução, uso de disco, health checks e qualquer outra depuração que exija acesso ao servidor.",
    "Para depuração do próprio middleware, omita projectName — o comando será executado localmente no host, com acesso total ao Docker Desktop. Exemplos: docker ps, docker logs aiops_middleware, docker stats --no-stream, docker logs glpi --tail 50.",
    "Antes de usar ssh_exec com projectName, liste os projetos disponíveis com code_projects para saber o nome exato. O comando é executado no servidor remoto configurado no projeto ou localmente via runner (modo PM2). A saída completa do comando é retornada.",
    "Use ssh_exec como complemento às ferramentas de observabilidade: se um serviço não aparece no Prometheus ou os logs do Loki estão desatualizados, conecte-se ao servidor para verificar o estado real do processo.",
    "NUNCA prometa verificar 'depois' — execute ssh_exec AGORA e responda com o resultado na mesma mensagem.",
    "",
    "## Pesquisa na internet",
    "Você TEM acesso à internet via web_search (Google). Use-a para preços e planos de fornecedores, documentação oficial, comparativos de produtos/serviços, notícias e qualquer informação externa ao ambiente.",
    "Nunca diga que não consegue pesquisar na web ou que isso 'precisa ser feito por uma pessoa' — chame web_search e responda com os dados encontrados, citando as fontes (URLs) retornadas.",
    "NUNCA prometa pesquisar ou verificar 'e depois te retorno': você não tem como agir depois da resposta. Chame web_search AGORA e entregue o resultado na mesma mensagem.",
    "Em planos de chamados, quando um item exigir pesquisa externa (ex.: 'avaliar tipos de conta de um fornecedor'), você mesmo pode fazer a validação com web_search e apresentar a recomendação.",
  ]
    .filter(Boolean)
    .join("\n");

  // O contexto volátil (plano em rascunho, snapshot, RAG) vai como turno de
  // conteúdo — e não no systemInstruction — para que as regras fixas e as
  // ferramentas acima sejam elegíveis ao context caching (entrada a ~10%).
  const dynamicContext = [
    hasDraft
      ? "ATENÇÃO: existe um plano em RASCUNHO neste canal (use plan_show para revê-lo)."
      : "",
    env.MANAGER_PROJECT_CONTEXT
      ? `## Contexto do projeto (definido pelo usuário)\n${env.MANAGER_PROJECT_CONTEXT}`
      : "",
    snapshot,
    contexts.length
      ? `## Contexto detalhado recuperado pelo RAG\n${contexts.join("\n---\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const contents: Content[] = recent.reverse().map((item) => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }],
  }));

  if (dynamicContext) {
    contents.unshift({
      role: "user",
      parts: [
        {
          text:
            "[Contexto do sistema — gerado automaticamente agora; não é mensagem do usuário]\n" +
            dynamicContext,
        },
      ],
    });
  }

  // Anexa a mídia ao último turno do usuário (o Gemini interpreta imagem,
  // áudio, vídeo e PDF nativamente via inlineData).
  if (attachments.length) {
    const last = contents[contents.length - 1];
    const mediaParts = attachments.map((a) => ({
      inlineData: { mimeType: a.mimeType, data: a.data },
    }));
    if (last && last.role === "user") {
      last.parts = [...(last.parts ?? []), ...mediaParts];
    } else {
      contents.push({ role: "user", parts: [{ text: message || "Analise o anexo." }, ...mediaParts] });
    }
  }

  let answer = "";
  let emptyRetries = 0;
  let promiseRetries = 0;
  let actionClaimRetries = 0;

  // Pedido imperativo de ação no GLPI (atribuir, registrar, criar...). Usado
  // pelo anti-alucinação: se o modelo responder sem executar NENHUMA
  // ferramenta de escrita, ele é forçado a executar ou perguntar.
  const mutationIntent =
    !/\?\s*$/.test(message.trim()) &&
    !hasNoWriteIntent(message) &&
    !isInvestigativeMessage(message) &&
    /\b(atribu(?:i|a|ir)|registr(?:a|e|ar)|coment(?:a|e|ar)|cri(?:a|e|ar)|abr(?:a|e|ir)|anex(?:a|e|ar)|finaliz(?:a|e|ar)|solucion(?:a|e|ar)|deleg(?:a|ue|ar)|coloc(?:a|que|ar)|tarefas?|atividades?)\b/i.test(
      message,
    );
  const ctx: ToolContext = { channel, userMessage: message, attachments };
  const executedTools = new Set<string>();
  const successfulMutations = new Set<string>();

  // Loop de function calling: executa ferramentas até o modelo responder em texto
  let cachedContent = await getManagerContextCache(ai, model, systemInstruction);

  for (let turn = 0; turn < 8; turn++) {
    // Com cache, systemInstruction e tools já estão no conteúdo cacheado e a
    // API rejeita redefini-los na requisição.
    let response: GenerateContentResponse;
    try {
      response = await ai.models.generateContent({
        model,
        contents,
        config: cachedContent
          ? { cachedContent, temperature: 0.5 }
          : {
              systemInstruction,
              tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
              temperature: 0.5,
            },
      });
    } catch (error) {
      if (!cachedContent) throw error;
      // Cache expirado/invalidado no servidor: refaz a chamada sem cache
      logger.warn({ err: errorSummary(error) }, "Falha com context cache; repetindo sem cache");
      managerCacheState = null;
      cachedContent = null;
      response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
          temperature: 0.5,
        },
      });
    }

    void usage.record({ model, feature: "manager", usage: response.usageMetadata });

    const calls = response.functionCalls ?? [];
    const u = response.usageMetadata;
    logger.info(
      {
        turn,
        finishReason: response.candidates?.[0]?.finishReason,
        callCount: calls.length,
        callNames: calls.map((c) => c.name),
        hasText: Boolean(response.text),
        tokensIn: u?.promptTokenCount,
        tokensOut: u?.candidatesTokenCount,
        tokensCached: u?.cachedContentTokenCount,
        tokensTotal: u?.totalTokenCount,
      },
      "Gerente: resposta do modelo",
    );
    if (calls.length === 0) {
      // O gemini-2.5-flash às vezes devolve um candidato vazio (sem texto e sem
      // tool call). Empurra o modelo a responder em texto e tenta de novo.
      if (!response.text && emptyRetries < 4) {
        emptyRetries++;
        const modelTurn = response.candidates?.[0]?.content;
        if (modelTurn) contents.push(modelTurn);
        contents.push({
          role: "user",
          parts: [{ text: "Responda agora em português, em texto corrido, com base no que já temos." }],
        });
        continue;
      }
      // Modelos lite às vezes PROMETEM agir depois ("vou pesquisar e te retorno")
      // em vez de chamar a ferramenta. Empurra a execução imediata.
      const promisesLater =
        /\b(?:vou|irei|vamos)\s+(?:pesquisar|verificar|buscar|consultar|levantar|analisar)\b|\bte\s+retorno\b|\bj[áa]\s+(?:te\s+)?(?:retorno|trago|envio)\b|\baguarde\b/i.test(
          response.text ?? "",
        );
      if (promisesLater && promiseRetries < 2) {
        promiseRetries++;
        const modelTurn = response.candidates?.[0]?.content;
        if (modelTurn) contents.push(modelTurn);
        contents.push({
          role: "user",
          parts: [
            {
              text:
                "Não prometa para depois: execute AGORA as ferramentas necessárias " +
                "(por exemplo web_search para pesquisa externa) e responda NESTA mensagem " +
                "com os resultados e as fontes.",
            },
          ],
        });
        continue;
      }
      // Anti-alucinação de ação: o usuário pediu uma ação de escrita, nenhuma
      // ferramenta de escrita rodou e a resposta não é uma pergunta de
      // esclarecimento → o modelo provavelmente está AFIRMANDO algo que não fez.
      const executedMutation = successfulMutations.size > 0;
      // "Pergunta" só inocenta se a resposta NÃO estiver afirmando a ação como
      // feita — um "Precisa de mais algo?" de cortesia não conta.
      const claimsDone =
        /\b(?:j[áa]\s+(?:est[áa]|foi)|pronto|feito|com\s+sucesso|atribu[ií]d[oa]|registrad[oa]|criad[oa]|anexad[oa]|solucionad[oa]|finalizad[oa])\b/i.test(
          response.text ?? "",
        );
      const asksClarification = (response.text ?? "").includes("?") && !claimsDone;
      if (mutationIntent && !executedMutation && !asksClarification && actionClaimRetries < 2) {
        actionClaimRetries++;
        const modelTurn = response.candidates?.[0]?.content;
        if (modelTurn) contents.push(modelTurn);
        contents.push({
          role: "user",
          parts: [
            {
              text:
                "ATENÇÃO: nenhuma ferramenta foi executada — portanto NADA foi feito no GLPI. " +
                "Execute AGORA a ferramenta correspondente ao pedido (ticket_assign_glpi_user para " +
                "atribuir, ticket_comment para comentar, ticket_create para criar, ticket_task para " +
                "tarefa, ticket_solve para finalizar um chamado ou tickets_bulk_comment_solve para " +
                "comentar e finalizar vários). Se faltar informação, pergunte ao usuário em " +
                "vez de afirmar que fez.",
            },
          ],
        });
        logger.warn(
          { channel, turn },
          "Gerente afirmou ação sem executar ferramenta — forçando execução",
        );
        continue;
      }
      answer = response.text || "Não consegui produzir uma resposta agora.";
      break;
    }

    const modelTurn = response.candidates?.[0]?.content;
    if (modelTurn) contents.push(modelTurn);

    const responseParts = [];
    for (const call of calls) {
      const name = call.name ?? "";
      let result: unknown;
      try {
        result = await executeManagerFunction(name, (call.args ?? {}) as Record<string, unknown>, ctx);
        executedTools.add(name);
        if (TICKET_MUTATION_TOOLS.has(name)) {
          const output = result as Record<string, unknown>;
          const ok =
            !output?.erro &&
            !(
              Array.isArray(output?.falhas) &&
              output.falhas.length > 0 &&
              Array.isArray(output?.sucesso) &&
              output.sucesso.length === 0
            );
          if (ok) successfulMutations.add(name);
        }
        logger.info({ tool: name, channel }, "Gerente executou ferramenta");
      } catch (error) {
        result = { erro: error instanceof Error ? error.message : String(error) };
        logger.warn({ tool: name, err: errorSummary(error) }, "Ferramenta do Gerente falhou");
      }
      responseParts.push({
        functionResponse: { name, response: { result } },
      });
    }
    contents.push({ role: "user", parts: responseParts });

    // Última iteração: força uma resposta em texto na próxima volta
    if (turn === 5) {
      answer = "Executei as ações solicitadas, mas não consegui formular o resumo final.";
    }
  }

  if (!answer) answer = "Não consegui produzir uma resposta agora.";

  // Rede de segurança contra alucinação de ação: o usuário pediu explicitamente
  // para REGISTRAR/COMENTAR algo no chamado e o modelo NÃO chamou ticket_comment.
  // Registra de verdade o texto substancial que a pessoa enviou antes.
  const explicitId = message.match(/(?:chamado|ticket|#)\s*#?(\d+)/i)?.[1];
  const wantsRegister =
    Boolean(explicitId) &&
    !hasNoWriteIntent(message) &&
    !isInvestigativeMessage(message) &&
    hasExplicitCommentIntent(message);
  if (wantsRegister && !executedTools.has("ticket_comment") && !executedTools.has("ticket_solve")) {
    try {
      const account = await chatAccounts.getAccountByChannel(channel);
      const ticketId = Number(explicitId!);
      // Mensagem substancial mais recente do usuário antes deste comando
      const prev = recent.find((m, i) => i > 0 && m.role === "user" && (m.content ?? "").trim().length >= 60);
      if (ticketId && prev) {
        if (account) await chatAccounts.assertCanManageTicket(channel, ticketId);
        if (await commentAlreadyExists(ticketId, prev.content)) {
          answer = `O conteúdo já está registrado no comentário do chamado #${ticketId}.`;
        } else {
          await glpi.addFollowup(ticketId, prev.content, account?.glpiUserId);
          logger.info({ ticketId }, "Comentário registrado pela rede de segurança (modelo não chamou a tool)");
          answer = `Pronto, registrei o conteúdo no comentário do chamado #${ticketId}.`;
        }
      }
    } catch (error) {
      logger.warn({ err: errorSummary(error) }, "Falha na rede de segurança de comentário");
    }
  }

  answer = await saveAssistantMessage(channel, answer, model, source);
  return { answer, model };
}
