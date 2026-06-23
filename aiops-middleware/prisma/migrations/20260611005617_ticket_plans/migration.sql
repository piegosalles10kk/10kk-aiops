-- CreateEnum
CREATE TYPE "TicketPlanStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ticket_plans" (
    "id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "status" "TicketPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "created_ticket_ids" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_plans_channel_status_idx" ON "ticket_plans"("channel", "status");
