import axios from "axios";
import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { errorSummary } from "../utils/retry.js";

/**
 * Proxy de embed: serve um site externo (Grafana, GLPI, etc.) pela NOSSA
 * origem, removendo os cabeçalhos que impedem exibição em iframe
 * (X-Frame-Options, CSP frame-ancestors). Assim a webview funciona dentro
 * da plataforma em vez de abrir só em nova aba.
 *
 * Reescreve URLs raiz-absolutas no HTML/CSS para passarem pelo proxy e
 * encaminha cookies (mantém a sessão do site alvo).
 *
 * Observação: sites SPA pesados (que montam URLs em JS) podem não funcionar
 * 100%; sites renderizados no servidor (GLPI) funcionam bem.
 */

export const embedRouter = Router();

/** Cabeçalhos de resposta que bloqueiam iframe — removidos. */
const BLOCKING_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
]);

/** Cabeçalhos hop-by-hop que não devem ser repassados. */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-encoding", "content-length",
]);

async function readRawBody(req: Request): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(undefined));
  });
}

/** Reescreve URLs raiz-absolutas e dos hosts alvo para passarem pelo proxy. */
function rewriteHtml(html: string, prefix: string, origins: string[]): string {
  let out = html;
  // 1) href/src/action que começam com "/" (raiz-absoluto) -> sob o prefixo
  out = out.replace(/(\b(?:href|src|action|data-src)\s*=\s*["'])\/(?!\/)/gi, `$1${prefix}/`);
  // 2) URLs absolutas para qualquer host alvo (localhost ou host.docker.internal) -> prefixo
  for (const origin of origins) out = out.split(origin).join(prefix);
  // 3) url(/...) em CSS inline
  out = out.replace(/url\(\s*(['"]?)\/(?!\/)/gi, `url($1${prefix}/`);
  // 4) Por último, injeta a <base> (não pode ser reescrita pelas regras acima)
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${prefix}/">`);
  }
  return out;
}

async function handle(req: Request, res: Response): Promise<void> {
  const id = req.params.id;
  const view = await prisma.customView.findUnique({ where: { id } });
  if (!view) {
    res.status(404).send("Tela não encontrada");
    return;
  }

  const base = new URL(view.url);
  const prefix = `/embed/${id}`;
  // Caminho após o prefixo (com querystring). Na raiz, usa o path original da URL.
  let rest = req.originalUrl.slice(prefix.length);
  if (rest === "" || rest === "/") rest = `${base.pathname}${base.search}`;
  if (!rest.startsWith("/")) rest = `/${rest}`;

  // O proxy roda no servidor (dentro do container). Se a URL for localhost,
  // ela aponta para o próprio container — traduz para host.docker.internal
  // para alcançar o serviço que roda no host (ex.: GLPI na 8080).
  const upstreamOrigin =
    base.hostname === "localhost" || base.hostname === "127.0.0.1"
      ? `${base.protocol}//host.docker.internal:${base.port || (base.protocol === "https:" ? "443" : "80")}`
      : base.origin;
  const targetUrl = upstreamOrigin + rest;

  try {
    const body = await readRawBody(req);
    const upstream = await axios.request({
      url: targetUrl,
      method: req.method as never,
      data: body,
      responseType: "arraybuffer",
      maxRedirects: 0,
      timeout: 30_000,
      decompress: true,
      validateStatus: () => true,
      headers: {
        cookie: req.headers.cookie ?? "",
        "user-agent": req.headers["user-agent"] ?? "",
        accept: req.headers.accept ?? "*/*",
        "accept-language": req.headers["accept-language"] ?? "",
        ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
      },
    });

    // Repassa cabeçalhos, removendo os de bloqueio e hop-by-hop
    for (const [key, value] of Object.entries(upstream.headers)) {
      const lower = key.toLowerCase();
      if (BLOCKING_HEADERS.has(lower) || HOP_BY_HOP.has(lower)) continue;
      if (lower === "set-cookie") {
        const cookies = (Array.isArray(value) ? value : [value]).map((c) =>
          String(c)
            .replace(/;\s*Domain=[^;]+/gi, "")
            .replace(/;\s*Secure/gi, "")
            .replace(/;\s*SameSite=None/gi, "; SameSite=Lax"),
        );
        res.setHeader("set-cookie", cookies);
        continue;
      }
      if (lower === "location") {
        // Mantém redirects dentro do proxy (cobre os dois origins possíveis)
        const loc = String(value);
        const abs = loc.startsWith("http") ? loc : upstreamOrigin + (loc.startsWith("/") ? loc : `/${loc}`);
        const matched = [base.origin, upstreamOrigin].find((o) => abs.startsWith(o));
        res.setHeader("location", matched ? prefix + abs.slice(matched.length) : abs);
        continue;
      }
      res.setHeader(key, value as string);
    }

    const contentType = String(upstream.headers["content-type"] ?? "");
    res.status(upstream.status);

    const origins = [base.origin, upstreamOrigin];
    if (contentType.includes("text/html")) {
      const html = Buffer.from(upstream.data).toString("utf8");
      res.send(rewriteHtml(html, prefix, origins));
    } else if (contentType.includes("text/css")) {
      let css = Buffer.from(upstream.data).toString("utf8");
      for (const o of origins) css = css.split(o).join(prefix);
      css = css.replace(/url\(\s*(['"]?)\/(?!\/)/gi, `url($1${prefix}/`);
      res.send(css);
    } else {
      res.send(Buffer.from(upstream.data));
    }
  } catch (error) {
    logger.warn({ err: errorSummary(error), targetUrl }, "Falha no proxy de embed");
    res.status(502).send("Não foi possível carregar o conteúdo embutido.");
  }
}

embedRouter.all("/:id", handle);
embedRouter.all("/:id/*", handle);
