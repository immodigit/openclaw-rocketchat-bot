import {
  createReplyProgressState,
  EMPTY_REPLY_FALLBACK,
  formatReplyFailure,
  formatReplyUpdate,
  REACTION_DONE,
  REACTION_FAILED,
  REACTION_STUCK,
  THINKING_PLACEHOLDER,
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
   * Optional. Stamp a status reaction on the user's trigger message
   * (✅ done / ❌ failed / ⚠️ stuck). Best-effort — implementations
   * swallow their own errors so a failed reaction never breaks the reply.
   */
  reactMessage?(messageId: string, emoji: string): Promise<void>;
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
   * The last meaningful prose the agent produced (a `block` or `final`
   * update carrying real text). Used to salvage a closing reply when the
   * run ends without a clean final — otherwise a trailing tool update
   * would freeze the message on a rolling progress/failure stub even
   * though the agent already said something useful one step earlier.
   */
  lastMeaningfulText(): string | undefined;
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

  const react = async (emoji: string): Promise<void> => {
    if (options.triggerMessageId && options.client.reactMessage) {
      // reactMessage is best-effort and swallows its own errors, but guard
      // anyway so a status reaction can never break the reply path.
      try {
        await options.client.reactMessage(options.triggerMessageId, emoji);
      } catch {
        /* ignore — status reactions are non-critical */
      }
    }
  };

  try {
    if (typeof options.run === "function") {
      await options.run(session);
      if (!session.hasFinalUpdate()) {
        // The run ended without a clean final delivery. Don't leave the
        // message frozen on a rolling tool/failure stub: if the agent
        // produced real prose one step earlier (a block), promote it as
        // the closing reply. Only when there's nothing to salvage do we
        // fall back to the empty-final behaviour (delete / "(no reply)").
        const salvaged = session.lastMeaningfulText();
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
    await react(REACTION_FAILED);
    throw error;
  }

  // Task finished cleanly — stamp the trigger message with ✅.
  await react(REACTION_DONE);

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
        // The agent is considered dead/stuck — flag the trigger message.
        if (triggerMessageId && client.reactMessage) {
          try {
            await client.reactMessage(triggerMessageId, REACTION_STUCK);
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
      if (kind === "final") {
        finalUpdated = true;
      }
      // Remember the agent's real prose so a later tool stub can't bury it.
      if (kind === "block" || kind === "final") {
        const prose = payload.text?.trim();
        if (prose) {
          lastMeaningful = prose;
        }
      }
      const text = formatReplyUpdate(kind, payload, progress);
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
      if (kind === "final" && payload.attachmentPath && client.uploadAttachment) {
        await client.uploadAttachment(
          roomId,
          payload.attachmentPath,
          payload.text?.trim() || undefined,
          threadOptions
        );
      }
    },
    hasFinalUpdate: () => finalUpdated,
    lastMeaningfulText: () => lastMeaningful,
    fail: async (_error) => {
      stopWatchdog();
      await client.updateMessage(roomId, messageId, formatReplyFailure());
    }
  };
}
