DROP INDEX IF EXISTS "chat_accounts_glpi_user_id_key";
CREATE INDEX "chat_accounts_glpi_user_id_idx" ON "chat_accounts"("glpi_user_id");
