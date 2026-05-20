export const THINKING_PLACEHOLDER = "⏳ Moment … (denke nach)";
export const EMPTY_REPLY_FALLBACK = "(no reply generated)";
export const TOOL_REPLY_FALLBACK = "🔧 Tool wird benutzt …";
export const BLOCK_REPLY_FALLBACK = "✍️ Antwort wird gebaut …";
export const FAILED_REPLY_FALLBACK = "❌ Etwas ist beim Antworten schiefgelaufen. Bitte nochmal mentionen.";

/**
 * Header above the live "what is the agent doing" list. The moment the
 * first tool runs, this view replaces the static "denke nach" placeholder
 * so the user can follow the agent's steps instead of staring at a frozen
 * "Thinking…" — mirrors the Telegram progress-draft behaviour in OpenClaw.
 */
export const TOOL_PROGRESS_HEADER = "🛠️ Ich arbeite daran …";

/**
 * Keep the progress view compact — only the most recent steps stay
 * visible, older lines roll off the top.
 */
const MAX_PROGRESS_LINES = 6;

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

/**
 * Rolling tool-progress state, threaded through `formatReplyUpdate` so a
 * multi-tool turn shows a short history of steps instead of just the
 * latest line. Created once per reply lifecycle and mutated in place.
 */
export type ReplyProgressState = {
  /** Tool-progress lines, newest last. */
  lines: string[];
};

export function createReplyProgressState(): ReplyProgressState {
  return { lines: [] };
}

export function formatFinalReply(reply: string): string {
  return reply.trim().length > 0 ? reply : EMPTY_REPLY_FALLBACK;
}

/**
 * Render the rolling tool-progress lines into one Rocket.Chat message
 * body: a header line plus one line per recorded step.
 */
export function renderToolProgress(lines: string[]): string {
  if (lines.length === 0) {
    return TOOL_PROGRESS_HEADER;
  }
  return [TOOL_PROGRESS_HEADER, ...lines].join("\n");
}

export function formatReplyUpdate(
  kind: "tool" | "block" | "final",
  payload: ReplyPayload,
  progress?: ReplyProgressState
): string {
  const content = formatReplyPayload(payload);

  if (kind === "final") {
    return formatFinalReply(content);
  }

  if (kind === "tool") {
    // No progress state (legacy callers): fall back to the single-line
    // behaviour. With state, fold the step into the rolling view so the
    // user can follow how the agent is working through the task.
    if (!progress) {
      return content.length > 0 ? content : TOOL_REPLY_FALLBACK;
    }
    if (content.length > 0) {
      // Skip consecutive duplicates so a chatty tool loop stays readable.
      if (progress.lines[progress.lines.length - 1] !== content) {
        progress.lines.push(content);
        if (progress.lines.length > MAX_PROGRESS_LINES) {
          progress.lines.splice(0, progress.lines.length - MAX_PROGRESS_LINES);
        }
      }
    }
    // A tool delivery without text carries no concrete step — just keep
    // the header (or the lines gathered so far) visible.
    return renderToolProgress(progress.lines);
  }

  if (content.length > 0) {
    return content;
  }

  return BLOCK_REPLY_FALLBACK;
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
