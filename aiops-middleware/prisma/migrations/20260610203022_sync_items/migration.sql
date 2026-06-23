-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('FOLLOWUP', 'TASK');

-- AlterTable
ALTER TABLE "incidents" ADD COLUMN     "assigned_tech_name" TEXT;

-- CreateTable
CREATE TABLE "sync_items" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "glpi_id" INTEGER NOT NULL,
    "trello_id" TEXT NOT NULL,
    "last_state" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_items_incident_id_idx" ON "sync_items"("incident_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_items_kind_glpi_id_key" ON "sync_items"("kind", "glpi_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_items_kind_trello_id_key" ON "sync_items"("kind", "trello_id");

-- AddForeignKey
ALTER TABLE "sync_items" ADD CONSTRAINT "sync_items_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
