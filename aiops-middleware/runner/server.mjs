import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { access, constants, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const runnerDir = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(runnerDir, "..", ".env");
try {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[name] === undefined) process.env[name] = value;
  }
} catch {
  // O runner também aceita configuração diretamente pelo ambiente do Windows.
}

// Garante que Docker Desktop (Windows) esteja acessível no PATH do runner.
if (process.platform === "win32") {
  const dockerBin = "C:\\Program Files\\Docker\\Docker\\resources\\bin";
  if (!process.env.PATH?.includes(dockerBin)) {
    process.env.PATH = dockerBin + ";" + (process.env.PATH ?? "");
  }
}

const port = Number(process.env.RUNNER_PORT ?? 3340);
const token = process.env.RUNNER_TOKEN ?? "local-runner-token";
const workspaceRoot = path.resolve(process.env.PROJECTS_HOST_ROOT ?? path.resolve(runnerDir, "..", ".."));
const defaultTimeout = Number(process.env.RUN_TIMEOUT_MS ?? 0) || 0; // 0 = sem timeout
const allowedEnv = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENCODE_API_KEY",
]);

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 1_000_000) throw new Error("Payload muito grande");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function safeWorkspace(projectPath) {
  if (!projectPath) throw new Error("projectPath é obrigatório");
  const resolved = path.resolve(workspaceRoot, projectPath);
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("projectPath fora da raiz permitida");
  }
  return resolved;
}

function commandFor(provider, prompt, model, elevated) {
  if (provider === "OPENCODE") {
    const args = ["run", ...(model ? ["--model", model] : []), prompt];
    if (process.platform === "win32") {
      return {
        command: process.execPath,
        args: [path.join(process.env.APPDATA ?? "", "npm", "node_modules", "opencode-ai", "bin", "opencode"), ...args],
      };
    }
    return {
      command: "opencode",
      args,
    };
  }
  if (provider === "CLAUDE") {
    // Sem elevação: o Claude pede permissão para editar/rodar comandos e,
    // em modo -p (não-interativo), bloqueia. Com elevação (aprovação humana
    // concedida), liberamos todas as permissões para a execução prosseguir.
    const permissionArgs = elevated
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", "default"];
    return {
      command: process.platform === "win32"
        ? path.join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe")
        : "claude",
      args: ["-p", prompt, "--output-format", "text", ...permissionArgs, ...(model ? ["--model", model] : [])],
    };
  }
  throw new Error("Provider não suportado");
}

// Ferramentas de qualidade (Visual/Pentest/Stress) executam binários reais.
// Allow-list rígida + sanitização de argumentos evita injeção de shell.
const COMMAND_ALLOWLIST = new Set(["npx", "playwright", "k6", "docker", "node"]);

