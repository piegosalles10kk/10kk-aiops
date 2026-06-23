import axios from "axios";
import { AgentRunStatus, type Agent } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import * as audit from "./audit.service.js";
import { getSecret } from "./settings.service.js";

const IMMUTABLE_INSTRUCTIONS = `
Você opera dentro da Central AIOps integrada ao GLPI e Trello.
Leia todo o conteúdo disponível do chamado antes de agir.
O orquestrador abriu uma tarefa GLPI específica para esta execução.
Descreva cada passo executado, comandos, arquivos alterados e evidências para que tudo seja registrado nessa tarefa.
Ao terminar, produza uma conclusão completa para preencher a tarefa GLPI, incluindo resultado, validações, riscos e próximos passos.
O orquestrador registrará sua conclusão e o tempo real da execução na tarefa.
Você jamais pode solucionar ou fechar o chamado.
Ao terminar, o chamado deve permanecer PENDENTE para revisão humana.
Não acesse caminhos fora do projeto fornecido.
IMPORTANTE — APROVAÇÃO: se você for bloqueado por falta de permissão (escrita de arquivo, execução de comando, acesso de rede etc.) e não conseguir concluir, NÃO tente contornar. Em vez disso, inclua no final da resposta uma única linha exatamente neste formato: "NEEDS_APPROVAL: <descrição curta e específica do que precisa ser autorizado>". Use essa linha apenas quando realmente precisar de autorização humana para prosseguir.
`.trim();

function modeInstruction(mode: Agent["mode"]): string {
  return {
    ANALYZE: "Somente analise. Não altere arquivos nem execute comandos que modifiquem o ambiente.",
    EXECUTE: "Analise e execute as correções necessárias dentro do projeto autorizado.",
    REPORT: "Produza um relatório técnico, sem alterar arquivos.",
    AUDIT: "Audite o projeto e apresente riscos, evidências e recomendações, sem alterações.",
  }[mode];
}

async function runnerEnv(): Promise<Record<string, string>> {
  const pairs = await Promise.all(
    ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENCODE_API_KEY"]
      .map(async (key) => [key, await getSecret(key)] as const),
  );
  return Object.fromEntries(pairs.filter((pair): pair is [string, string] => Boolean(pair[1])));
}

export function buildPrompt(
  agent: Agent,
  message: string,
  ticketContext?: string,
  globalPrompt?: string,
  projectInstructions?: string,
): string {
  const sections = [
    globalPrompt ? "# PROMPT GLOBAL" : "",
    globalPrompt ?? "",
    "# AMBIENTE IMUTÁVEL", IMMUTABLE_INSTRUCTIONS,
    "# PERFIL", modeInstruction(agent.mode),
    "# INSTRUÇÕES DO USUÁRIO", agent.instructions || "(sem instruções adicionais)",
    projectInstructions ? `# INSTRUÇÕES DO PROJETO\n${projectInstructions}` : "",
    ticketContext ? `# CHAMADO GLPI\n${ticketContext}` : "",
    "# SOLICITAÇÃO", message,
    "# FORMATO FINAL",
    "Responda com um resumo objetivo contendo status, ações realizadas, evidências e próximos passos.",
  ].filter(Boolean);

  // O modo oneshot dos CLIs recebe toda a configuração e o chamado em um
  // único argumento e em uma única linha. JSON.stringify mantém estruturas
  // do chamado legíveis sem inserir quebras físicas no comando.
  return sections
    .map((section) => section.replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim())
    .join(" | ");
}

