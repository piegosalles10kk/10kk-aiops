import { Client as SshClient, type ConnectConfig } from "ssh2";
import axios from "axios";
import { readFile } from "node:fs/promises";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

export interface SshConnection {
  host: string;
  port: number;
  user: string;
  authType: "key" | "password" | "pm2";
  keyPath?: string | null;
  password?: string | null;
}

export interface SshExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export interface SshTestResult {
  success: boolean;
  error?: string;
  hostInfo?: string;
}

function buildSshConfig(project: {
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  sshAuthType?: string | null;
  sshKeyPath?: string | null;
  sshPassword?: string | null;
  projectPath?: string | null;
}): SshConnection {
  const authType = (project.sshAuthType as SshConnection["authType"]) || "pm2";
  return {
    host: project.sshHost || "",
    port: project.sshPort || 22,
    user: project.sshUser || "root",
    authType,
    keyPath: project.sshKeyPath,
    password: project.sshPassword,
  };
}

function ssh2Connect(config: ConnectConfig): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    client.on("ready", () => resolve(client));
    client.on("error", reject);
    client.connect(config);
  });
}

function ssh2Exec(client: SshClient, command: string): Promise<SshExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    client.exec(command, (err, stream) => {
      if (err) {
        client.end();
        return resolve({ success: false, stdout: "", stderr: err.message, exitCode: null, durationMs: Date.now() - started });
      }
      stream.on("data", (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      stream.on("close", (exitCode: number | null) => {
        client.end();
        resolve({
          success: exitCode === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode,
          durationMs: Date.now() - started,
        });
      });
    });
  });
}

function makeConnectConfig(conn: SshConnection): ConnectConfig {
  const config: ConnectConfig = {
    host: conn.host,
    port: conn.port,
    username: conn.user,
    readyTimeout: 10_000,
    keepaliveInterval: 0,
  };
  if (conn.authType === "key" && conn.keyPath) {
    config.privateKey = conn.keyPath;
  } else if (conn.authType === "password" && conn.password) {
    config.password = conn.password;
  }
  return config;
}

async function execRemote(conn: SshConnection, command: string): Promise<SshExecResult> {
  if (conn.authType === "key" && conn.keyPath) {
    try {
      const buf = await readFile(conn.keyPath);
      conn.keyPath = buf.toString("utf8");
    } catch {
      // Se o arquivo não existir, assume que keyPath já é o conteúdo da chave
    }
  }
  const client = await ssh2Connect(makeConnectConfig(conn));
  try {
    return await ssh2Exec(client, command);
  } finally {
    client.end();
  }
}

async function execLocalViaRunner(projectPath: string | undefined | null, command: string, timeoutMs = 30_000): Promise<SshExecResult> {
  const headers = {
    Authorization: `Bearer ${process.env.RUNNER_TOKEN ?? "local-runner-token"}`,
  };
  const started = Date.now();
  try {
    const response = await axios.post<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }>(
      `${env.RUNNER_URL}/run`,
      {
        provider: "OPENCODE",
        projectPath: projectPath || ".",
        prompt: `Execute este comando no terminal e retorne a saída:\n\n${command}`,
        elevated: true,
        timeoutMs,
      },
      { timeout: timeoutMs + 5_000, headers },
    );
    return {
      success: response.data.ok,
      stdout: response.data.stdout ?? "",
      stderr: response.data.stderr ?? "",
      exitCode: response.data.exitCode,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      success: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
      durationMs: Date.now() - started,
    };
  }
}

export async function execCommand(
  project: {
    sshHost?: string | null;
    sshPort?: number | null;
    sshUser?: string | null;
    sshAuthType?: string | null;
    sshKeyPath?: string | null;
    sshPassword?: string | null;
    projectPath?: string | null;
  },
  command: string,
  timeoutMs = 30_000,
): Promise<SshExecResult> {
  const conn = buildSshConfig(project);
  if (conn.authType === "pm2" || !conn.host) {
    return execLocalViaRunner(project.projectPath, command, timeoutMs);
  }
  return execRemote(conn, command);
}

export async function testConnection(project: {
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  sshAuthType?: string | null;
  sshKeyPath?: string | null;
  sshPassword?: string | null;
  projectPath?: string | null;
}): Promise<SshTestResult> {
  const conn = buildSshConfig(project);

  if (conn.authType === "pm2" || !conn.host) {
    try {
      const result = await execLocalViaRunner(project.projectPath, "echo SSH_PM2_OK");
      if (result.success && result.stdout.includes("SSH_PM2_OK")) {
        return { success: true, hostInfo: "PM2 (local)" };
      }
      return { success: false, error: result.stderr || "runner não respondeu" };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    const client = await ssh2Connect(makeConnectConfig(conn));
    let hostInfo = "";
    try {
      const result = await ssh2Exec(client, "uname -a");
      hostInfo = result.stdout.split("\n")[0] || `${conn.user}@${conn.host}`;
    } catch {
      hostInfo = `${conn.user}@${conn.host}:${conn.port}`;
    }
    return { success: true, hostInfo };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
