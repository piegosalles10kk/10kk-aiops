CREATE TYPE "AgentProvider" AS ENUM ('OPENCODE', 'CLAUDE');
CREATE TYPE "AgentMode" AS ENUM ('ANALYZE', 'EXECUTE', 'REPORT', 'AUDIT');
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT');

CREATE TABLE "app_settings" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "secret" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "agents" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "provider" "AgentProvider" NOT NULL,
  "mode" "AgentMode" NOT NULL,
  "project_path" TEXT NOT NULL,
  "instructions" TEXT NOT NULL DEFAULT '',
  "model" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "glpi_user_id" INTEGER,
  "glpi_username" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_runs" (
  "id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "incident_id" UUID,
  "glpi_ticket_id" INTEGER,
  "glpi_task_id" INTEGER,
  "kind" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
  "output" TEXT,
  "error" TEXT,
  "exit_code" INTEGER,
  "duration_ms" INTEGER,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "manager_messages" (
  "id" UUID NOT NULL,
  "channel" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manager_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_logs" (
  "id" UUID NOT NULL,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entity_type" TEXT,
  "entity_id" TEXT,
  "details" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agents_glpi_user_id_key" ON "agents"("glpi_user_id");
CREATE INDEX "agent_runs_agent_id_created_at_idx" ON "agent_runs"("agent_id", "created_at");
CREATE INDEX "agent_runs_glpi_ticket_id_idx" ON "agent_runs"("glpi_ticket_id");
CREATE INDEX "manager_messages_channel_created_at_idx" ON "manager_messages"("channel", "created_at");
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
