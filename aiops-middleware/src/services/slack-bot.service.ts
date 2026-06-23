import axios from "axios";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { errorSummary } from "../utils/retry.js";
import type { InboundAttachment } from "./telegram.service.js";

/** Baixa os arquivos anexados a um evento do Slack (url_private, autenticada). */
async function downloadSlackFiles(files: any[]): Promise<InboundAttachment[]> {
  const out: InboundAttachment[] = [];
  for (const f of files ?? []) {
    const url = f?.url_private_download || f?.url_private;
    if (!url) continue;
    try {
      const res = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: 30_000,
        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      });
      const buffer = Buffer.from(res.data);
      const contentType = String(res.headers["content-type"] ?? "");

      // Sem escopo files:read, o Slack devolve uma página HTML (200) em vez do
      // arquivo. Detecta isso para não anexar um arquivo corrompido ao GLPI.
      const looksLikeHtml =
        contentType.includes("text/html") || buffer.subarray(0, 15).toString("utf8").toLowerCase().includes("<!doctype");
      if (buffer.length === 0 || looksLikeHtml) {
        logger.error(
          { fileName: f.name, contentType, size: buffer.length },
          "Download do anexo do Slack retornou conteúdo inválido — o bot precisa do escopo files:read",
        );
        continue;
      }

      out.push({
        mimeType: f.mimetype || contentType || "application/octet-stream",
        data: buffer.toString("base64"),
        name: f.name,
      });
    } catch (error) {
      logger.warn({ err: errorSummary(error) }, "Falha ao baixar anexo do Slack");
    }
  }
  return out;
}

/**
 * Chat bidirecional com o Gerente pelo Slack via Socket Mode.
 *
 * Socket Mode abre uma conexão DE SAÍDA para o Slack (igual ao long-polling
 * do Telegram), então o middleware não precisa de URL pública. Requer:
 *  - SLACK_BOT_TOKEN (xoxb-...) com escopo chat:write;
 *  - SLACK_APP_TOKEN (xapp-...) com connections:write e Socket Mode ativo;
 *  - o app inscrito nos eventos message.im (e/ou app_mention).
 */

let socket: SocketModeClient | null = null;
let web: WebClient | null = null;
const processed = new Set<string>();
/** Canais/DMs que já falaram com o bot — alvo dos broadcasts (ex.: aprovações). */
const knownChannels = new Set<string>();

export async function sendMessage(channel: string, text: string): Promise<void> {
  if (!web) return;
  try {
    await web.chat.postMessage({ channel, text: text.slice(0, 3900) });
  } catch (error) {
    logger.warn({ err: errorSummary(error) }, "Falha ao enviar mensagem no Slack");
  }
}

/** Envia uma mensagem para os canais configurados e os que já interagiram com o bot. */
export async function broadcast(text: string): Promise<void> {
  if (!web) return;
  const targets = new Set(knownChannels);
  const configured = env.SLACK_CHANNEL;
  if (configured) for (const id of configured.split(",").map((c) => c.trim()).filter(Boolean)) targets.add(id);
  await Promise.allSettled([...targets].map((id) => sendMessage(id, text)));
}

export function startSlackBot(
  handler: (text: string, channelId: string, attachments: InboundAttachment[]) => Promise<string>,
): void {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN) {
    logger.warn("Slack bidirecional desativado (SLACK_BOT_TOKEN/SLACK_APP_TOKEN ausentes)");
    return;
  }
  if (socket) return;

  web = new WebClient(env.SLACK_BOT_TOKEN);
  socket = new SocketModeClient({ appToken: env.SLACK_APP_TOKEN });

  const onMessage = async ({ event, ack }: { event: any; ack: () => Promise<void> }) => {
    await ack();
    try {
      // Ignora mensagens do próprio bot, edições e eventos sem texto
      // Ignora mensagens do próprio bot; subtype "file_share" é válido (tem texto/arquivo)
      if (!event || event.bot_id) return;
      if (event.subtype && event.subtype !== "file_share") return;
      const key = `${event.channel}:${event.ts}`;
      if (processed.has(key)) return;
      processed.add(key);
      if (processed.size > 500) processed.clear();

      const text = String(event.text ?? "").replace(/<@[^>]+>/g, "").trim();
      const attachments = await downloadSlackFiles(event.files ?? []);
      if (!text && attachments.length === 0) return;
      if (event.channel) knownChannels.add(String(event.channel)); // recebe broadcasts

      const answer = await handler(text, String(event.channel), attachments);
      await sendMessage(String(event.channel), answer);
    } catch (error) {
      logger.error({ err: errorSummary(error) }, "Erro ao processar mensagem do Slack");
    }
  };

  socket.on("message", onMessage);
  socket.on("app_mention", onMessage);

  socket.start().then(
    () => logger.info("Bot do Slack (Socket Mode) iniciado"),
    (error) => logger.error({ err: errorSummary(error) }, "Falha ao iniciar Socket Mode do Slack"),
  );
}

export function stopSlackBot(): void {
  if (socket) void socket.disconnect();
  socket = null;
  web = null;
}
