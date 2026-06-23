-- CreateTable
CREATE TABLE "token_usage" (
    "id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "agent_id" UUID,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "token_usage_created_at_idx" ON "token_usage"("created_at");

-- CreateIndex
CREATE INDEX "token_usage_model_idx" ON "token_usage"("model");

-- CreateIndex
CREATE INDEX "token_usage_feature_idx" ON "token_usage"("feature");
