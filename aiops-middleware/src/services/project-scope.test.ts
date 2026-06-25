import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { AccessSubjectType, type ProjectAccessGrant } from "@prisma/client";
import { evaluateToolAccess, type AccessSubject } from "./project-access.service.js";

const PROJECT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COMP_A = "22222222-2222-2222-2222-222222222222";
const COMP_B = "33333333-3333-3333-3333-333333333333";

// ---------------------------------------------------------------------------
// Testes de integração: escopo ativo + acesso a ferramentas
// Cenário: "O Gerente respeita o escopo ativo"
// ---------------------------------------------------------------------------

describe("ManagerScope + evaluateToolAccess", () => {

  test("escopo ativo com projectId correto: ferramenta permitida", () => {
    const subject: AccessSubject = { type: AccessSubjectType.CHANNEL, key: "slack:X" };
    const grants: ProjectAccessGrant[] = [
      {
        id: "g1", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
        projectId: PROJECT_A, componentId: null, role: "DEVELOPER" as any,
        inheritChildren: false, allowedTools: [], deniedTools: [],
        allowedEnvironments: [], requiresApprovalFor: [],
        createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      },
    ];
    const r = evaluateToolAccess(subject, { tool: "code_read", projectId: PROJECT_A }, grants);
    assert.equal(r.allowed, true);
  });

  test("escopo ativo com componentId errado: bloqueado", () => {
    const subject: AccessSubject = { type: AccessSubjectType.CHANNEL, key: "slack:X" };
    const grants: ProjectAccessGrant[] = [
      {
        id: "g1", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
        projectId: PROJECT_A, componentId: COMP_A, role: "DEVELOPER" as any,
        inheritChildren: false, allowedTools: [], deniedTools: [],
        allowedEnvironments: [], requiresApprovalFor: [],
        createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      },
    ];
    // Tem grant no COMP_A, mas tenta acessar COMP_B
    const r = evaluateToolAccess(subject, { tool: "code_read", projectId: PROJECT_A, componentId: COMP_B }, grants);
    assert.equal(r.allowed, false);
  });

  test("escopo ativo com ambiente não permitido: bloqueado", () => {
    const subject: AccessSubject = { type: AccessSubjectType.CHANNEL, key: "slack:X" };
    const grants: ProjectAccessGrant[] = [
      {
        id: "g1", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
        projectId: PROJECT_A, componentId: null, role: "DEVELOPER" as any,
        inheritChildren: false, allowedTools: [], deniedTools: [],
        allowedEnvironments: ["homolog"] as any, requiresApprovalFor: [],
        createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      },
    ];
    const r = evaluateToolAccess(subject, { tool: "load_test", projectId: PROJECT_A, environment: "prod" }, grants);
    assert.equal(r.allowed, false);
  });

  test("escopo ativo + kanr no projeto: ferramenta de alto risco exige aprovação em prod", () => {
    const subject: AccessSubject = { type: AccessSubjectType.CHANNEL, key: "slack:X" };
    const grants: ProjectAccessGrant[] = [
      {
        id: "g1", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
        projectId: PROJECT_A, componentId: null, role: "DEVELOPER" as any,
        inheritChildren: false, allowedTools: [], deniedTools: [],
        allowedEnvironments: [], requiresApprovalFor: [],
        createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      },
    ];
    const r = evaluateToolAccess(subject, { tool: "load_test", projectId: PROJECT_A, environment: "prod" }, grants);
    assert.equal(r.allowed, true);
    assert.equal(r.requiresApproval, true);
  });

  test("escopo ativo + sem grant: bloqueado com reason específica", () => {
    const subject: AccessSubject = { type: AccessSubjectType.CHANNEL, key: "slack:X" };
    const grants: ProjectAccessGrant[] = [
      {
        id: "g1", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
        projectId: PROJECT_B, componentId: null, role: "DEVELOPER" as any,
        inheritChildren: false, allowedTools: [], deniedTools: [],
        allowedEnvironments: [], requiresApprovalFor: [],
        createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      },
    ];
    const r = evaluateToolAccess(subject, { tool: "code_search", projectId: PROJECT_A }, grants);
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes("projeto") || r.reason?.includes("componente"));
  });

});

// ---------------------------------------------------------------------------
// Testes: negação de acesso gera auditoria (verificação do padrão)
// ---------------------------------------------------------------------------

