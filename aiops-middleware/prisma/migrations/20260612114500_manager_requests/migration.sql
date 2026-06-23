CREATE TABLE "manager_requests" (
    "id" UUID NOT NULL,
    "requester_channel" TEXT NOT NULL,
    "target_glpi_user_id" INTEGER NOT NULL,
    "target_username" TEXT NOT NULL,
    "target_name" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "ticket_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "response" TEXT,
    "answered_channel" TEXT,
    "answered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manager_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "manager_requests_target_glpi_user_id_status_created_at_idx"
ON "manager_requests"("target_glpi_user_id", "status", "created_at");

CREATE INDEX "manager_requests_requester_channel_created_at_idx"
ON "manager_requests"("requester_channel", "created_at");
