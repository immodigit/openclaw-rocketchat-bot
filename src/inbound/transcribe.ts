import { readFile } from "node:fs/promises";

import type { InboundAttachment } from "./attachments.js";

export type AttachmentDownloader = {
  downloadAttachmentToTempFile(
    url: string,
    options?: { fileName?: string }
  ): Promise<string>;
};

export type TranscribeConfig = {
  /**
   * Endpoint URL for the OpenAI-compatible audio transcription API.
   * Defaults to OpenAI's hosted endpoint. Swap to a self-hosted
   * whisper.cpp server or another compatible backend if needed.
   */
  endpoint: string;
  /** Bearer token. */
  apiKey: string;
  /** Model id (default "whisper-1"). */
  model: string;
  /** ISO-639-1 language hint passed to Whisper to improve accuracy. */
  language?: string;
  /** Per-attachment fetch+transcribe timeout in ms. */
  timeoutMs: number;
};

export type TranscribeLog = (entry: Record<string, unknown>) => void;

export type TranscribeResult = {
  attachment: InboundAttachment;
  text: string | null;
  durationMs: number;
  /** Filled when transcription was skipped or failed. */
  error?: string;
};

/**
 * Build the transcription config from process.env. Returns null when the
 * minimal requirements (OPENAI_API_KEY) are not met, so callers can
 * cleanly skip transcription without crashing.
 */
export function transcribeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): TranscribeConfig | null {
  const apiKey =
    env.OPENCLAW_TRANSCRIBE_API_KEY?.trim() ||
    env.OPENAI_API_KEY?.trim() ||
    "";
  if (!apiKey) {
    return null;
  }
  const endpoint =
    env.OPENCLAW_TRANSCRIBE_ENDPOINT?.trim() ||
    "https://api.openai.com/v1/audio/transcriptions";
  const model =
    env.OPENCLAW_TRANSCRIBE_MODEL?.trim() || "whisper-1";
  const language = env.OPENCLAW_TRANSCRIBE_LANGUAGE?.trim() || undefined;
  const timeoutMs = Number.parseInt(
    env.OPENCLAW_TRANSCRIBE_TIMEOUT_MS ?? "20000",
    10
  );
  return {
    endpoint,
    apiKey,
    model,
    language,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000
  };
}

/**
 * Transcribe every audio attachment in the list. Non-audio attachments
 * are skipped silently. Failure on one attachment does not abort the
 * rest — each result carries its own error string if applicable.
 */
export async function transcribeAudioAttachments(
  attachments: InboundAttachment[],
  downloader: AttachmentDownloader | undefined,
  config: TranscribeConfig,
  log?: TranscribeLog
): Promise<TranscribeResult[]> {
  const audioAttachments = attachments.filter((a) => a.kind === "audio");
  if (audioAttachments.length === 0) {
    return [];
  }
  if (!downloader) {
    return audioAttachments.map((attachment) => ({
      attachment,
      text: null,
      durationMs: 0,
      error: "downloader-unavailable"
    }));
  }

  const results: TranscribeResult[] = [];
  for (const attachment of audioAttachments) {
    const started = Date.now();
    if (!attachment.url) {
      results.push({
        attachment,
        text: null,
        durationMs: 0,
        error: "no-url"
      });
      continue;
    }
    try {
      const filePath = await downloader.downloadAttachmentToTempFile(
        attachment.url,
        { fileName: attachment.fileName }
      );
      const text = await transcribeFile(filePath, attachment, config);
      const durationMs = Date.now() - started;
      results.push({ attachment, text, durationMs });
      log?.({
        type: "audio-transcribed",
        url: attachment.url,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        durationMs,
        chars: text.length
      });
    } catch (error) {
      const durationMs = Date.now() - started;
      const msg = error instanceof Error ? error.message : String(error);
      results.push({
        attachment,
        text: null,
        durationMs,
        error: msg
      });
      log?.({
        type: "audio-transcribe-failed",
        url: attachment.url,
        mimeType: attachment.mimeType,
        durationMs,
        error: msg
      });
    }
  }
  return results;
}

async function transcribeFile(
  filePath: string,
  attachment: InboundAttachment,
  config: TranscribeConfig
): Promise<string> {
  const buffer = await readFile(filePath);
  const form = new FormData();
  const fileName = attachment.fileName ?? deriveFileName(attachment.url);
  const mimeType = attachment.mimeType ?? "audio/mpeg";
  form.append(
    "file",
    new Blob([buffer], { type: mimeType }),
    fileName
  );
  form.append("model", config.model);
  if (config.language) {
    form.append("language", config.language);
  }
  form.append("response_format", "json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`transcribe HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as { text?: unknown };
  if (typeof json.text !== "string") {
    throw new Error("transcribe response missing text field");
  }
  return json.text.trim();
}

function deriveFileName(url: string | undefined): string {
  if (!url) {
    return "audio";
  }
  try {
    const path = new URL(url).pathname;
    const segment = path.split("/").filter(Boolean).at(-1);
    return segment ? decodeURIComponent(segment) : "audio";
  } catch {
    return "audio";
  }
}

/**
 * Merge transcribed text back into a Rocket.Chat message body. Existing
 * text is preserved; each transcription appears as a clearly delimited
 * block so the agent (and downstream mention filter) can read it.
 *
 * When `mentionAliases` is supplied, occurrences of those aliases inside
 * the transcript are prefixed with `@` so the downstream mention filter
 * (which looks for literal `@alias` substrings) routes the message to
 * the right bot. Whisper never produces the @ symbol when a human says
 * a name aloud, so without this step a voice note like "Hey andi …"
 * would be silently dropped even though it clearly addresses the bot.
 */
export function mergeTranscriptionsIntoText(
  originalText: string,
  transcriptions: TranscribeResult[],
  options?: { mentionAliases?: string[] }
): string {
  const usable = transcriptions
    .map((t) => t.text?.trim())
    .filter((t): t is string => Boolean(t && t.length > 0));
  if (usable.length === 0) {
    return originalText;
  }
  const aliases = (options?.mentionAliases ?? [])
    .map((a) => a.trim().replace(/^@+/, "").toLowerCase())
    .filter((a) => a.length > 0);
  const blocks = usable.map(
    (t, i) =>
      usable.length === 1
        ? `[Sprachnachricht-Transkription]: ${prefixAliases(t, aliases)}`
        : `[Sprachnachricht-Transkription ${i + 1}]: ${prefixAliases(t, aliases)}`
  );
  if (originalText.trim().length === 0) {
    return blocks.join("\n");
  }
  return `${originalText}\n${blocks.join("\n")}`;
}

function prefixAliases(transcript: string, aliases: string[]): string {
  if (aliases.length === 0) {
    return transcript;
  }
  // Match each alias as a standalone word — case-insensitive, only when
  // not already preceded by `@` — and inject the `@` so the downstream
  // mention filter sees a regular @mention. Aliases are escaped for
  // regex safety even though they're normally plain ASCII.
  let out = transcript;
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // (?<!@) avoids double-prefixing if the user / TTS happened to emit
    // a literal "@alias"; \b enforces word boundaries so we don't match
    // "andiana" when alias is "andi".
    const pattern = new RegExp(`(?<!@)\\b(${escaped})\\b`, "gi");
    out = out.replace(pattern, "@$1");
  }
  return out;
}
