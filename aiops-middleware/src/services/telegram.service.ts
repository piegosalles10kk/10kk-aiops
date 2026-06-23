import axios from "axios";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { errorSummary } from "../utils/retry.js";

export interface InboundAttachment {
  mimeType: string;
  data: string; // base64
  name?: string;
}

let offset = 0;
let timer: NodeJS.Timeout | null = null;
let handler:
  | ((text: string, chatId: string, attachments: InboundAttachment[]) => Promise<string>)
  | null = null;

/** Baixa um arquivo do Telegram pelo file_id e devolve em base64. */
async function downloadFile(
  fileId: string,
  mimeType: string,
  name?: string,
): Promise<InboundAttachment | null> {
  try {
    const { data: meta } = await axios.get<{ result?: { file_path?: string } }>(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile`,
      { params: { file_id: fileId }, timeout: 15_000 },
    );
    const filePath = meta.result?.file_path;
    if (!filePath) return null;
    const fileRes = await axios.get<ArrayBuffer>(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`,
      { responseType: "arraybuffer", timeout: 30_000 },
    );
    return {
      mimeType,
      data: Buffer.from(fileRes.data).toString("base64"),
      name: name ?? filePath.split("/").pop(),
    };
  } catch (error) {
    logger.warn({ err: errorSummary(error) }, "Falha ao baixar anexo do Telegram");
    return null;
  }
}

/** Extrai anexos suportados (foto, voz, áudio, vídeo, documento) de uma mensagem. */
async function extractAttachments(msg: any): Promise<InboundAttachment[]> {
  const out: InboundAttachment[] = [];
  if (Array.isArray(msg?.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    const a = await downloadFile(largest.file_id, "image/jpeg");
    if (a) out.push(a);
  }
  if (msg?.voice) {
    const a = await downloadFile(msg.voice.file_id, msg.voice.mime_type || "audio/ogg");
    if (a) out.push(a);
  }
  if (msg?.audio) {
    const a = await downloadFile(msg.audio.file_id, msg.audio.mime_type || "audio/mpeg", msg.audio.file_name);
    if (a) out.push(a);
  }
  if (msg?.video) {
    const a = await downloadFile(msg.video.file_id, msg.video.mime_type || "video/mp4");
    if (a) out.push(a);
  }
  if (msg?.video_note) {
    const a = await downloadFile(msg.video_note.file_id, "video/mp4");
    if (a) out.push(a);
  }
  if (msg?.document) {
    const a = await downloadFile(msg.document.file_id, msg.document.mime_type || "application/octet-stream", msg.document.file_name);
    if (a) out.push(a);
  }
  return out;
}

/** Chats que já interagiram com o bot nesta sessão — alvo dos broadcasts. */
const knownChats = new Set<string>();

function allowedIds(): string[] {
  return env.TELEGRAM_ALLOWED_CHAT_IDS?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
}

function allowed(chatId: string): boolean {
  const configured = allowedIds();
  return !configured.length || configured.includes(chatId);
}

export async function sendMessage(chatId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await axios.post(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: chatId, text: text.slice(0, 4000) },
    { timeout: 15_000 },
  );
}

export async function broadcast(text: string): Promise<void> {
  // Envia para os chats configurados e também para quem já falou com o bot,
  // garantindo que pedidos de autorização cheguem mesmo sem ALLOWED_CHAT_IDS.
  const ids = new Set([...allowedIds(), ...knownChats]);
  await Promise.allSettled([...ids].map((id) => sendMessage(id, text)));
}

let polling = false;

async function poll(): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !handler) return;
  // getUpdates usa long-polling de 10s; sem esta guarda, o setInterval de 2s
  // sobrepõe requisições e o Telegram responde 409 Conflict.
  if (polling) return;
  polling = true;
  try {
    const { data } = await axios.get<{
      result?: Array<{ update_id: number; message?: any }>;
    }>(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`, {
      params: { offset, timeout: 10 },
      timeout: 35_000,
    });
    for (const update of data.result ?? []) {
      offset = update.update_id + 1;
      const msg = update.message;
      const chatId = String(msg?.chat?.id ?? "");
      if (!chatId || !allowed(chatId)) continue;
      const text = msg?.text ?? msg?.caption ?? "";
      const attachments = await extractAttachments(msg);
      if (!text && attachments.length === 0) continue;
      knownChats.add(chatId); // passa a receber broadcasts (ex.: pedidos de aprovação)
      const response = await handler(text, chatId, attachments);
      await sendMessage(chatId, response);
    }
  } catch (error) {
    logger.warn({ err: errorSummary(error) }, "Falha no polling do Telegram");
  } finally {
    polling = false;
  }
}

export function startTelegramBot(
  messageHandler: (text: string, chatId: string, attachments: InboundAttachment[]) => Promise<string>,
): void {
  handler = messageHandler;
  if (!env.TELEGRAM_BOT_TOKEN || timer) return;
  timer = setInterval(() => void poll(), 2_000);
  timer.unref();
  void poll();
  logger.info("Bot do Telegram iniciado");
}

export function stopTelegramBot(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
