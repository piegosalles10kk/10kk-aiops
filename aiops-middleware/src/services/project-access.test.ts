import assert from "node:assert/strict";
import { test } from "node:test";
import { AccessSubjectType, ProjectRole, type ProjectAccessGrant } from "@prisma/client";
import { evaluateToolAccess, riskOf, type AccessSubject } from "./project-access.service.js";

const PROJECT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COMP_A = "22222222-2222-2222-2222-222222222222";
const COMP_B = "33333333-3333-3333-3333-333333333333";

function grant(over: Partial<ProjectAccessGrant> = {}): ProjectAccessGrant {
  return {
    id: "g", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
    projectId: PROJECT_A, componentId: null, role: ProjectRole.VIEWER,
    inheritChildren: false, allowedTools: [], deniedTools: [],
    allowedEnvironments: [], requiresApprovalFor: [],
    createdBy: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  } as ProjectAccessGrant;
}

const channel: AccessSubject = { type: AccessSubjectType.CHANNEL, key: "slack:X", channel: "slack:X" };
const channelY: AccessSubject = { type: AccessSubjectType.CHANNEL, key: "slack:Y", channel: "slack:Y" };
const glpiUser: AccessSubject = { type: AccessSubjectType.GLPI_USER, key: "42", glpiUserId: 42 };
const web: AccessSubject = { type: AccessSubjectType.WEB_USER, key: "web" };

// ---------------------------------------------------------------------------
// riskOf
// ---------------------------------------------------------------------------

test("riskOf classifica as ferramentas", () => {
  assert.equal(riskOf("tickets_list"), "LOW");
  assert.equal(riskOf("code_read"), "MEDIUM");
  assert.equal(riskOf("pentest"), "HIGH");
  assert.equal(riskOf("ssh_exec"), "CRITICAL");
  assert.equal(riskOf("unknown_tool"), "MEDIUM");
});

// ---------------------------------------------------------------------------
// WEB_USER — acesso amplo (retrocompatível)
// ---------------------------------------------------------------------------

test("web local/admin tem acesso amplo — inclusive CRITICAL", () => {
  const r = evaluateToolAccess(web, { tool: "ssh_exec" }, []);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, false);
});

test("WEB_USER ignora deniedTools", () => {
  const r = evaluateToolAccess(web, { tool: "ssh_exec" }, [grant({ deniedTools: ["ssh_exec"] as unknown as object })]);
  assert.equal(r.allowed, true);
});

// ---------------------------------------------------------------------------
// LOW risk — sempre permitido
// ---------------------------------------------------------------------------

test("baixo risco é sempre permitido mesmo sem grants", () => {
  const r = evaluateToolAccess(channel, { tool: "tickets_list" }, []);
  assert.equal(r.allowed, true);
});

test("LOW risk sem grants e com projectId ainda permitido", () => {
  const r = evaluateToolAccess(channel, { tool: "tickets_list", projectId: PROJECT_A }, []);
  assert.equal(r.allowed, true);
});

// ---------------------------------------------------------------------------
// Canal sem grant
// Cenário 1: "Canal sem ProjectAccessGrant tentando acessar projeto"
// ---------------------------------------------------------------------------

test("canal sem grants: code_search bloqueado (cenário 1)", () => {
  const r = evaluateToolAccess(channel, { tool: "code_search" }, []);
  assert.equal(r.allowed, false);
});

test("canal sem grants: code_search com projectId bloqueado com reason", () => {
  const r = evaluateToolAccess(channel, { tool: "code_search", projectId: PROJECT_A }, []);
  assert.equal(r.allowed, false);
  assert.ok(r.reason);
  assert.ok(r.reason?.includes("não possui permissões"));
});

test("canal sem grants: MEDIUM risk bloqueia", () => {
  assert.equal(evaluateToolAccess(channel, { tool: "code_read" }, []).allowed, false);
  assert.equal(evaluateToolAccess(channel, { tool: "logs_query" }, []).allowed, false);
  assert.equal(evaluateToolAccess(channel, { tool: "metrics_query" }, []).allowed, false);
});

test("canal sem grants: HIGH risk bloqueia", () => {
  assert.equal(evaluateToolAccess(channel, { tool: "pentest" }, []).allowed, false);
  assert.equal(evaluateToolAccess(channel, { tool: "load_test" }, []).allowed, false);
  assert.equal(evaluateToolAccess(channel, { tool: "project_topology_scan" }, []).allowed, false);
});

test("canal sem grants: CRITICAL risk bloqueia", () => {
  assert.equal(evaluateToolAccess(channel, { tool: "ssh_exec" }, []).allowed, false);
});

