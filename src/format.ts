export const THINKING_PLACEHOLDER = "⏳ Moment … (denke nach)";

/**
 * Status reactions stamped on the user's trigger message so its state is
 * visible at a glance, independent of the reply body:
 * ⏳ working (set while we're handling the message),
 * ✅ done (the whole matter is finished),
 * ❓ needs your input / opinion / decision to proceed,
 * ⚠️ something to look into (error, stuck, or an agent-flagged problem).
 * Rocket.Chat shortcodes.
 *
 * The flow: ⏳ goes on as soon as we start handling a message; at the end it
 * is replaced by exactly one terminal state. The terminal state comes from
 * the agent (markers below) — answering once is NOT automatically ✅.
 */
export const REACTION_WORKING = ":hourglass_flowing_sand:";
export const REACTION_DONE = ":white_check_mark:";
export const REACTION_INPUT = ":question:";
export const REACTION_ATTENTION = ":warning:";

export type ReplyOutcome = "done" | "input" | "attention";

/**
 * Machine markers an agent appends to its closing message to declare the
 * outcome. They are stripped from the rendered text. Checked in priority
 * order (attention beats input beats done) so the most important signal
 * wins if more than one slips in:
 *   [[ERLEDIGT]] / [[DONE]] / [[FERTIG]]            → ✅ done
 *   [[FRAGE]]    / [[INPUT]] / [[ENTSCHEIDUNG]]     → ❓ needs your input
 *   [[ACHTUNG]]  / [[PROBLEM]] / [[FEHLER]]         → ⚠️ look into this
 */
const SIGNAL_PATTERNS: { state: ReplyOutcome; re: RegExp }[] = [
  { state: "attention", re: /\[\[\s*(?:achtung|problem|fehler)\s*\]\]/gi },
  { state: "input", re: /\[\[\s*(?:frage|input|entscheidung)\s*\]\]/gi },
  { state: "done", re: /\[\[\s*(?:erledigt|done|fertig)\s*\]\]/gi }
];

export function extractStatusSignal(text: string | undefined): {
  state: ReplyOutcome | undefined;
  text: string;
} {
  let cleaned = text ?? "";
  let state: ReplyOutcome | undefined;
  for (const { state: candidate, re } of SIGNAL_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(cleaned)) {
      if (!state) {
        state = candidate; // priority order: first match wins
      }
      re.lastIndex = 0;
      cleaned = cleaned.replace(re, "");
    }
  }
  cleaned = cleaned
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { state, text: cleaned };
}
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
 * A tool-progress line that reports a failed step. OpenClaw prefixes such
 * lines with ⚠️ and closes them with "failed"; either signal is enough.
 */
const TOOL_STEP_FAILURE = /^\s*⚠️|\bfailed\s*$/;

/**
 * OpenClaw marks tool-owned payloads with a wrench prefix (core itself
 * checks `startsWith("🛠️") || startsWith("🔧")`); failure notices carry a
 * leading ⚠️ on top. Our own progress header uses the same wrench.
 *
 * This matters because the host only emits `kind:"tool"` deliveries when
 * verbose tool progress is switched on. With it off — the state of the
 * production instance — the very same notices arrive as `block`/`final`
 * prose, where they would otherwise be treated as the agent's answer.
 *
 * Deliberately anchored on the wrench, never on ⚠️ alone: an agent is
 * allowed to open a real answer with "⚠️ Achtung: …", and that has to
 * reach the user untouched.
 */
const TOOL_TRACE_PREFIX = /^\s*(?:\u{26A0}\u{FE0F}?\s*)?(?:\u{1F6E0}|\u{1F527})/u;

/**
 * True when a payload is a trace of *how* the agent worked rather than
 * what it concluded. Such a trace must never become the visible result.
 */
export function isToolTraceStub(text: string | undefined): boolean {
  return typeof text === "string" && TOOL_TRACE_PREFIX.test(text);
}

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
    // A step the agent already recovered from must never become the
    // visible result. Kurt read a customer spreadsheet, one `cat` from the
    // wrong directory failed, he corrected himself and read the file
    // completely — but the chat kept showing
    // "⚠️ 🛠️ show xl/workbook.xml → … failed" and the customer concluded
    // the system had crashed. Real problems reach the user as a final
    // message with an [[ACHTUNG]] marker, not as a tool trace.
    const isRecoverableStepFailure = TOOL_STEP_FAILURE.test(content);

    // No progress state (legacy callers): fall back to the single-line
    // behaviour. With state, fold the step into the rolling view so the
    // user can follow how the agent is working through the task.
    if (!progress) {
      return content.length > 0 && !isRecoverableStepFailure ? content : TOOL_REPLY_FALLBACK;
    }
    if (content.length > 0 && !isRecoverableStepFailure) {
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
