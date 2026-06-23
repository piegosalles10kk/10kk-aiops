-- AlterTable
ALTER TABLE "codebase_projects" ADD COLUMN     "ssh_auth_type" TEXT DEFAULT 'pm2',
ADD COLUMN     "ssh_connected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ssh_host" TEXT,
ADD COLUMN     "ssh_key_path" TEXT,
ADD COLUMN     "ssh_password" TEXT,
ADD COLUMN     "ssh_port" INTEGER NOT NULL DEFAULT 22,
ADD COLUMN     "ssh_user" TEXT;