function commandForShell(input) {
  const tool = String(input.tool || "");
  if (!COMMAND_ALLOWLIST.has(tool)) {
    throw new Error(`comando não permitido: ${tool}`);
  }
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  for (const piece of [tool, ...args]) {
    // Bloqueia metacaracteres que permitiriam encadear/escapar comandos
    if (/[;&|`$><\n\r]/.test(piece)) {
      throw new Error("argumento com caractere de shell não permitido");
    }
  }
  // shell:true garante resolução de .cmd/.exe pelo PATH no Windows e Linux
  return { command: tool, args, shell: true };
}

function safeJoin(base, rel) {
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("caminho de arquivo fora do diretório de trabalho");
  }
  return resolved;
}

async function runAgent(input, onUpdate = () => {}) {
  const cwd = safeWorkspace(input.projectPath);
  const isCommand = input.provider === "COMMAND";
  if (isCommand) {
    // Diretório de trabalho da ferramenta é criado sob demanda; os scripts
    // gerados pelo middleware chegam inline (o container não acessa o host).
    await mkdir(cwd, { recursive: true });
    for (const file of Array.isArray(input.files) ? input.files : []) {
      const target = safeJoin(cwd, String(file.path ?? ""));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, String(file.content ?? ""), "utf8");
    }
  } else {
    await access(cwd, constants.R_OK);
  }
  const spec = isCommand
    ? commandForShell(input)
    : commandFor(input.provider, input.prompt, input.model, input.elevated);
  const timeoutMs = defaultTimeout > 0
    ? Math.min(Math.max(Number(input.timeoutMs ?? defaultTimeout), 5_000), 900_000)
    : 0;
  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (allowedEnv.has(key) && typeof value === "string" && value) childEnv[key] = value;
  }
  // OpenCode controla permissões por env:
  // - Leitura (read, glob, grep, list) sempre permitida — .env incluso
  // - Escrita/execução/web (edit, bash, webfetch) só com elevação via aprovação
  if (input.provider === "OPENCODE") {
    const base = { read: "allow", glob: "allow", grep: "allow", list: "allow" };
    childEnv.OPENCODE_PERMISSION = JSON.stringify(input.elevated
      ? { ...base, edit: "allow", bash: "allow", webfetch: "allow" }
      : { ...base, edit: "deny", bash: "deny", webfetch: "deny" });
  }

  let child = null;
  let killed = false;

  const promise = new Promise((resolve) => {
    const started = Date.now();
    child = spawn(spec.command, spec.args, {
      cwd,
      env: childEnv,
      shell: spec.shell ?? false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${chunk}`.slice(-250_000);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk.toString());
      onUpdate({ stdout, stderr, durationMs: Date.now() - started });
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk.toString());
      onUpdate({ stdout, stderr, durationMs: Date.now() - started });
    });

    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
    }, timeoutMs) : null;

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), durationMs: Date.now() - started });
    });
    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      resolve({
        ok: !killed && !timedOut && exitCode === 0,
        timedOut,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - started,
        workspace: cwd,
        killed,
      });
    });
  });

  return {
    promise,
    kill: () => {
      killed = true;
      if (child) {
        child.kill("SIGTERM");
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3_000).unref();
      }
    },
  };
}

const jobs = new Map();

