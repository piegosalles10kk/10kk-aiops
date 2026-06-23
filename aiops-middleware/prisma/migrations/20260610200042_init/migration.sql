-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "grafana_alert_id" TEXT NOT NULL,
    "glpi_ticket_id" INTEGER,
    "trello_card_id" TEXT,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "ai_analysis" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "incidents_grafana_alert_id_key" ON "incidents"("grafana_alert_id");

-- CreateIndex
CREATE INDEX "incidents_status_idx" ON "incidents"("status");
