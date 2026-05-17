export const THINKING_PLACEHOLDER = "⏳ Moment … (denke nach)";
export const EMPTY_REPLY_FALLBACK = "(no reply generated)";
export const TOOL_REPLY_FALLBACK = "🔧 Tool wird benutzt …";
export const BLOCK_REPLY_FALLBACK = "✍️ Antwort wird gebaut …";
export const FAILED_REPLY_FALLBACK = "❌ Etwas ist beim Antworten schiefgelaufen. Bitte nochmal mentionen.";

/**
 * Watchdog stages — when the agent doesn't push an update for a
 * while, the placeholder text itself becomes the status indicator.
 * Each stage replaces the previous one so the user sees movement
 * ("Bot lebt noch, dauert nur") rather than a frozen "Thinking…".
 */
export type WatchdogStage = {
  /** Seconds since the placeholder was created (no agent updates since). */
  afterSeconds: number;
  /** Text the placeholder is updated to once this threshold is crossed. */
  text: string;
  /**
   * If true, the watchdog stops after applying this stage — the agent
   * is considered dead and the placeholder is left in this state until
   * the user re-triggers (or a late final update arrives and replaces
   * the text anyway).
   */
  terminal?: boolean;
};

export const WATCHDOG_STAGES: WatchdogStage[] = [
  { afterSeconds: 60, text: "⏳ Bin dran … (1m+)" },
  { afterSeconds: 300, text: "🤔 Dauert länger als üblich (5m+)" },
  { afterSeconds: 900, text: "❌ Keine Antwort. Bitte @-noch-mal-mentionen.", terminal: true }
];

type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

export function formatFinalReply(reply: string): string {
  return reply.trim().length > 0 ? reply : EMPTY_REPLY_FALLBACK;
}

export function formatReplyUpdate(
  kind: "tool" | "block" | "final",
  payload: ReplyPayload
): string {
  const content = formatReplyPayload(payload);

  if (kind === "final") {
    return formatFinalReply(content);
  }

  if (content.length > 0) {
    return content;
  }

  return kind === "tool" ? TOOL_REPLY_FALLBACK : BLOCK_REPLY_FALLBACK;
}

export function formatReplyFailure(): string {
  return FAILED_REPLY_FALLBACK;
}

function formatReplyPayload(payload: ReplyPayload): string {
  const parts: string[] = [];
  const text = payload.text?.trim();
  if (text) {
    parts.push(text);
  }

  const mediaUrls = [
    ...(payload.mediaUrls ?? []),
    ...(payload.mediaUrl ? [payload.mediaUrl] : [])
  ].map((value) => value.trim()).filter((value) => value.length > 0);

  if (mediaUrls.length > 0) {
    parts.push(mediaUrls.join("\n"));
  }

  return parts.join("\n\n").trim();
}