async function startAgentJob(input) {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: "RUNNING",
    ok: false,
    timedOut: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    workspace: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(id, job);

  const { promise, kill } = await runAgent(input, (partial) => Object.assign(job, partial));
  job._kill = kill;

  promise
    .then((result) => {
      Object.assign(job, result, {
        status: result.killed ? "CANCELLED" : result.timedOut ? "TIMED_OUT" : result.ok ? "SUCCEEDED" : "FAILED",
        finishedAt: new Date().toISOString(),
      });
    })
    .catch((error) => {
      Object.assign(job, {
        status: "FAILED",
        stderr: `${job.stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
        finishedAt: new Date().toISOString(),
      });
    });

  return job;
}

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.finishedAt && new Date(job.finishedAt).getTime() < cutoff) jobs.delete(id);
  }
}, 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Leitura do código-fonte (usada pelo Gerente para planejamento) — somente
// leitura, sempre dentro da raiz permitida, com limites de volume.
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
  "storage", "vendor", "__pycache__", ".venv", "venv", ".idea", ".vscode",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt",
  ".yml", ".yaml", ".toml", ".env", ".example", ".prisma", ".sql", ".sh",
  ".ps1", ".py", ".go", ".rs", ".java", ".cs", ".php", ".rb", ".html",
  ".css", ".scss", ".vue", ".svelte", ".xml", ".ini", ".conf", ".dockerfile",
]);

function isTextFile(name) {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile" || lower.startsWith(".env")) return true;
  return TEXT_EXTENSIONS.has(path.extname(lower));
}

async function listTree(input) {
  const root = safeWorkspace(input.projectPath);
  const maxDepth = Math.min(Math.max(Number(input.maxDepth ?? 4), 1), 8);
  const maxEntries = 800;
  const entries = [];

  async function walk(dir, depth) {
    if (entries.length >= maxEntries || depth > maxDepth) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= maxEntries) return;
      const full = path.join(dir, item.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (item.isDirectory()) {
        if (IGNORED_DIRS.has(item.name)) continue;
        entries.push(`${rel}/`);
        await walk(full, depth + 1);
      } else {
        entries.push(rel);
      }
    }
  }

  await walk(root, 1);
  return { root, entries, truncated: entries.length >= maxEntries };
}

// Manifestos que identificam a raiz de um projeto/aplicação.
const ROOT_MANIFESTS = [
  "package.json", "requirements.txt", "pyproject.toml", "setup.py", "Pipfile",
  "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json",
  "Cargo.toml", "Gemfile",
];

async function fileExists(p) {
  try { await access(p, constants.R_OK); return true; } catch { return false; }
}

async function readJsonSafe(file) {
  try {
    const s = await stat(file);
    if (!s.isFile() || s.size > 1_000_000) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch { return null; }
}

/** O diretório é raiz de algum projeto (tem manifesto reconhecido)? */
async function dirHasManifest(dir) {
  for (const file of ROOT_MANIFESTS) {
    if (await fileExists(path.join(dir, file))) return true;
  }
  try {
    const items = await readdir(dir);
    if (items.some((n) => n.endsWith(".csproj") || n.endsWith(".sln"))) return true;
  } catch { /* ignora */ }
  return false;
}

/**
 * Inspeciona um diretório e, se for raiz de um sistema/app, devolve metadados
 * ricos (tipo, runtime, framework, package manager, linguagem, confiança e
 * os sinais que motivaram a detecção). Devolve null se não houver manifesto.
 */
async function detectComponent(dir, relPath) {
  let names = [];
  try { names = await readdir(dir); } catch { return null; }
  const has = (n) => names.includes(n);
  const detectedBy = [];
  const metadata = {};
  let type = null, runtime, framework, packageManager, language, confidence = 0;

  const pkg = has("package.json") ? await readJsonSafe(path.join(dir, "package.json")) : null;
  if (pkg) {
    detectedBy.push("package.json");
    runtime = "node";
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const dep = (n) => Object.prototype.hasOwnProperty.call(deps, n);
    language = (dep("typescript") || has("tsconfig.json")) ? "typescript" : "javascript";
    metadata.scripts = pkg.scripts ? Object.keys(pkg.scripts) : [];
    if (dep("next")) { type = "FRONTEND"; framework = "next"; confidence = 0.9; }
    else if (dep("@angular/core")) { type = "FRONTEND"; framework = "angular"; confidence = 0.88; }
    else if (dep("react") || dep("vue") || dep("svelte") || dep("vite")) {
      type = "FRONTEND"; framework = dep("react") ? "react" : dep("vue") ? "vue" : dep("svelte") ? "svelte" : "vite"; confidence = 0.85;
    } else if (dep("@nestjs/core")) { type = "BACKEND_API"; framework = "nestjs"; confidence = 0.9; }
    else if (dep("express") || dep("fastify") || dep("koa") || dep("@hapi/hapi")) {
      type = "BACKEND_API"; framework = dep("express") ? "express" : dep("fastify") ? "fastify" : dep("koa") ? "koa" : "hapi"; confidence = 0.88;
    } else if (dep("bullmq") || dep("bull") || dep("amqplib") || dep("kafkajs")) {
      type = "WORKER"; framework = dep("bullmq") || dep("bull") ? "bull" : dep("amqplib") ? "amqp" : "kafka"; confidence = 0.8;
    } else { type = "UNKNOWN"; confidence = 0.5; }
    packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") ? "bun" : "npm";
    if (has("prisma")) { detectedBy.push("prisma"); if (type === "BACKEND_API") confidence = Math.min(0.97, confidence + 0.05); }
  } else if (has("go.mod")) {
    detectedBy.push("go.mod"); runtime = "go"; language = "go"; type = "BACKEND_API"; confidence = 0.8;
  } else if (has("pyproject.toml") || has("requirements.txt") || has("setup.py") || has("Pipfile")) {
    detectedBy.push("python"); runtime = "python"; language = "python"; type = "SCRIPT"; confidence = 0.6;
    const reqText = has("requirements.txt") ? await readFile(path.join(dir, "requirements.txt"), "utf8").catch(() => "") : "";
    if (/fastapi|flask|django|uvicorn/i.test(reqText)) { type = "BACKEND_API"; confidence = 0.78; }
    else if (/torch|transformers|langchain|openai|llama/i.test(reqText)) { type = "AI_SERVICE"; confidence = 0.72; }
  } else if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) {
    detectedBy.push("java"); runtime = "jvm"; language = "java"; type = "BACKEND_API"; confidence = 0.7;
  } else if (has("composer.json")) {
    detectedBy.push("composer.json"); runtime = "php"; language = "php"; type = "BACKEND_API"; confidence = 0.7;
  } else if (has("Cargo.toml")) {
    detectedBy.push("Cargo.toml"); runtime = "rust"; language = "rust"; type = "BACKEND_API"; confidence = 0.65;
  } else if (has("Gemfile")) {
    detectedBy.push("Gemfile"); runtime = "ruby"; language = "ruby"; type = "BACKEND_API"; confidence = 0.65;
  } else if (names.some((n) => n.endsWith(".csproj") || n.endsWith(".sln"))) {
    detectedBy.push("dotnet"); runtime = "dotnet"; language = "csharp"; type = "BACKEND_API"; confidence = 0.7;
  } else {
    return null;
  }

  // Sinais de diretório reforçam o tipo
  if (has("src")) {
    try {
      const srcNames = await readdir(path.join(dir, "src"));
      if (srcNames.includes("routes") || srcNames.includes("controllers")) {
        if (type === "UNKNOWN" || type === "BACKEND_API") { type = "BACKEND_API"; detectedBy.push("src/routes"); confidence = Math.min(0.95, confidence + 0.05); }
      }
      if (srcNames.includes("workers")) detectedBy.push("src/workers");
    } catch { /* ignora */ }
  }
  if (has("Dockerfile")) { detectedBy.push("Dockerfile"); metadata.hasDockerfile = true; confidence = Math.min(0.98, confidence + 0.03); }

  const base = relPath.split("/").pop();
  return {
    name: base,
    relativePath: relPath,
    path: relPath, // compat
    slug: base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
    type, runtime, framework, packageManager, language,
    confidence: Number(confidence.toFixed(2)),
    detectedBy, metadata,
  };
}

/**
 * Lista subprojetos/componentes (apps) dentro da pasta de um projeto, com
 * metadados ricos. Para de descer ao encontrar um manifesto. Ignora pastas
 * pesadas/sensíveis (node_modules, .git, dist…). Resolve symlinks e confina
 * tudo dentro de PROJECTS_HOST_ROOT.
 */
async function listSubprojects(input) {
  const root = safeWorkspace(input.projectPath);
  const realRoot = await realpath(root).catch(() => root);
  if (realRoot !== workspaceRoot && !realRoot.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("projectPath fora da raiz permitida");
  }
  const maxDepth = Math.min(Math.max(Number(input.maxDepth ?? 3), 1), 4);
  const rootHasManifest = await dirHasManifest(root);
  const components = [];

  async function walk(dir, relParts, depth) {
    if (components.length >= 200 || depth > maxDepth) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (components.length >= 200) return;
      if (!item.isDirectory() || IGNORED_DIRS.has(item.name) || item.name.startsWith(".")) continue;
      const full = path.join(dir, item.name);
      const rel = [...relParts, item.name];
      const component = await detectComponent(full, rel.join("/"));
      if (component) {
        components.push(component);
      } else {
        await walk(full, rel, depth + 1);
      }
    }
  }

  await walk(root, [], 1);
  components.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const count = (t) => components.filter((c) => c.type === t).length;
  const summary = {
    totalComponents: components.length,
    backendCount: count("BACKEND_API") + count("PAYMENT") + count("AI_SERVICE"),
    frontendCount: count("FRONTEND"),
    workerCount: count("WORKER"),
    infraCount: count("INFRA"),
    unknownCount: count("UNKNOWN"),
  };

  return {
    projectPath: root,
    root,
    rootHasManifest,
    rootType: rootHasManifest ? "root" : null,
    isMonorepo: components.length >= 2,
    components,
    // compat com o seletor de subprojeto do pentest (espera subprojects[].path)
    subprojects: components.map((c) => ({ name: c.relativePath, path: c.relativePath, type: c.type })),
    dependencies: [],
    summary,
  };
}

function safeProjectFile(root, filePath) {
  const resolved = path.resolve(root, String(filePath ?? ""));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("filePath fora do projeto");
  }
  return resolved;
}

// Arquivos sensíveis (segredos/chaves) nunca devem ser lidos/retornados.
const SENSITIVE_FILE = /(^|[\\/])(\.env(\..+)?|.*\.(pem|key|crt|p12|pfx)|id_rsa|id_ed25519|secrets\..*|credentials\..*|firebase-adminsdk.*\.json|service-account.*\.json)$/i;

function isSensitiveFile(name) {
  return SENSITIVE_FILE.test(name);
}

async function readProjectFile(input) {
  const root = safeWorkspace(input.projectPath);
  const filePath = safeProjectFile(root, input.filePath);
  if (isSensitiveFile(filePath)) throw new Error("Leitura de arquivo sensível (segredo/chave) bloqueada");
  const stats = await stat(filePath);
  if (!stats.isFile()) throw new Error("Caminho não é um arquivo");
  if (stats.size > 1_000_000) throw new Error("Arquivo maior que 1MB");
  let content = await readFile(filePath, "utf8");
  const truncated = content.length > 60_000;
  if (truncated) content = `${content.slice(0, 60_000)}\n...[truncado]`;
  return {
    path: path.relative(root, filePath).split(path.sep).join("/"),
    size: stats.size,
    truncated,
    content,
  };
}

async function searchProject(input) {
  const root = safeWorkspace(input.projectPath);
  const query = String(input.query ?? "");
  if (query.length < 3) throw new Error("query precisa de pelo menos 3 caracteres");
  const lowered = query.toLowerCase();
  const matches = [];
  let scanned = 0;

  async function walk(dir, depth) {
    if (matches.length >= 50 || scanned >= 2000 || depth > 8) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (matches.length >= 50 || scanned >= 2000) return;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!IGNORED_DIRS.has(item.name)) await walk(full, depth + 1);
        continue;
      }
      if (!isTextFile(item.name) || isSensitiveFile(item.name)) continue;
      scanned++;
      try {
        const stats = await stat(full);
        if (stats.size > 512_000) continue;
        const lines = (await readFile(full, "utf8")).split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < 50; i++) {
          if (lines[i].toLowerCase().includes(lowered)) {
            matches.push({
              file: path.relative(root, full).split(path.sep).join("/"),
              line: i + 1,
              text: lines[i].trim().slice(0, 300),
            });
          }
        }
      } catch {
        // arquivo binário/ilegível: ignora
      }
    }
  }

  await walk(root, 1);
  return { query, matches, filesScanned: scanned, truncated: matches.length >= 50 };
}

async function pickFolder() {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dialog.SelectedPath = '${workspaceRoot.replace(/'/g, "''")}'`,
    "$dialog.Description = 'Selecione a pasta do projeto do agente'",
    "$dialog.ShowNewFolderButton = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "  Write-Output $dialog.SelectedPath",
    "}",
  ].join("; ");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-STA", "-NoProfile", "-Command", script], {
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `Seletor encerrou com código ${code}`));
      const selected = stdout.trim();
      if (!selected) return resolve(null);
      resolve(safeWorkspace(selected));
    });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/healthz") return json(res, 200, { status: "ok" });
    if (req.headers.authorization !== `Bearer ${token}`) {
      return json(res, 401, { error: "Não autorizado" });
    }
    if (req.method === "POST" && req.url === "/run") {
      const input = await body(req);
      const { promise } = await runAgent(input);
      const result = await promise;
      return json(res, 200, result);
    }
    if (req.method === "POST" && req.url === "/runs") {
      return json(res, 202, await startAgentJob(await body(req)));
    }
    if (req.method === "GET" && req.url?.startsWith("/runs/")) {
      const id = decodeURIComponent(req.url.slice("/runs/".length));
      const job = jobs.get(id);
      return job ? json(res, 200, job) : json(res, 404, { error: "Execução não encontrada" });
    }
    if (req.method === "DELETE" && req.url?.startsWith("/runs/")) {
      const id = decodeURIComponent(req.url.slice("/runs/".length));
      const job = jobs.get(id);
      if (!job) return json(res, 404, { error: "Execução não encontrada" });
      if (job.status !== "RUNNING") return json(res, 400, { error: "Execução não está em andamento" });
      if (typeof job._kill === "function") job._kill();
      return json(res, 200, { cancelled: true, id });
    }
    if (req.method === "POST" && req.url === "/pick-folder") {
      return json(res, 200, { path: await pickFolder() });
    }
    if (req.method === "POST" && req.url === "/fs/tree") {
      return json(res, 200, await listTree(await body(req)));
    }
    if (req.method === "POST" && req.url === "/fs/subprojects") {
      return json(res, 200, await listSubprojects(await body(req)));
    }
    if (req.method === "POST" && req.url === "/fs/read") {
      return json(res, 200, await readProjectFile(await body(req)));
    }
    if (req.method === "POST" && req.url === "/fs/search") {
      return json(res, 200, await searchProject(await body(req)));
    }
    return json(res, 404, { error: "Rota não encontrada" });
  } catch (error) {
    return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Agent runner listening on ${port}; workspace root: ${workspaceRoot}`);
});