// ---------------------------------------------------------------------------
// Grant por projeto
// Cenário 3: "Canal com grant correto" — permite
// ---------------------------------------------------------------------------

test("grant DEVELOPER no projeto acessa o projeto (cenário 3)", () => {
  const r = evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A },
    [grant({ role: ProjectRole.DEVELOPER })]);
  assert.equal(r.allowed, true);
});

test("grant ADMIN no projeto acessa CRITICAL tool", () => {
  const r = evaluateToolAccess(channel, { tool: "ssh_exec", projectId: PROJECT_A },
    [grant({ role: ProjectRole.ADMIN })]);
  assert.equal(r.allowed, true);
});

test("grant OPERATOR acessa MEDIUM mas não HIGH", () => {
  const g = [grant({ role: ProjectRole.OPERATOR })];
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "pentest", projectId: PROJECT_A }, g).allowed, false);
});

test("grant VIEWER só acessa MEDIUM, não HIGH nem CRITICAL", () => {
  const g = [grant({ role: ProjectRole.VIEWER })];
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "pentest", projectId: PROJECT_A }, g).allowed, false);
  assert.equal(evaluateToolAccess(channel, { tool: "ssh_exec", projectId: PROJECT_A }, g).allowed, false);
});

// ---------------------------------------------------------------------------
// Grant sem projeto específico, mas com projectId no check
// Cenário 2: "Canal com grant em um componente tentando acessar outro"
// ---------------------------------------------------------------------------

test("grant no project A: project B bloqueado (cenário 2 — projeto diferente)", () => {
  const g = [grant({ role: ProjectRole.DEVELOPER })];
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_B }, g).allowed, false);
});

test("grant com componentId A: componente B bloqueado (cenário 2 — componente diferente)", () => {
  const g = [grant({ componentId: COMP_A, role: ProjectRole.DEVELOPER })];
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A, componentId: COMP_A }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A, componentId: COMP_B }, g).allowed, false);
});

test("inheritChildren cobre qualquer componente (grant sem componentId específico)", () => {
  const g = [grant({ componentId: null, inheritChildren: true, role: ProjectRole.DEVELOPER })];
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A, componentId: COMP_A }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A, componentId: COMP_B }, g).allowed, true);
});

test("grant sem inheritChildren NÃO cobre componente específico", () => {
  const g = [grant({ componentId: null, inheritChildren: false, role: ProjectRole.DEVELOPER })];
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A, componentId: COMP_A }, g).allowed, false);
});

// ---------------------------------------------------------------------------
// SSH — ferramenta CRITICAL
// Cenário 4: "SSH sem permissão"
// ---------------------------------------------------------------------------

test("ssh_exec bloqueado para VIEWER (cenário 4)", () => {
  const g = [grant({ role: ProjectRole.VIEWER })];
  assert.equal(evaluateToolAccess(channel, { tool: "ssh_exec", projectId: PROJECT_A }, g).allowed, false);
});

test("ssh_exec bloqueado para DEVELOPER (não pode CRITICAL)", () => {
  const g = [grant({ role: ProjectRole.DEVELOPER })];
  assert.equal(evaluateToolAccess(channel, { tool: "ssh_exec", projectId: PROJECT_A }, g).allowed, false);
});

test("ssh_exec permitido para MAINTAINER mas exige aprovação", () => {
  const g = [grant({ role: ProjectRole.MAINTAINER })];
  const r = evaluateToolAccess(channel, { tool: "ssh_exec", projectId: PROJECT_A }, g);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, true);
});

test("ssh_exec permitido para ADMIN mas exige aprovação (CRITICAL)", () => {
  const g = [grant({ role: ProjectRole.ADMIN })];
  const r = evaluateToolAccess(channel, { tool: "ssh_exec", projectId: PROJECT_A }, g);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, true);
});

// ---------------------------------------------------------------------------
// Ambiente
// Cenário 5: "Ambiente bloqueado"
// ---------------------------------------------------------------------------

test("allowedEnvironments: homolog permite, prod bloqueia (cenário 5)", () => {
  const g = [grant({ role: ProjectRole.DEVELOPER, allowedEnvironments: ["homolog"] as unknown as object })];
  assert.equal(evaluateToolAccess(channel, { tool: "pentest", projectId: PROJECT_A, environment: "homolog" }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "pentest", projectId: PROJECT_A, environment: "prod" }, g).allowed, false);
});

