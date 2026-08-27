import {
  createReplyProgressState,
  EMPTY_REPLY_FALLBACK,
  extractStatusSignal,
  formatReplyFailure,
  formatReplyUpdate,
  isToolTraceStub,
  REACTION_ATTENTION,
  REACTION_DONE,
  REACTION_INPUT,
  REACTION_WORKING,
  type ReplyOutcome,
  THINKING_PLACEHOLDER,
  TOOL_REPLY_FALLBACK,
  WATCHDOG_STAGES
} from "./format.js";
import type { InboundEvent } from "./inbound/types.js";

type ChannelRuleOptions = {
  botUserId: string;
  mentionNames: string[];
};

type ReplyClient = {
  postMessage(roomId: string, text: string, options?: { tmid?: string }): Promise<string>;
  updateMessage(roomId: string, messageId: string, text: string): Promise<void>;
  /**
   * Optional. When provided, an empty final reply will delete the
   * placeholder instead of leaving an "(no reply generated)" trail in
   * the channel. Implementations that can't delete safely (no
   * permission, transport restrictions) should leave this undefined —
   * the lifecycle will fall back to updating the placeholder with the
   * fallback text.
   */
  deleteMessage?(roomId: string, messageId: string): Promise<void>;
  /**
   * Optional. Add or remove a status reaction on the user's trigger
   * message (❓ open / ✅ done / ❌ failed / ⚠️ stuck). `shouldReact: false`
   * removes the reaction. Best-effort — implementations swallow their own
   * errors so a failed reaction never breaks the reply.
   */
  reactMessage?(messageId: string, emoji: string, shouldReact?: boolean): Promise<void>;
  uploadAttachment?(
    roomId: string,
    filePath: string,
    text?: string,
    options?: { tmid?: string }
  ): Promise<string>;
};

type SendReplyLifecycleOptions = {
  client: ReplyClient;
  roomId: string;
  /**
   * Thread message id to anchor the bot's reply to. When set, the
   * placeholder message and any follow-up attachments are posted as
   * thread replies on top of this message id.
   */
  tmid?: string;
  /**
   * The user's trigger message id. When set (and the client supports
   * reactions), the lifecycle stamps it with a status reaction:
   * ✅ on success, ❌ on error, ⚠️ when the watchdog gives up.
   */
  triggerMessageId?: string;
} & (
  | {
      finalText: string;
      run?: never;
    }
  | {
      finalText?: never;
      run(session: ReplySession): Promise<void>;
    }
);

type ReplyStageKind = "tool" | "block" | "final";

type ReplyStagePayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  attachmentPath?: string;
};

type ReplySession = {
  messageId: string;
  update(params: { kind: ReplyStageKind; payload: ReplyStagePayload }): Promise<void>;
  hasFinalUpdate(): boolean;
  /**
   * The last tool trace shown in place of an answer. Only used as a
   * last-resort salvage so a trace-only run does not end in silence.
   */
  lastToolTraceText(): string | undefined;
  /**
   * The last meaningful prose the agent produced (a `block` or `final`
   * update carrying real text). Used to salvage a closing reply when the
   * run ends without a clean final — otherwise a trailing tool update
   * would freeze the message on a rolling progress/failure stub even
   * though the agent already said something useful one step earlier.
   */
  lastMeaningfulText(): string | undefined;
  /**
   * The terminal outcome the agent signalled (via a status marker in a
   * block/final message): "done" → ✅, "input" → ❓, "attention" → ⚠️.
   * `undefined` means the agent gave no signal — answering once is not a
   * terminal state, so we just clear the ⏳ without a verdict.
   */
  outcome(): ReplyOutcome | undefined;
  fail(error: unknown): Promise<void>;
};

export function shouldHandleInboundEvent(
  event: InboundEvent,
  options: ChannelRuleOptions
): boolean {
  if (event.senderId === options.botUserId) {
    return false;
  }

  if (event.roomType === "direct") {
    return true;
  }

  const aliases = options.mentionNames.map(normalizeMention);
  const explicitMentions = event.mentions.map(normalizeMention);
  if (explicitMentions.some((mention) => aliases.includes(mention))) {
    return true;
  }

  const normalizedText = event.text.toLowerCase();
  return aliases.some((alias) => normalizedText.includes(`@${alias}`));
}

