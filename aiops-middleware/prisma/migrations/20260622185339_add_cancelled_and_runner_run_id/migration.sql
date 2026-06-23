-- AlterEnum
ALTER TYPE "AgentRunStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "runner_run_id" TEXT;
