-- CreateEnum
CREATE TYPE "ProjectComponentType" AS ENUM ('BACKEND_API', 'FRONTEND', 'WORKER', 'MOBILE', 'INFRA', 'LIBRARY', 'PACKAGE', 'DOCS', 'SCRIPT', 'AGENT', 'PAYMENT', 'AI_SERVICE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ProjectComponentStatus" AS ENUM ('DETECTED', 'CONFIRMED', 'IGNORED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AccessSubjectType" AS ENUM ('CHANNEL', 'GLPI_USER', 'AGENT', 'WEB_USER');

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('VIEWER', 'OPERATOR', 'DEVELOPER', 'MAINTAINER', 'ADMIN', 'AUDITOR');

-- CreateEnum
CREATE TYPE "ToolRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "component_id" UUID,
ADD COLUMN     "correlation_id" TEXT,
ADD COLUMN     "project_id" UUID;

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "allowed_tools" JSONB,
ADD COLUMN     "component_id" UUID,
ADD COLUMN     "project_id" UUID;

-- AlterTable
ALTER TABLE "codebase_projects" ADD COLUMN     "glpi_entity_id" INTEGER,
ADD COLUMN     "is_monorepo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "topology_last_scan_at" TIMESTAMP(3),
ADD COLUMN     "topology_status" TEXT NOT NULL DEFAULT 'NOT_SCANNED',
ADD COLUMN     "topology_summary" JSONB;

-- AlterTable
ALTER TABLE "incidents" ADD COLUMN     "component_id" UUID,
ADD COLUMN     "correlation_id" TEXT,
ADD COLUMN     "environment" TEXT,
ADD COLUMN     "project_id" UUID;

-- AlterTable
ALTER TABLE "ticket_plans" ADD COLUMN     "component_id" UUID,
ADD COLUMN     "project_id" UUID;

-- AlterTable
ALTER TABLE "token_usage" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "component_id" UUID,
ADD COLUMN     "project_id" UUID;

-- AlterTable
ALTER TABLE "tool_runs" ADD COLUMN     "component_id" UUID,
ADD COLUMN     "correlation_id" TEXT,
ADD COLUMN     "project_id" UUID;

-- CreateTable
CREATE TABLE "project_components" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "relative_path" TEXT NOT NULL,
    "absolute_path_hash" TEXT,
    "type" "ProjectComponentType" NOT NULL DEFAULT 'UNKNOWN',
    "status" "ProjectComponentStatus" NOT NULL DEFAULT 'DETECTED',
    "runtime" TEXT,
    "framework" TEXT,
    "package_manager" TEXT,
    "language" TEXT,
    "main_port" INTEGER,
    "detection_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "detected_by" JSONB,
    "metadata" JSONB,
    "glpi_entity_id" INTEGER,
    "owner_team" TEXT,
    "risk_level" TEXT,
    "documentation" TEXT,
    "overview" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_component_dependencies" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "from_component_id" UUID NOT NULL,
    "to_component_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'uses',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "evidence" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_component_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_access_grants" (
    "id" UUID NOT NULL,
    "subject_type" "AccessSubjectType" NOT NULL,
    "subject_key" TEXT NOT NULL,
    "project_id" UUID NOT NULL,
    "component_id" UUID,
    "role" "ProjectRole" NOT NULL DEFAULT 'VIEWER',
    "inherit_children" BOOLEAN NOT NULL DEFAULT false,
    "allowed_tools" JSONB NOT NULL DEFAULT '[]',
    "denied_tools" JSONB NOT NULL DEFAULT '[]',
    "allowed_environments" JSONB NOT NULL DEFAULT '[]',
    "requires_approval_for" JSONB NOT NULL DEFAULT '[]',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_session_scopes" (
    "channel" TEXT NOT NULL,
    "active_project_id" UUID,
    "active_component_id" UUID,
    "active_environment" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_session_scopes_pkey" PRIMARY KEY ("channel")
);

-- CreateIndex
CREATE INDEX "project_components_project_id_status_idx" ON "project_components"("project_id", "status");

-- CreateIndex
CREATE INDEX "project_components_glpi_entity_id_idx" ON "project_components"("glpi_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_components_project_id_relative_path_key" ON "project_components"("project_id", "relative_path");

-- CreateIndex
CREATE UNIQUE INDEX "project_components_project_id_slug_key" ON "project_components"("project_id", "slug");

-- CreateIndex
CREATE INDEX "project_component_dependencies_project_id_idx" ON "project_component_dependencies"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_component_dependencies_from_component_id_to_compone_key" ON "project_component_dependencies"("from_component_id", "to_component_id", "kind");

-- CreateIndex
CREATE INDEX "project_access_grants_subject_type_subject_key_idx" ON "project_access_grants"("subject_type", "subject_key");

-- CreateIndex
CREATE INDEX "project_access_grants_project_id_component_id_idx" ON "project_access_grants"("project_id", "component_id");

-- CreateIndex
CREATE INDEX "agent_runs_project_id_component_id_idx" ON "agent_runs"("project_id", "component_id");

-- CreateIndex
CREATE INDEX "agent_runs_correlation_id_idx" ON "agent_runs"("correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "codebase_projects_slug_key" ON "codebase_projects"("slug");

-- CreateIndex
CREATE INDEX "incidents_project_id_component_id_idx" ON "incidents"("project_id", "component_id");

-- CreateIndex
CREATE INDEX "incidents_correlation_id_idx" ON "incidents"("correlation_id");

-- CreateIndex
CREATE INDEX "token_usage_project_id_component_id_idx" ON "token_usage"("project_id", "component_id");

-- CreateIndex
CREATE INDEX "token_usage_channel_idx" ON "token_usage"("channel");

-- CreateIndex
CREATE INDEX "tool_runs_project_id_component_id_idx" ON "tool_runs"("project_id", "component_id");

-- CreateIndex
CREATE INDEX "tool_runs_correlation_id_idx" ON "tool_runs"("correlation_id");

-- AddForeignKey
ALTER TABLE "project_components" ADD CONSTRAINT "project_components_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "codebase_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_components" ADD CONSTRAINT "project_components_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "project_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_component_dependencies" ADD CONSTRAINT "project_component_dependencies_from_component_id_fkey" FOREIGN KEY ("from_component_id") REFERENCES "project_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_component_dependencies" ADD CONSTRAINT "project_component_dependencies_to_component_id_fkey" FOREIGN KEY ("to_component_id") REFERENCES "project_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_access_grants" ADD CONSTRAINT "project_access_grants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "codebase_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_access_grants" ADD CONSTRAINT "project_access_grants_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "project_components"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_session_scopes" ADD CONSTRAINT "manager_session_scopes_active_project_id_fkey" FOREIGN KEY ("active_project_id") REFERENCES "codebase_projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_session_scopes" ADD CONSTRAINT "manager_session_scopes_active_component_id_fkey" FOREIGN KEY ("active_component_id") REFERENCES "project_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

