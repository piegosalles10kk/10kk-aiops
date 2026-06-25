CREATE TABLE "project_access_profiles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "entries" JSONB NOT NULL DEFAULT '[]',
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_access_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_access_profiles_name_key" ON "project_access_profiles"("name");
