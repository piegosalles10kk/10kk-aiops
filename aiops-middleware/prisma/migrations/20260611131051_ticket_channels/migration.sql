-- CreateTable
CREATE TABLE "ticket_channels" (
    "glpi_ticket_id" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_channels_pkey" PRIMARY KEY ("glpi_ticket_id")
);
