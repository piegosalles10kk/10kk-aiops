CREATE TABLE "chat_accounts" (
    "id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "glpi_user_id" INTEGER NOT NULL,
    "glpi_username" TEXT NOT NULL,
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "chat_ticket_links" (
    "glpi_ticket_id" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "ticket_name" TEXT,
    "last_nudge_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_ticket_links_pkey" PRIMARY KEY ("glpi_ticket_id", "channel")
);

CREATE UNIQUE INDEX "chat_accounts_channel_key" ON "chat_accounts"("channel");
CREATE UNIQUE INDEX "chat_accounts_glpi_user_id_key" ON "chat_accounts"("glpi_user_id");
CREATE INDEX "chat_ticket_links_channel_idx" ON "chat_ticket_links"("channel");
