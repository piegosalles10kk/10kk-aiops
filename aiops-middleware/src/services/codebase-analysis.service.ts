import axios from "axios";
import { CodebaseProjectStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import * as settings from "./settings.service.js";

type CodebaseProject = {
  id: string;
  projectPath: string;
};

type AnalysisResult = {
  overview: {
    technology: string;
    features: string;
    architecture: string;
  };
  scores: {
    architecture: number;
    security: number;
    performance: number;
    technology: number;
    readability: number;
    monitoring: number;
    updateSupport: number;
  };
  documentation: string;
};

const ANALYSIS_PROMPT = `Você é um analista de código-fonte especializado. Sua tarefa é analisar COMPLETAMENTE esta codebase.

INSTRUÇÕES:
1. Explore a estrutura de diretórios, arquivos de configuração e código-fonte.
2. Identifique as tecnologias usadas (linguagens, frameworks, bibliotecas, bancos de dados, ferramentas).
3. Mapeie as principais funcionalidades e recursos do sistema.
4. Descreva a arquitetura geral (padrões, camadas, fluxos de dados).
5. Atribua notas de 0 a 10 para cada critério:
   - architecture: qualidade da arquitetura (separação de concerns, modularidade, padrões)
   - security: práticas de segurança (validação, autenticação, autorização, tratamento de dados sensíveis)
   - performance: desempenho (otimizações, caching, consultas, uso de recursos)
   - technology: escolha e uso de tecnologias (adequação, versões, modernidade)
   - readability: legibilidade do código (organização, nomenclatura, documentação inline)
   - monitoring: observabilidade e monitoramento (logs, métricas, tracing, health checks)
   - updateSupport: suporte a atualizações (facilidade de manutenção, testes, CI/CD, migrações)
6. Gere uma documentação COMPLETA da codebase em markdown, incluindo:
   - Visão geral do projeto
   - Stack tecnológico detalhado
   - Guia de arquitetura com diagrama textual
   - Guia de instalação e configuração
   - Estrutura de diretórios comentada
   - Funcionalidades detalhadas
   - API/Endpoints (se aplicável)
   - Modelo de dados
   - Considerações de segurança
   - Guia de desenvolvimento e contribuição

FORMATO DE RESPOSTA (JSON válido, sem texto antes ou depois):
{
  "overview": {
    "technology": "descrição das tecnologias...",
    "features": "descrição das funcionalidades...",
    "architecture": "descrição da arquitetura..."
  },
  "scores": {
    "architecture": 8,
    "security": 7,
    "performance": 6,
    "technology": 9,
    "readability": 8,
    "monitoring": 5,
    "updateSupport": 7
  },
  "documentation": "# Documentação da Codebase\n\n## Visão Geral\n..."
}`;

function parseAnalysisOutput(text: string): AnalysisResult | null {
  if (!text) return null;
  const jsonMatch = text.match(/\{[\s\S]*"overview"[\s\S]*"scores"[\s\S]*"documentation"[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.overview && parsed.scores && parsed.documentation) {
      return parsed as AnalysisResult;
    }
  } catch { }
  return null;
}

async function runnerEnv(): Promise<Record<string, string>> {
  const pairs = await Promise.all(
    ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENCODE_API_KEY"]
      .map(async (key) => [key, await settings.getSecret(key)] as const),
  );
  return Object.fromEntries(pairs.filter((pair): pair is [string, string] => Boolean(pair[1])));
}

export async function analyzeCodebase(project: CodebaseProject): Promise<void> {
  await prisma.codebaseProject.update({
    where: { id: project.id },
    data: { status: CodebaseProjectStatus.ANALYZING, error: null },
  });

  try {
    const headers = {
      Authorization: `Bearer ${process.env.RUNNER_TOKEN ?? "local-runner-token"}`,
    };

    type RunnerJob = {
      id: string;
      status: "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT";
      exitCode: number | null;
      stdout: string;
      stderr: string;
      durationMs: number;
    };

    const response = await axios.post<RunnerJob>(`${env.RUNNER_URL}/runs`, {
      provider: "OPENCODE",
      projectPath: project.projectPath,
      prompt: ANALYSIS_PROMPT,
      elevated: true,
      env: await runnerEnv(),
    }, { timeout: 30_000, headers });

    let result = response.data;

    while (result.status === "RUNNING") {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      result = (await axios.get<RunnerJob>(`${env.RUNNER_URL}/runs/${result.id}`, {
        timeout: 30_000, headers,
      })).data;
    }

    const succeeded = result.status === "SUCCEEDED";
    const output = result.stdout || result.stderr || "";

    if (!succeeded) {
      await prisma.codebaseProject.update({
        where: { id: project.id },
        data: {
          status: CodebaseProjectStatus.FAILED,
          error: result.stderr || "Análise falhou sem mensagem de erro",
        },
      });
      return;
    }

    const analysis = parseAnalysisOutput(output);
    if (!analysis) {
      await prisma.codebaseProject.update({
        where: { id: project.id },
        data: {
          status: CodebaseProjectStatus.FAILED,
          error: "Não foi possível extrair o JSON da análise do output do OpenCode",
        },
      });
      return;
    }

    await prisma.codebaseProject.update({
      where: { id: project.id },
      data: {
        status: CodebaseProjectStatus.COMPLETED,
        overview: analysis.overview,
        scores: analysis.scores,
        documentation: analysis.documentation,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.codebaseProject.update({
      where: { id: project.id },
      data: { status: CodebaseProjectStatus.FAILED, error: message },
    });
  }
}