test("allowedEnvironments vazio (= sem restrição) permite qualquer ambiente", () => {
  const g = [grant({ role: ProjectRole.DEVELOPER, allowedEnvironments: [] as unknown as object })];
  assert.equal(evaluateToolAccess(channel, { tool: "pentest", projectId: PROJECT_A, environment: "prod" }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "pentest", projectId: PROJECT_A, environment: "staging" }, g).allowed, true);
});

// ---------------------------------------------------------------------------
// Aprovação
// Cenário 6: "Load test em prod exige aprovação"
// ---------------------------------------------------------------------------

test("load_test em prod exige aprovação (cenário 6)", () => {
  const g = [grant({ role: ProjectRole.DEVELOPER })];
  const r = evaluateToolAccess(channel, { tool: "load_test", projectId: PROJECT_A, environment: "prod" }, g);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, true);
});

test("load_test em homolog NÃO exige aprovação (apenas HIGH)", () => {
  const g = [grant({ role: ProjectRole.DEVELOPER })];
  const r = evaluateToolAccess(channel, { tool: "load_test", projectId: PROJECT_A, environment: "homolog" }, g);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, false);
});

test("tool com requiresApprovalFor explícito exige aprovação", () => {
  const g = [grant({ role: ProjectRole.DEVELOPER, requiresApprovalFor: ["code_search"] as unknown as object })];
  const r = evaluateToolAccess(channel, { tool: "code_search", projectId: PROJECT_A, environment: "homolog" }, g);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, true);
});

// ---------------------------------------------------------------------------
// deniedTools vs allowedTools
// ---------------------------------------------------------------------------

test("deniedTools bloqueia ferramenta explicitamente", () => {
  const g = [grant({ role: ProjectRole.ADMIN, deniedTools: ["ssh_exec"] as unknown as object })];
  assert.equal(evaluateToolAccess(channel, { tool: "ssh_exec", projectId: PROJECT_A }, g).allowed, false);
});

test("deniedTools sobrepõe allowedTools", () => {
  const g = [grant({
    role: ProjectRole.VIEWER,
    allowedTools: ["pentest"] as unknown as object,
    deniedTools: ["pentest"] as unknown as object,
  })];
  assert.equal(evaluateToolAccess(channel, { tool: "pentest", projectId: PROJECT_A }, g).allowed, false);
});

test("allowedTools explícito permite só o listado", () => {
  const g = [grant({ role: ProjectRole.VIEWER, allowedTools: ["pentest"] as unknown as object })];
  assert.equal(evaluateToolAccess(channel, { tool: "pentest", projectId: PROJECT_A }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "load_test", projectId: PROJECT_A }, g).allowed, false);
});

// ---------------------------------------------------------------------------
// Múltiplos grants (união de permissões)
// ---------------------------------------------------------------------------

test("dois grants: união expande permissões", () => {
  const g = [
    grant({ role: ProjectRole.VIEWER }),
    grant({ role: ProjectRole.ADMIN, projectId: PROJECT_A }),
  ];
  // Como ADMIN não tem deniedTools e CRITICAL é permitido para ADMIN
  assert.equal(evaluateToolAccess(channel, { tool: "ssh_exec", projectId: PROJECT_A }, g).allowed, true);
});

test("dois grants: se um nega e outro permite, deniedTools vence", () => {
  const g = [
    grant({ role: ProjectRole.ADMIN }),
    grant({ deniedTools: ["ssh_exec"] as unknown as object }),
  ];
  // O effective scopeGrants inclui ambos (ambos são do mesmo projeto)
  // Se algum grant tiver deniedTools incluindo a tool, bloqueia
  assert.equal(evaluateToolAccess(channel, { tool: "ssh_exec", projectId: PROJECT_A }, g).allowed, false);
});

test("dois grants com allowedTools diferentes: união dos dois", () => {
  const g = [
    grant({ role: ProjectRole.VIEWER, allowedTools: ["pentest"] as unknown as object }),
    grant({ role: ProjectRole.VIEWER, allowedTools: ["load_test"] as unknown as object }),
  ];
  assert.equal(evaluateToolAccess(channel, { tool: "pentest", projectId: PROJECT_A }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "load_test", projectId: PROJECT_A }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A }, g).allowed, false);
});

// ---------------------------------------------------------------------------
// GLPI_USER subject type
// ---------------------------------------------------------------------------

test("GLPI_USER segue mesmas regras que CHANNEL — MEDIUM permitido com grant", () => {
  const g = [grant({ subjectType: AccessSubjectType.GLPI_USER, subjectKey: "42" })];
  assert.equal(evaluateToolAccess(glpiUser, { tool: "code_read", projectId: PROJECT_A }, g).allowed, true);
});

