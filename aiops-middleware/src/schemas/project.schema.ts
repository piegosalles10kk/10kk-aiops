import { z } from "zod";

/** Schemas Zod da feature de topologia/escopo/permissões de projetos. */

export const componentTypeSchema = z.enum([
  "BACKEND_API", "FRONTEND", "WORKER", "MOBILE", "INFRA", "LIBRARY",
  "PACKAGE", "DOCS", "SCRIPT", "AGENT", "PAYMENT", "AI_SERVICE", "UNKNOWN",
]);

export const componentStatusSchema = z.enum(["DETECTED", "CONFIRMED", "IGNORED", "ARCHIVED"]);

export const subjectTypeSchema = z.enum(["CHANNEL", "GLPI_USER", "AGENT", "WEB_USER"]);

export const projectRoleSchema = z.enum(["VIEWER", "OPERATOR", "DEVELOPER", "MAINTAINER", "ADMIN", "AUDITOR"]);

export const confirmTopologySchema = z.object({
  components: z.array(z.object({
    relativePath: z.string().min(1),
    name: z.string().min(1).optional(),
    type: componentTypeSchema.optional(),
    enabled: z.boolean().optional(),
    status: componentStatusSchema.optional(),
    ownerTeam: z.string().nullable().optional(),
    riskLevel: z.string().nullable().optional(),
  })).min(1),
  createGlpiEntities: z.boolean().optional(),
});

export const projectComponentSchema = z.object({
  name: z.string().min(1).optional(),
  type: componentTypeSchema.optional(),
  status: componentStatusSchema.optional(),
  enabled: z.boolean().optional(),
  ownerTeam: z.string().nullable().optional(),
  riskLevel: z.string().nullable().optional(),
  framework: z.string().nullable().optional(),
  runtime: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  mainPort: z.number().int().nullable().optional(),
  documentation: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const accessGrantSchema = z.object({
  subjectType: subjectTypeSchema,
  subjectKey: z.string().min(1),
  componentId: z.string().uuid().nullable().optional(),
  role: projectRoleSchema.optional(),
  inheritChildren: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  allowedEnvironments: z.array(z.string()).optional(),
  requiresApprovalFor: z.array(z.string()).optional(),
});

export const accessProfileEntrySchema = z.object({
  projectId: z.string().uuid(),
  componentId: z.string().uuid().nullable().optional(),
  role: projectRoleSchema.optional(),
  inheritChildren: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  allowedEnvironments: z.array(z.string()).optional(),
  requiresApprovalFor: z.array(z.string()).optional(),
});

export const accessProfileSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(240).nullable().optional(),
  entries: z.array(accessProfileEntrySchema).min(1).max(50),
});

export const applyAccessProfileSchema = z.object({
  subjectType: subjectTypeSchema,
  subjectKey: z.string().min(1),
});

export const managerScopeSchema = z.object({
  channel: z.string().min(1),
  projectId: z.string().uuid().optional(),
  projectName: z.string().optional(),
  componentId: z.string().uuid().optional(),
  componentName: z.string().optional(),
  environment: z.string().nullable().optional(),
});

export type ConfirmTopologyBody = z.infer<typeof confirmTopologySchema>;
export type ProjectComponentBody = z.infer<typeof projectComponentSchema>;
export type AccessGrantBody = z.infer<typeof accessGrantSchema>;
export type AccessProfileBody = z.infer<typeof accessProfileSchema>;
export type ManagerScopeBody = z.infer<typeof managerScopeSchema>;
