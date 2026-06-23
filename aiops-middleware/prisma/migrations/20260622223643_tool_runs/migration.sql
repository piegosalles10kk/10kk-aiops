-- CreateEnum
CREATE TYPE "ToolKind" AS ENUM ('VISUAL', 'PENTEST', 'LOAD');

-- CreateTable
CREATE TABLE "tool_runs" (
    "id" UUID NOT NULL,
    "kind" "ToolKind" NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "channel" TEXT NOT NULL DEFAULT 'web',
    "target_url" TEXT,
    "repo_path" TEXT,
    "params" JSONB,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "generated_script" TEXT,
    "summary" TEXT,
    "report" TEXT,
    "report_pdf_path" TEXT,
    "findings" JSONB,
    "output" TEXT,
    "error" TEXT,
    "runner_run_id" TEXT,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tool_runs_kind_created_at_idx" ON "tool_runs"("kind", "created_at");