export async function sendReplyLifecycle(
  options: SendReplyLifecycleOptions
): Promise<string> {
  const session = await createReplySession(
    options.client,
    options.roomId,
    options.tmid,
    options.triggerMessageId
  );

  const react = async (emoji: string, shouldReact = true): Promise<void> => {
    if (options.triggerMessageId && options.client.reactMessage) {
      // reactMessage is best-effort and swallows its own errors, but guard
      // anyway so a status reaction can never break the reply path.
      try {
        await options.client.reactMessage(options.triggerMessageId, emoji, shouldReact);
      } catch {
        /* ignore — status reactions are non-critical */
      }
    }
  };

  // Stamp ⏳ (working) straight away; it's replaced by a terminal state once
  // the turn ends.
  await react(REACTION_WORKING);

  try {
    if (typeof options.run === "function") {
      await options.run(session);
      if (!session.hasFinalUpdate()) {
        // The run ended without a clean final delivery. Don't leave the
        // message frozen on a rolling tool/failure stub: if the agent
        // produced real prose one step earlier (a block), promote it as
        // the closing reply. Only when there's nothing to salvage do we
        // fall back to the empty-final behaviour (delete / "(no reply)").
        const salvaged = session.lastMeaningfulText() ?? session.lastToolTraceText();
        await session.update({
          kind: "final",
          payload: salvaged ? { text: salvaged } : {}
        });
      }
    } else {
      await session.update({
        kind: "final",
        payload: {
          text: options.finalText
        }
      });
    }
  } catch (error) {
    await session.fail(error);
    await react(REACTION_WORKING, false);
    await react(REACTION_ATTENTION);
    throw error;
  }

  // Clear ⏳ and apply the agent's terminal signal:
  //   done → ✅ · needs your input → ❓ · problem → ⚠️
  // No signal → just clear ⏳ (answering once is not a terminal verdict).
  await react(REACTION_WORKING, false);
  const state = session.outcome();
  const verdict =
    state === "done"
      ? REACTION_DONE
      : state === "input"
        ? REACTION_INPUT
        : state === "attention"
          ? REACTION_ATTENTION
          : undefined;
  if (verdict) {
    await react(verdict);
  }

  return session.messageId;
}