export async function executeAgent(input: {
  agent: Agent;
  message: string;
  kind: "TEST" | "TICKET" | "CHAT";
  ticketContext?: string;
  glpiTicketId?: number;
  glpiTaskId?: number;
  incidentId?: string;
  elevated?: boolean;
  rawPrompt?: string;
}) {
  const prompt = input.rawPrompt ?? await (async () => {
    const [globalPrompt, project] = await Promise.all([
      getSecret("GLOBAL_AGENT_PROMPT"),
      prisma.codebaseProject.findFirst({
        where: { projectPath: input.agent.projectPath },
        select: { instructions: true },
      }),
    ]);
    return buildPrompt(input.agent, input.message, input.ticketContext, globalPrompt, project?.instructions ?? undefined);
  })();
  const run = await prisma.agentRun.create({
    data: {
      agentId: input.agent.id,
      incidentId: input.incidentId,
      glpiTicketId: input.glpiTicketId,
      glpiTaskId: input.glpiTaskId,
      kind: input.kind,
      prompt,
      status: AgentRunStatus.RUNNING,
      elevated: input.elevated ?? false,
      startedAt: new Date(),
    },
  });
  try {
    type RunnerJob = {
      id: string;
      status: "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
      exitCode: number | null;
      stdout: string;
      stderr: string;
      durationMs: number;
    };
    const headers = {
      Authorization: `Bearer ${process.env.RUNNER_TOKEN ?? "local-runner-token"}`,
    };
    const response = await axios.post<RunnerJob>(`${env.RUNNER_URL}/runs`, {
      provider: input.agent.provider,
      projectPath: input.agent.projectPath,
      prompt,
      model: input.agent.model,
      elevated: input.elevated ?? false,
      env: await runnerEnv(),
    }, {
      timeout: 30_000,
      headers,
    });
    let result = response.data;
    // Salva o ID da execução no runner para permitir cancelamento
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { runnerRunId: result.id },
    });
    while (result.status === "RUNNING") {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      // Verifica se foi cancelado pelo usuário
      const current = await prisma.agentRun.findUnique({
        where: { id: run.id },
        select: { status: true },
      });
      if (current?.status === "CANCELLED") {
        result.status = "CANCELLED";
        result.stdout = (result.stdout || "") + "\n[Cancelado pelo usuário]";
        break;
      }
      result = (await axios.get<RunnerJob>(`${env.RUNNER_URL}/runs/${result.id}`, {
        timeout: 30_000,
        headers,
      })).data;
      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          output: result.stdout || null,
          error: result.stderr || null,
          durationMs: result.durationMs,
        },
      });
    }
    const status = result.status === "CANCELLED"
      ? AgentRunStatus.CANCELLED
      : result.status === "TIMED_OUT"
        ? AgentRunStatus.TIMED_OUT
        : result.status === "SUCCEEDED" ? AgentRunStatus.SUCCEEDED : AgentRunStatus.FAILED;
    const updated = await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status,
        output: result.stdout,
        error: result.stderr || null,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        finishedAt: new Date(),
      },
    });
    await audit.record("system", "agent.run", "Agent", input.agent.id, {
      runId: run.id, kind: input.kind, status,
    });
    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return prisma.agentRun.update({
      where: { id: run.id },
      data: { status: AgentRunStatus.FAILED, error: message, finishedAt: new Date() },
    });
  }
}

/**
 * Detecta, no output de uma execução, sinais de que o CLI bloqueou o agente
 * por falta de permissão (modo não-interativo nega aprovações). Retorna um
 * resumo curto do que precisa ser liberado, ou null se nada foi bloqueado.
 */
export function detectPermissionBlock(text: string): string | null {
  if (!text) return null;

  // 1) Marcador explícito: o Claude segue a instrução do prompt imutável e
  //    declara o bloqueio com esta linha. O agente NÃO a emite quando conclui,
  //    então não há falso-positivo por narração de bloqueios passados.
  const marker = text.match(/NEEDS_APPROVAL:\s*(.+)/i);
  if (marker?.[1]) {
    return marker[1].trim().replace(/["`*]+$/g, "").slice(0, 300);
  }

  // 2) OpenCode não segue o marcador: ele auto-rejeita a chamada de ferramenta
  //    e o CLI emite uma linha literal no momento da negação. Esse formato
  //    ("permission requested: <ação>; auto-rejecting") é gerado pelo CLI, não
  //    pela prosa do agente, e não aparece quando a execução é elevada (allow).
  const oc = text.match(/permission requested:\s*([^\n]+?)\s*;?\s*auto-reject/i);
  if (oc?.[1]) {
    return `permissão para ${oc[1].trim()}`.slice(0, 300);
  }
  if (/rejected permission to use this specific tool/i.test(text)) {
    return "permissão para uma ferramenta/comando bloqueado pelo CLI";
  }

  return null;
}

export async function testAgent(agent: Agent, message?: string) {
  const run = await executeAgent({
    agent,
    kind: "TEST",
    message: message ?? [
      "Faça um teste somente leitura. Confirme o diretório atual, verifique se consegue",
      "ler a estrutura do projeto e termine exatamente com a linha AGENT_TEST_OK.",
      "Não altere nenhum arquivo.",
    ].join(" "),
  });
  if (run.status === AgentRunStatus.SUCCEEDED && !run.output?.includes("AGENT_TEST_OK")) {
    return prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: AgentRunStatus.FAILED,
        error: [
          run.error,
          "O CLI encerrou sem retornar o marcador AGENT_TEST_OK.",
          "Verifique a configuração/modelo do CLI no Windows.",
        ].filter(Boolean).join("\n"),
      },
    });
  }
  return run;
}
