import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import * as topology from "../services/project-topology.service.js";
import * as access from "../services/project-access.service.js";
import * as scope from "../services/project-scope.service.js";
import * as glpiEntity from "../services/glpi-entity.service.js";
import {
  confirmTopologySchema,
  projectComponentSchema,
  accessGrantSchema,
  accessProfileSchema,
  applyAccessProfileSchema,
  managerScopeSchema,
} from "../schemas/project.schema.js";

/**
 * Rotas da feature de topologia/escopo/permissões. Mantém o CRUD básico de
 * projetos no command-center; aqui ficam só os endpoints novos. Montado em /api.
 */
export const projectRouter = Router();

const ACTOR = "ui";

// ---- Topologia ----
projectRouter.post("/projects/:id/topology/scan", async (req, res) => {
  try {
    res.json(await topology.scanProjectTopology(req.params.id, { actor: ACTOR }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

projectRouter.get("/projects/:id/topology", async (req, res) => {
  try {
    res.json(await topology.listProjectTopology(req.params.id));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

projectRouter.post("/projects/:id/topology/confirm", async (req, res) => {
  const parsed = confirmTopologySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  try {
    await topology.confirmProjectTopology(req.params.id, parsed.data, { actor: ACTOR });
    res.json(await topology.listProjectTopology(req.params.id));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

projectRouter.post("/projects/:id/glpi/sync", async (req, res) => {
  try {
    res.json(await glpiEntity.syncProjectEntities(req.params.id, ACTOR));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ---- Componentes ----
projectRouter.get("/projects/:id/components", async (req, res) => {
  res.json(await prisma.projectComponent.findMany({
    where: { projectId: req.params.id }, orderBy: { relativePath: "asc" },
  }));
});

projectRouter.put("/projects/:id/components/:componentId", async (req, res) => {
  const parsed = projectComponentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  try {
    const data = parsed.data;
    const updated = await prisma.projectComponent.update({
      where: { id: req.params.componentId },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.type ? { type: data.type } : {}),
        ...(data.status ? { status: data.status } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        ...(data.ownerTeam !== undefined ? { ownerTeam: data.ownerTeam } : {}),
        ...(data.riskLevel !== undefined ? { riskLevel: data.riskLevel } : {}),
        ...(data.framework !== undefined ? { framework: data.framework } : {}),
        ...(data.runtime !== undefined ? { runtime: data.runtime } : {}),
        ...(data.language !== undefined ? { language: data.language } : {}),
        ...(data.mainPort !== undefined ? { mainPort: data.mainPort } : {}),
        ...(data.documentation !== undefined ? { documentation: data.documentation } : {}),
        ...(data.metadata !== undefined ? { metadata: data.metadata as object } : {}),
      },
    });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

projectRouter.delete("/projects/:id/components/:componentId", async (req, res) => {
  await topology.ignoreComponent(req.params.componentId, { actor: ACTOR });
  res.status(204).end();
});

// ---- Permissões ----
projectRouter.get("/projects/:id/access", async (req, res) => {
  res.json(await access.listGrants(req.params.id));
});

projectRouter.post("/projects/:id/access", async (req, res) => {
  const parsed = accessGrantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  try {
    const grant = await access.grantAccess({ ...parsed.data, projectId: req.params.id, createdBy: ACTOR });
    res.status(201).json(grant);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

projectRouter.delete("/projects/:id/access/:grantId", async (req, res) => {
  await access.revokeAccess(req.params.grantId, ACTOR);
  res.status(204).end();
});

// ---- Perfis de acesso ----
projectRouter.get("/access-profiles", async (_req, res) => {
  res.json(await access.listProfiles());
});

projectRouter.post("/access-profiles", async (req, res) => {
  const parsed = accessProfileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  try {
    res.status(201).json(await access.createProfile({ ...parsed.data, createdBy: ACTOR }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

projectRouter.put("/access-profiles/:profileId", async (req, res) => {
  const parsed = accessProfileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  try {
    res.json(await access.updateProfile(req.params.profileId, parsed.data, ACTOR));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

projectRouter.delete("/access-profiles/:profileId", async (req, res) => {
  await access.deleteProfile(req.params.profileId, ACTOR);
  res.status(204).end();
});

projectRouter.post("/access-profiles/:profileId/apply", async (req, res) => {
  const parsed = applyAccessProfileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  try {
    res.json(await access.applyProfile({ profileId: req.params.profileId, ...parsed.data, createdBy: ACTOR }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ---- Escopo do Gerente ----
projectRouter.get("/manager/scope", async (req, res) => {
  const channel = String(req.query.channel ?? "web");
  res.json(await scope.getScope(channel));
});

projectRouter.put("/manager/scope", async (req, res) => {
  const parsed = managerScopeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  const { channel, ...input } = parsed.data;
  const result = await scope.setScope(channel, { ...input, updatedBy: ACTOR });
  res.status(result.ok ? 200 : 400).json(result);
});

projectRouter.delete("/manager/scope", async (req, res) => {
  const channel = String(req.query.channel ?? req.body?.channel ?? "web");
  await scope.clearScope(channel, ACTOR);
  res.status(204).end();
});
