-- CreateEnum
CREATE TYPE "CodebaseProjectStatus" AS ENUM ('PENDING', 'ANALYZING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "codebase_projects" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "project_path" TEXT NOT NULL,
    "description" TEXT,
    "overview" JSONB,
    "scores" JSONB,
    "documentation" TEXT,
    "status" "CodebaseProjectStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codebase_projects_pkey" PRIMARY KEY ("id")
);
