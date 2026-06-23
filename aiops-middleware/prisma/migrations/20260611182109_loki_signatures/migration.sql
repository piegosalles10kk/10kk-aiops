-- CreateTable
CREATE TABLE "loki_signatures" (
    "fingerprint" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "err_type" TEXT,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loki_signatures_pkey" PRIMARY KEY ("fingerprint")
);

-- CreateIndex
CREATE INDEX "loki_signatures_environment_service_idx" ON "loki_signatures"("environment", "service");
