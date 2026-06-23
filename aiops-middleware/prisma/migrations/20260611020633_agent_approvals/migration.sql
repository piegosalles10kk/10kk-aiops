-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'GRANTED', 'DENIED');

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "elevated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "agent_approvals" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "run_id" UUID,
    "glpi_ticket_id" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_approvals_glpi_ticket_id_status_idx" ON "agent_approvals"("glpi_ticket_id", "status");

-- CreateIndex
CREATE INDEX "agent_approvals_status_idx" ON "agent_approvals"("status");

-- AddForeignKey
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