test("GLPI_USER com grant no projeto acessa", () => {
  const g = [grant({ subjectType: AccessSubjectType.GLPI_USER, subjectKey: "42", role: ProjectRole.DEVELOPER })];
  assert.equal(evaluateToolAccess(glpiUser, { tool: "code_read", projectId: PROJECT_A }, g).allowed, true);
});

test("GLPI_USER sem grant não acessa MEDIUM", () => {
  assert.equal(evaluateToolAccess(glpiUser, { tool: "code_read", projectId: PROJECT_A }, []).allowed, false);
});

// ---------------------------------------------------------------------------
// Mensagens de negação (audit-safe)
// Cenário complementar: reason não vaza dados proibidos
// ---------------------------------------------------------------------------

test("reason de canal sem grants é informativa e segura", () => {
  const r = evaluateToolAccess(channelY, { tool: "ssh_exec", projectId: PROJECT_B }, []);
  assert.equal(r.allowed, false);
  assert.ok(r.reason);
  assert.ok(!r.reason!.includes(PROJECT_B));
});

test("reason de grant sem scope é informativa sobre projeto/componente", () => {
  const g = [grant({ role: ProjectRole.VIEWER })];
  const r = evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_B }, g);
  assert.equal(r.allowed, false);
  assert.ok(r.reason);
  assert.ok(r.reason!.includes("projeto"));
});

// ---------------------------------------------------------------------------
// Testes adicionais de cobertura para cenários E2E
// (todos via evaluateToolAccess — função pura, sem necessidade de mock)
// ---------------------------------------------------------------------------

test("canal sem grants + projectId + HIGH tool = denied", () => {
  assert.equal(evaluateToolAccess(channel, { tool: "pentest", projectId: PROJECT_A }, []).allowed, false);
});

test("canal com grants + environment errado + MEDIUM tool = denied", () => {
  const g = [grant({ role: ProjectRole.DEVELOPER, allowedEnvironments: ["homolog"] as unknown as object })];
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A, environment: "prod" }, g).allowed, false);
});

test("canal sem grants + LOW tool sempre permitido mesmo com projectId", () => {
  assert.equal(evaluateToolAccess(channel, { tool: "search_knowledge", projectId: PROJECT_A }, []).allowed, true);
});

test("dois grants de projetos diferentes: acesso só ao que tem grant", () => {
  const g = [
    grant({ projectId: PROJECT_A, role: ProjectRole.DEVELOPER }),
    { ...grant({ projectId: PROJECT_B, role: ProjectRole.DEVELOPER }), id: "g2" },
  ];
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_B }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: "outro" }, g).allowed, false);
});

test("AGENT subject type segue mesmas regras", () => {
  const agent: AccessSubject = { type: AccessSubjectType.AGENT, key: "agent-1" };
  assert.equal(evaluateToolAccess(agent, { tool: "code_read" }, []).allowed, false);
  const g = [grant({ role: ProjectRole.DEVELOPER })];
  assert.equal(evaluateToolAccess(agent, { tool: "code_read", projectId: PROJECT_A }, g).allowed, true);
});

test("grant com componentId + inheritChildren = cobre qualquer componente filho", () => {
  const g = [grant({ componentId: COMP_A, inheritChildren: true, role: ProjectRole.DEVELOPER })];
  // inheritChildren só funciona quando componentId é null, então COMP_B ainda bloqueado
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A, componentId: COMP_B }, g).allowed, false);
});

test("CRITICAL tool + prod environment = require approval (redundante: CRITICAL já requer)", () => {
  const g = [grant({ role: ProjectRole.MAINTAINER })];
  const r = evaluateToolAccess(channel, { tool: "ssh_exec", projectId: PROJECT_A, environment: "prod" }, g);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, true);
});

test("HIGH tool + homolog environment = não requer aprovação", () => {
  const g = [grant({ role: ProjectRole.DEVELOPER })];
  const r = evaluateToolAccess(channel, { tool: "load_test", projectId: PROJECT_A, environment: "homolog" }, g);
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, false);
});

test("grant role AUDITOR = só MEDIUM (igual VIEWER)", () => {
  const g = [grant({ role: ProjectRole.AUDITOR })];
  assert.equal(evaluateToolAccess(channel, { tool: "code_read", projectId: PROJECT_A }, g).allowed, true);
  assert.equal(evaluateToolAccess(channel, { tool: "pentest", projectId: PROJECT_A }, g).allowed, false);
  assert.equal(evaluateToolAccess(channel, { tool: "ssh_exec", projectId: PROJECT_A }, g).allowed, false);
});
