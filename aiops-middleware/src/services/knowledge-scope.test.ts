import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildScopeFilter, type KnowledgeScope } from "./knowledge.service.js";

const PROJ_A = "11111111-1111-1111-1111-111111111111";
const PROJ_B = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const COMP_A = "22222222-2222-2222-2222-222222222222";

interface QdrantClause {
  is_empty?: { key: string };
  key?: string;
  match?: { any: string[] };
}

// ---------------------------------------------------------------------------
// buildScopeFilter — lógica que monta o filtro do Qdrant para scoping RAG
// Cenário 7: "RAG escopado"
// ---------------------------------------------------------------------------

describe("buildScopeFilter", () => {

  test("scope nulo → undefined (acesso irrestrito — admin/web)", () => {
    const result = buildScopeFilter(undefined);
    assert.equal(result, undefined);
  });

  test("projectIds = null → undefined (acesso irrestrito)", () => {
    const scope: KnowledgeScope = { projectIds: null, componentIds: null };
    const result = buildScopeFilter(scope);
    assert.equal(result, undefined);
  });

  test("projectIds vazio → só legacy (projectId is_empty) — sem acesso a escopado (cenário 7)", () => {
    const scope: KnowledgeScope = { projectIds: [], componentIds: [] };
    const result = buildScopeFilter(scope);
    assert.ok(result);
    const should = result!.should as QdrantClause[];
    assert.ok(should.some((s) => s.is_empty?.key === "projectId"));
    const matchClauses = should.filter((s) => s.key === "projectId");
    assert.equal(matchClauses.length, 0);
  });

  test("projectIds com valores → legacy + específicos (cenário 7)", () => {
    const scope: KnowledgeScope = { projectIds: [PROJ_A, PROJ_B], componentIds: [] };
    const result = buildScopeFilter(scope);
    assert.ok(result);
    const should = result!.should as QdrantClause[];
    assert.ok(should.some((s) => s.is_empty?.key === "projectId"));
    const matchClauses = should.filter((s) => s.key === "projectId");
    assert.equal(matchClauses.length, 1);
    const match = matchClauses[0]!.match;
    assert.deepEqual(match!.any, [PROJ_A, PROJ_B]);
  });

  test("projectIds com um valor → legacy + aquele projeto", () => {
    const scope: KnowledgeScope = { projectIds: [PROJ_A], componentIds: [] };
    const result = buildScopeFilter(scope);
    assert.ok(result);
    const should = result!.should as QdrantClause[];
    assert.ok(should.some((s) => s.is_empty?.key === "projectId"));
    const matchClauses = should.filter((s) => s.key === "projectId");
    assert.equal(matchClauses.length, 1);
    const match = matchClauses[0]!.match;
    assert.deepEqual(match!.any, [PROJ_A]);
  });

  test("componentIds não afetam a estrutura do filtro (ainda não usado)", () => {
    const scope: KnowledgeScope = { projectIds: [PROJ_A], componentIds: [COMP_A] };
    const result = buildScopeFilter(scope);
    assert.ok(result);
    const should = result!.should as QdrantClause[];
    assert.ok(should.some((s) => s.is_empty?.key === "projectId"));
    const compClauses = should.filter((s) => s.is_empty?.key === "componentId" || s.key === "componentId");
    assert.equal(compClauses.length, 0);
  });

});