describe("AuditLog em negações", () => {

  test("evaluateToolAccess devolve reason quando nega", () => {
    const subject: AccessSubject = { type: AccessSubjectType.CHANNEL, key: "slack:X" };
    const r = evaluateToolAccess(subject, { tool: "pentest" }, []);
    assert.equal(r.allowed, false);
    assert.ok(r.reason);
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason!.length > 0);
  });

  test("deniedTools devolve reason específica", () => {
    const subject: AccessSubject = { type: AccessSubjectType.CHANNEL, key: "slack:X" };
    const grants: ProjectAccessGrant[] = [
      {
        id: "g1", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
        projectId: PROJECT_A, componentId: null, role: "ADMIN" as any,
        inheritChildren: false, allowedTools: [], deniedTools: ["ssh_exec"] as any,
        allowedEnvironments: [], requiresApprovalFor: [],
        createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      },
    ];
    const r = evaluateToolAccess(subject, { tool: "ssh_exec", projectId: PROJECT_A }, grants);
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes("negada"));
  });

  test("ambiente não permitido devolve reason específica", () => {
    const subject: AccessSubject = { type: AccessSubjectType.CHANNEL, key: "slack:X" };
    const grants: ProjectAccessGrant[] = [
      {
        id: "g1", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
        projectId: PROJECT_A, componentId: null, role: "DEVELOPER" as any,
        inheritChildren: false, allowedTools: [], deniedTools: [],
        allowedEnvironments: ["homolog"] as any, requiresApprovalFor: [],
        createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      },
    ];
    const r = evaluateToolAccess(subject, { tool: "code_read", projectId: PROJECT_A, environment: "prod" }, grants);
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes("Ambiente") || r.reason?.includes("ambiente"));
  });

});

// ---------------------------------------------------------------------------
// Testes: o Gerente respeita o escopo ativo (integração manager.service.ts)
// Cenário: guardTool com escopo ativo
// ---------------------------------------------------------------------------

describe("guardTool pattern com escopo", () => {

  function simulateGuardTool(
    subject: AccessSubject,
    tool: string,
    scope: { projectId?: string; componentId?: string; environment?: string },
    grants: ProjectAccessGrant[],
  ): { allowed: boolean; reason?: string } {
    const r = evaluateToolAccess(subject, {
      tool,
      projectId: scope.projectId ?? null,
      componentId: scope.componentId ?? null,
      environment: scope.environment ?? null,
    }, grants);
    if (r.allowed) return { allowed: true };
    return { allowed: false, reason: r.reason };
  }

  const channel: AccessSubject = { type: AccessSubjectType.CHANNEL, key: "slack:X" };
  const grants: ProjectAccessGrant[] = [
    {
      id: "g1", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
      projectId: PROJECT_A, componentId: null, role: "DEVELOPER" as any,
      inheritChildren: false, allowedTools: [], deniedTools: [],
      allowedEnvironments: [], requiresApprovalFor: [],
      createdBy: null, createdAt: new Date(), updatedAt: new Date(),
    },
  ];

  test("code_search com escopo correto: permite", () => {
    const r = simulateGuardTool(channel, "code_search", { projectId: PROJECT_A }, grants);
    assert.equal(r.allowed, true);
  });

  test("code_search sem grants: bloqueia", () => {
    const r = simulateGuardTool(channel, "code_search", { projectId: PROJECT_A }, []);
    assert.equal(r.allowed, false);
  });

  test("ssh_exec sem permissão de role: bloqueia", () => {
    const r = simulateGuardTool(channel, "ssh_exec", { projectId: PROJECT_A }, grants);
    assert.equal(r.allowed, false);
  });

  test("project_topology_scan com grant ADMIN: permite", () => {
    const adminGrants: ProjectAccessGrant[] = [
      {
        id: "g2", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
        projectId: PROJECT_A, componentId: null, role: "ADMIN" as any,
        inheritChildren: false, allowedTools: [], deniedTools: [],
        allowedEnvironments: [], requiresApprovalFor: [],
        createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      },
    ];
    const r = simulateGuardTool(channel, "project_topology_scan", { projectId: PROJECT_A }, adminGrants);
    assert.equal(r.allowed, true);
  });

  test("project_update com VIEWER: bloqueia (VIEWER não pode HIGH)", () => {
    const viewerGrants: ProjectAccessGrant[] = [
      {
        id: "gv", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
        projectId: PROJECT_A, componentId: null, role: "VIEWER" as any,
        inheritChildren: false, allowedTools: [], deniedTools: [],
        allowedEnvironments: [], requiresApprovalFor: [],
        createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      },
    ];
    const r = simulateGuardTool(channel, "project_update", { projectId: PROJECT_A }, viewerGrants);
    assert.equal(r.allowed, false);
  });

  test("project_topology_confirm com grant ADMIN: permite", () => {
    const adminGrants: ProjectAccessGrant[] = [
      {
        id: "g3", subjectType: AccessSubjectType.CHANNEL, subjectKey: "slack:X",
        projectId: PROJECT_A, componentId: null, role: "ADMIN" as any,
        inheritChildren: false, allowedTools: [], deniedTools: [],
        allowedEnvironments: [], requiresApprovalFor: [],
        createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      },
    ];
    const r = simulateGuardTool(channel, "project_topology_confirm", { projectId: PROJECT_A }, adminGrants);
    assert.equal(r.allowed, true);
  });

  test("canal sem grant nenhum: toda tool HIGH+ bloqueia com reason", () => {
    const r = simulateGuardTool(channel, "pentest", { projectId: PROJECT_A }, []);
    assert.equal(r.allowed, false);
    assert.ok(r.reason);
  });

});