function normalizeMention(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

async function createReplySession(
  client: ReplyClient,
  roomId: string,
  tmid: string | undefined,
  triggerMessageId?: string
): Promise<ReplySession> {
  const threadOptions = tmid ? { tmid } : undefined;
  const messageId = await client.postMessage(roomId, THINKING_PLACEHOLDER, threadOptions);
  let finalUpdated = false;
  // Last real prose the agent emitted (block/final with text). Lets the
  // lifecycle salvage a closing reply if the run ends on a tool stub.
  let lastMeaningful: string | undefined;
  // Last tool trace we showed. Not prose — kept only so a run that produced
  // nothing but a failed tool still leaves something readable behind
  // instead of a deleted placeholder.
  let lastToolTrace: string | undefined;
  // Terminal outcome the agent signalled via a status marker (done / input /
  // attention). Drives which reaction replaces the ⏳ at the end.
  let outcome: ReplyOutcome | undefined;

  // Rolling "what is the agent doing" state. The first tool update swaps
  // the static "denke nach" placeholder for a live list of steps, so the
  // user can follow how the agent is working — like Telegram's progress
  // drafts. Reset is unnecessary: one state object lives per lifecycle.
  const progress = createReplyProgressState();

  // Watchdog: if the agent never emits any update (crash, hang, lost
  // connection), the "⏳ Moment …" placeholder would otherwise sit in
  // the channel forever. Walk through WATCHDOG_STAGES (60s/5m/15m) and
  // update the placeholder text to show liveness — and eventually mark
  // the bot as dead with a final terminal message asking the user to
  // re-trigger.
  //
  // Stops as soon as the agent emits its first real update (any kind),
  // because from that point the user sees real tool/block/final
  // content and the watchdog would only overwrite it.
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let appliedStages = 0;
  const startedAt = Date.now();

  const stopWatchdog = (): void => {
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const runWatchdog = async (): Promise<void> => {
    const elapsedS = (Date.now() - startedAt) / 1000;
    while (appliedStages < WATCHDOG_STAGES.length) {
      const stage = WATCHDOG_STAGES[appliedStages];
      if (elapsedS < stage.afterSeconds) {
        return;
      }
      appliedStages += 1;
      try {
        await client.updateMessage(roomId, messageId, stage.text);
      } catch {
        // Best-effort: a transient update failure shouldn't kill the
        // watchdog. The next tick or the agent's own update will retry.
      }
      if (stage.terminal) {
        // The agent is considered dead/stuck — swap the ⏳ for ⚠️.
        if (triggerMessageId && client.reactMessage) {
          try {
            await client.reactMessage(triggerMessageId, REACTION_WORKING, false);
            await client.reactMessage(triggerMessageId, REACTION_ATTENTION, true);
          } catch {
            /* ignore — status reactions are non-critical */
          }
        }
        stopWatchdog();
        return;
      }
    }
  };

  watchdogTimer = setInterval(() => {
    void runWatchdog();
  }, 15_000);
  // Don't pin the Node event loop — let normal shutdown win.
  if (typeof watchdogTimer === "object" && watchdogTimer !== null && "unref" in watchdogTimer) {
    (watchdogTimer as { unref: () => void }).unref();
  }

  return {
    messageId,
    update: async ({ kind, payload }) => {
      // First real update from the agent — the user now sees real
      // content, so the watchdog has done its job.
      stopWatchdog();

      // Tool notices reach us as prose whenever verbose tool progress is
      // off, because the host then never emits kind:"tool" at all. They
      // are queued and flushed at the end of the turn, so they arrive
      // *after* the answer: on 2026-08-26 marco's finished posting-calendar
      // reply was overwritten 620 ms later by "⚠️ 🛠️ Bash failed: …", and
      // because that notice came in as `final` the salvage below never ran.
      // A trace is not an answer — it may neither be written over prose,
      // nor be remembered as prose, nor close the turn.
      if ((kind === "block" || kind === "final") && isToolTraceStub(payload.text)) {
        lastToolTrace = payload.text?.trim();
        if (lastMeaningful !== undefined) {
          return;
        }
        // Nothing to protect yet: showing the trace beats showing nothing,
        // and it keeps the message alive for the salvage step.
        await client.updateMessage(roomId, messageId, lastToolTrace ?? TOOL_REPLY_FALLBACK);
        return;
      }

      if (kind === "final") {
        finalUpdated = true;
      }
      let effectivePayload = payload;
      // For prose updates: detect + strip the status marker (done / input /
      // attention) and remember the cleaned prose so a later tool stub can't
      // bury it. The latest signalled state wins (the final word counts).
      if ((kind === "block" || kind === "final") && payload.text) {
        const { state, text: cleaned } = extractStatusSignal(payload.text);
        if (state) {
          outcome = state;
        }
        effectivePayload = { ...payload, text: cleaned };
        const prose = cleaned.trim();
        if (prose) {
          lastMeaningful = prose;
        }
      }
      const text = formatReplyUpdate(kind, effectivePayload, progress);
      // When the agent produces nothing meaningful for the final reply
      // (no text and no attachment), prefer silently removing the
      // placeholder over leaving "(no reply generated)" noise in the
      // channel. If the client can't delete (no permission, missing
      // method), keep the existing update-to-fallback behaviour so the
      // observability story stays intact.
      const isEmptyFinal =
        kind === "final" &&
        text === EMPTY_REPLY_FALLBACK &&
        !payload.attachmentPath;
      if (isEmptyFinal && client.deleteMessage) {
        try {
          await client.deleteMessage(roomId, messageId);
          return;
        } catch (error) {
          // Falling back to the visible "(no reply generated)" string is
          // strictly better than throwing — at worst the user sees the
          // same fallback they'd have seen anyway.
          console.warn(
            `[rocketchat] could not delete placeholder ${messageId}; falling back to update: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
      await client.updateMessage(roomId, messageId, text);
      if (kind === "final" && effectivePayload.attachmentPath && client.uploadAttachment) {
        await client.uploadAttachment(
          roomId,
          effectivePayload.attachmentPath,
          effectivePayload.text?.trim() || undefined,
          threadOptions
        );
      }
    },
    hasFinalUpdate: () => finalUpdated,
    lastToolTraceText: () => lastToolTrace,
    lastMeaningfulText: () => lastMeaningful,
    outcome: () => outcome,
    fail: async (_error) => {
      stopWatchdog();
      await client.updateMessage(roomId, messageId, formatReplyFailure());
    }
  };
}
