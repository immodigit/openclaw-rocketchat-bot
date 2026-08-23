import type { InboundAttachment } from "./inbound/attachments.js";
import type { InboundEvent } from "./inbound/types.js";

export type OpenClawConfigLike = {
  session?: {
    store?: string;
  };
  channels?: {
    rocketchat?: unknown;
  };
};

type RoutePeer = {
  kind: InboundEvent["roomType"];
  id: string;
};

type ResolvedAgentRoute = {
  agentId: string;
  sessionKey: string;
  accountId?: string;
  mainSessionKey?: string;
};

type FinalizedContext = Record<string, unknown> & {
  SessionKey?: string;
};

type OutboundReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
};

type ReplyDeliverInfo = {
  kind: "tool" | "block" | "final";
};

type ReplyDispatchCounts = {
  tool: number;
  block: number;
  final: number;
};

type ReplyDispatchResult = {
  queuedFinal: boolean;
  counts: ReplyDispatchCounts;
};

type AttachmentDownloadClientLike = {
  downloadAttachmentToTempFile(
    url: string,
    options?: { fileName?: string }
  ): Promise<string>;
};

/**
 * Minimal contract for fetching thread context when an inbound event
 * lives inside a thread. We don't want a hard dependency on the full
 * RocketChatClient surface — tests can stub this with a couple methods.
 */
export type ThreadContextClientLike = {
  getMessage(messageId: string): Promise<{
    id: string;
    text: string;
    username: string;
    ts: string;
    tmid: string | null;
  } | null>;
  getThreadMessages(
    tmid: string,
    count: number
  ): Promise<Array<{ id: string; text: string; username: string; ts: string }>>;
};

/**
 * Cap for thread-context replies we fetch alongside the parent. We
 * include the bot's own previous replies so it can pick up where it
 * left off without re-asking. Set conservatively — the agent already
 * has session memory keyed by the room.
 */
const THREAD_CONTEXT_REPLY_COUNT = 10;

/**
 * Cap for parent + replies text length (chars). Threads can grow long;
 * the agent's prompt has a budget and threads should help, not flood.
 */
const THREAD_CONTEXT_MAX_CHARS = 4000;

export type ChannelRuntimeLike = {
  routing: {
    resolveAgentRoute(params: {
      cfg: OpenClawConfigLike;
      channel: string;
      accountId: string;
      peer: RoutePeer;
    }): ResolvedAgentRoute;
  };
  session: {
    resolveStorePath(store: string | undefined, opts: { agentId: string }): string;
    readSessionUpdatedAt(params: { storePath: string; sessionKey: string }): number | undefined;
    recordInboundSession(params: {
      storePath: string;
      sessionKey: string;
      ctx: FinalizedContext;
      updateLastRoute?: {
        sessionKey: string;
        channel: string;
        to: string;
        accountId?: string;
      };
      onRecordError(err: unknown): void;
    }): Promise<void>;
  };
  reply: {
    resolveEnvelopeFormatOptions(cfg: OpenClawConfigLike): unknown;
    formatAgentEnvelope(params: {
      channel: string;
      from: string;
      timestamp?: number;
      previousTimestamp?: number;
      envelope: unknown;
      body: string;
    }): string;
    finalizeInboundContext<T extends Record<string, unknown>>(ctx: T): T & FinalizedContext;
    dispatchReplyWithBufferedBlockDispatcher(params: {
      ctx: FinalizedContext;
      cfg: OpenClawConfigLike;
      dispatcherOptions: {
        deliver(payload: unknown, info: { kind: "tool" | "block" | "final" }): Promise<void>;
        onError?(err: unknown, info: { kind: "tool" | "block" | "final" }): void;
      };
      replyOptions?: {
        sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
      };
    }): Promise<unknown>;
  };
};

export async function dispatchInboundEventWithChannelRuntime(params: {
  cfg: OpenClawConfigLike;
  accountId: string;
  event: InboundEvent;
  channelRuntime: ChannelRuntimeLike;
  attachmentClient?: AttachmentDownloadClientLike;
  /**
   * Optional thread-context client. When set AND the inbound event
   * lives inside a thread (`event.tmid` is truthy), the parent message
   * and the last few thread replies are fetched and prepended to the
   * body so the agent doesn't have to ask "what are we talking about?"
   * after a user mentions it in a reply that omits context.
   * Best-effort — failures are silent and we fall back to the bare
   * trigger text.
   */
  threadContextClient?: ThreadContextClientLike;
  /**
   * Optional agent id override. When set, the resolved route's
   * `agentId` + `sessionKey` + `mainSessionKey` are rewritten so the
   * agent's own session store and key are used — letting different
   * bot identities map onto different agent loops.
   */
  agent?: string;
  /**
   * Keep non-DM conversations isolated by Rocket.Chat thread. This prevents
   * unrelated threads in the same room from sharing stale agent history and
   * from competing for the same OpenClaw reply session.
   */
  threadScopedSessions?: boolean;
  deliver(payload: OutboundReplyPayload, info: ReplyDeliverInfo): Promise<void>;
  onRecordError(err: unknown): void;
  onDispatchError(err: unknown, info: ReplyDeliverInfo): void;
}): Promise<void> {
  const logContext = {
    accountId: params.accountId,
    roomId: params.event.roomId,
    messageId: params.event.messageId
  };
  const roomRoute = applyAgentOverride(
    params.channelRuntime.routing.resolveAgentRoute({
      cfg: params.cfg,
      channel: "rocketchat",
      accountId: params.accountId,
      peer: {
        kind: params.event.roomType,
        id: params.event.roomId
      }
    }),
    params.agent
  );
  const route = applyThreadScope(
    roomRoute,
    params.event,
    params.threadScopedSessions !== false
  );
  const storePath = params.channelRuntime.session.resolveStorePath(params.cfg.session?.store, {
    agentId: route.agentId
  });
  const previousTimestamp = params.channelRuntime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey
  });
  const envelopeOptions = params.channelRuntime.reply.resolveEnvelopeFormatOptions(params.cfg);
  const timestamp = toEpochMs(params.event.sentAt);
  const to = buildRecipientAddress(params.event);

  // If the trigger arrived inside a thread, fetch the parent message
  // and the recent thread replies so the agent sees the actual context
  // — users routinely mention bots in replies that omit context that
  // sits one message up. Falls back silently when client is missing,
  // when the API errors, or when the trigger is top-level.
  const threadContext = await buildThreadContextSection(
    params.event,
    params.threadContextClient,
    logContext
  );
  const enrichedTriggerText = threadContext
    ? `${threadContext}\n\n${params.event.text}`
    : params.event.text;

  const body = params.channelRuntime.reply.formatAgentEnvelope({
    channel: "Rocket.Chat",
    from: buildConversationLabel(params.event),
    timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: enrichedTriggerText
  });
  const mediaContext = await buildMediaContext(
    params.event.attachments,
    params.attachmentClient,
    logContext
  );
  const ctxPayload = params.channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: enrichedTriggerText,
    RawBody: params.event.text,
    CommandBody: params.event.text,
    From: buildSenderAddress(params.event),
    To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.accountId,
    ChatType: params.event.roomType,
    ConversationLabel: buildConversationLabel(params.event),
    GroupSubject: params.event.roomType === "direct" ? undefined : params.event.roomId,
    SenderId: params.event.senderId,
    // Rocket.Chat messages handled by this plugin are explicit user turns,
    // including mentions in channels. OpenClaw 1.60 otherwise promotes
    // external channel traffic to `room_event`, whose strict
    // message-tool-only policy suppresses the plugin-owned reply lifecycle.
    InboundEventKind: "user_request",
    Provider: "rocketchat",
    Surface: "rocketchat",
    MessageSid: params.event.messageId,
    MessageSidFull: params.event.messageId,
    Timestamp: timestamp,
    OriginatingChannel: "rocketchat",
    OriginatingTo: to,
    ...mediaContext
  });

  await params.channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.mainSessionKey ?? route.sessionKey,
      channel: "rocketchat",
      to,
      accountId: route.accountId ?? params.accountId
    },
    onRecordError: params.onRecordError
  });

  const dispatchResult = normalizeReplyDispatchResult(
    await params.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: params.cfg,
      dispatcherOptions: {
        deliver: async (payload, info) => {
          await params.deliver(normalizeOutboundReplyPayload(payload), info);
        },
        onError: params.onDispatchError
      },
      // OpenClaw 2026.6 defaults external group/channel turns to
      // `message_tool_only`. Rocket.Chat owns a thread-anchored reply
      // lifecycle, so automatic source delivery must stay enabled; otherwise
      // the model posts through the generic message tool while our lifecycle
      // is left with an empty "thinking" placeholder.
      replyOptions: {
        sourceReplyDeliveryMode: "automatic"
      }
    })
  );

  if (!hasAnyReplyDispatch(dispatchResult)) {
    logAttachmentWarn(logContext, {
      type: "reply-dispatch-empty",
      queuedFinal: dispatchResult.queuedFinal,
      counts: dispatchResult.counts
    });
  }
}

function normalizeReplyDispatchResult(value: unknown): ReplyDispatchResult {
  if (!value || typeof value !== "object") {
    return {
      queuedFinal: false,
      counts: {
        tool: 0,
        block: 0,
        final: 0
      }
    };
  }

  const record = value as Record<string, unknown>;
  const countsRecord =
    record.counts && typeof record.counts === "object"
      ? (record.counts as Record<string, unknown>)
      : undefined;

  return {
    queuedFinal: record.queuedFinal === true,
    counts: {
      tool: toCount(countsRecord?.tool),
      block: toCount(countsRecord?.block),
      final: toCount(countsRecord?.final)
    }
  };
}

/**
 * Replace the agent id segment of a sessionKey while preserving the rest.
 * OpenClaw session keys follow `agent:<id>:<channel>:<peer.kind>:<peer.id>`.
 * If the key doesn't match that pattern the original is returned unchanged
 * (and an override request is logged) — better to dispatch to the wrong
 * agent than to crash on a runtime format change.
 */
export function rebuildSessionKeyForAgent(original: string, agentId: string): string {
  const parts = original.split(":");
  if (parts.length >= 2 && parts[0] === "agent") {
    parts[1] = agentId;
    return parts.join(":");
  }
  console.warn(
    `[rocketchat] cannot apply agent override "${agentId}" to sessionKey "${original}" — unrecognised format`
  );
  return original;
}

export function applyAgentOverride(
  route: ResolvedAgentRoute,
  override: string | undefined
): ResolvedAgentRoute {
  if (!override || override === route.agentId) {
    return route;
  }
  return {
    ...route,
    agentId: override,
    sessionKey: rebuildSessionKeyForAgent(route.sessionKey, override),
    mainSessionKey: route.mainSessionKey
      ? rebuildSessionKeyForAgent(route.mainSessionKey, override)
      : undefined
  };
}

/**
 * Rocket.Chat channels are thread-first: a top-level mention starts a thread,
 * while follow-up messages carry its `tmid`. Use that stable anchor in the
 * OpenClaw session key so each thread gets independent conversational state.
 * Direct messages deliberately retain room-scoped continuity.
 */
export function applyThreadScope(
  route: ResolvedAgentRoute,
  event: Pick<InboundEvent, "roomType" | "messageId" | "tmid">,
  enabled = true
): ResolvedAgentRoute {
  if (!enabled || event.roomType === "direct") {
    return route;
  }

  const threadId = event.tmid ?? event.messageId;
  return {
    ...route,
    sessionKey: `${route.sessionKey}:thread:${threadId}`
  };
}

function hasAnyReplyDispatch(result: ReplyDispatchResult): boolean {
  return (
    result.queuedFinal ||
    result.counts.tool > 0 ||
    result.counts.block > 0 ||
    result.counts.final > 0
  );
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeOutboundReplyPayload(payload: unknown): OutboundReplyPayload {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const record = payload as Record<string, unknown>;
  const mediaUrls = Array.isArray(record.mediaUrls)
    ? record.mediaUrls.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : undefined;

  const text = resolveOutboundText(record);
  const mediaUrl = typeof record.mediaUrl === "string" ? record.mediaUrl : undefined;
  const replyToId = typeof record.replyToId === "string" ? record.replyToId : undefined;

  return {
    ...(text ? { text } : {}),
    ...(mediaUrl ? { mediaUrl } : {}),
    ...(mediaUrls && mediaUrls.length > 0 ? { mediaUrls } : {}),
    ...(replyToId ? { replyToId } : {})
  };
}

function resolveOutboundText(record: Record<string, unknown>): string | undefined {
  const directText = typeof record.text === "string" ? record.text : undefined;
  if (directText?.trim()) {
    return directText;
  }

  return resolveInteractiveTextFallback(record.interactive) ?? directText;
}

function resolveInteractiveTextFallback(interactive: unknown): string | undefined {
  if (!interactive || typeof interactive !== "object" || Array.isArray(interactive)) {
    return undefined;
  }

  const blocks = (interactive as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) {
    return undefined;
  }

  const textBlocks = blocks
    .map((block) => normalizeInteractiveTextBlock(block))
    .filter((value): value is string => typeof value === "string");

  if (textBlocks.length === 0) {
    return undefined;
  }

  return textBlocks.join("\n\n");
}

function normalizeInteractiveTextBlock(block: unknown): string | undefined {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return undefined;
  }

  const record = block as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type.trim().toLowerCase() !== "text") {
    return undefined;
  }

  if (typeof record.text !== "string") {
    return undefined;
  }

  const text = record.text.trim();
  return text.length > 0 ? text : undefined;
}

function buildConversationLabel(event: InboundEvent): string {
  if (event.roomType === "direct") {
    return `${event.senderName} (${event.senderId})`;
  }

  return `${event.roomType}:${event.roomId}`;
}

function buildSenderAddress(event: InboundEvent): string {
  return `rocketchat:${event.senderId}`;
}

function buildRecipientAddress(event: InboundEvent): string {
  return `rocketchat:${event.roomId}`;
}

function toEpochMs(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Build a `Thread context (parent + prior replies)` preamble when the
 * inbound event lives inside a thread. Returns `null` when:
 *   - the event has no `tmid` (top-level message — no parent),
 *   - no `threadContextClient` was provided,
 *   - or both the parent fetch and the thread-replies fetch return
 *     nothing useful.
 *
 * The returned string is plain text that can be prepended to the
 * agent body. It does NOT include the trigger message itself (that
 * stays in `event.text` and is appended by the caller).
 *
 * The bot's own previous replies in the thread are included so it
 * can pick up where it left off without re-asking. The cap is
 * conservative — see THREAD_CONTEXT_MAX_CHARS / _REPLY_COUNT.
 */
async function buildThreadContextSection(
  event: InboundEvent,
  client: ThreadContextClientLike | undefined,
  logContext: AttachmentLogContext
): Promise<string | null> {
  if (!event.tmid || !client) {
    return null;
  }

  let parent: Awaited<ReturnType<ThreadContextClientLike["getMessage"]>> = null;
  let replies: Awaited<ReturnType<ThreadContextClientLike["getThreadMessages"]>> = [];

  try {
    parent = await client.getMessage(event.tmid);
  } catch (error) {
    logAttachmentWarn(logContext, {
      type: "thread-context-parent-failed",
      tmid: event.tmid,
      error: describeError(error)
    });
  }

  try {
    replies = await client.getThreadMessages(event.tmid, THREAD_CONTEXT_REPLY_COUNT);
  } catch (error) {
    logAttachmentWarn(logContext, {
      type: "thread-context-replies-failed",
      tmid: event.tmid,
      error: describeError(error)
    });
  }

  // Drop the trigger message itself out of the replies list (we
  // already have it in event.text — repeating it just wastes tokens
  // and confuses the agent into thinking the same line was said
  // twice).
  const repliesExcludingTrigger = replies.filter((r) => r.id !== event.messageId);

  if (!parent && repliesExcludingTrigger.length === 0) {
    return null;
  }

  const lines: string[] = ["[Thread context — Nachrichten ÜBER der aktuellen Antwort]"];

  if (parent) {
    const parentLine = parent.text.trim().length > 0
      ? `Parent (@${parent.username}): ${parent.text.trim()}`
      : `Parent (@${parent.username}): (Nachricht ohne Text — vermutlich Attachment/Reaktion)`;
    lines.push(parentLine);
  }

  if (repliesExcludingTrigger.length > 0) {
    lines.push("");
    lines.push("Vorherige Thread-Antworten (chronologisch):");
    for (const reply of repliesExcludingTrigger) {
      const trimmedText = reply.text.trim();
      if (trimmedText.length === 0) continue;
      lines.push(`  @${reply.username}: ${trimmedText}`);
    }
  }

  lines.push("[Ende Thread context]");
  const section = lines.join("\n");

  if (section.length <= THREAD_CONTEXT_MAX_CHARS) {
    return section;
  }

  // Soft-cap: keep the leading parent + a trimming notice so the agent
  // knows context was clipped rather than ending mid-sentence and
  // wondering whether they missed something important.
  return (
    section.slice(0, THREAD_CONTEXT_MAX_CHARS - 80).trimEnd() +
    `\n  …[Thread-Kontext nach ${THREAD_CONTEXT_MAX_CHARS} Zeichen abgeschnitten]\n[Ende Thread context]`
  );
}

async function buildMediaContext(
  attachments: InboundAttachment[],
  attachmentClient: AttachmentDownloadClientLike | undefined,
  logContext: AttachmentLogContext
): Promise<Record<string, unknown>> {
  const mediaUrls: string[] = [];
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];

  for (const attachment of attachments) {
    const mimeType = attachment.mimeType?.trim();

    if (shouldMaterializeAttachment(attachment) && attachment.url && attachmentClient) {
      try {
        const filePath = await attachmentClient.downloadAttachmentToTempFile(attachment.url, {
          fileName: attachment.fileName
        });
        mediaPaths.push(filePath);
        if (mimeType) {
          mediaTypes.push(mimeType);
        }
        continue;
      } catch (error) {
        logAttachmentWarn(logContext, {
          type: "attachment-download-failed",
          source: attachment.source,
          kind: attachment.kind,
          fileName: attachment.fileName,
          mimeType,
          url: attachment.url,
          error: describeError(error)
        });
        continue;
      }
    }

    if (attachment.url) {
      mediaUrls.push(attachment.url);
      if (mimeType) {
        mediaTypes.push(mimeType);
      }
    }
  }

  return {
    ...(mediaUrls.length > 0
      ? {
          MediaUrl: mediaUrls[0],
          MediaUrls: mediaUrls
        }
      : {}),
    ...(mediaPaths.length > 0
      ? {
          MediaPath: mediaPaths[0],
          MediaPaths: mediaPaths
        }
      : {}),
    ...(mediaTypes.length > 0
      ? {
          MediaType: mediaTypes[0],
          MediaTypes: mediaTypes
        }
      : {})
  };
}

function shouldMaterializeAttachment(attachment: InboundAttachment): boolean {
  return attachment.source === "rocketchat-file";
}

type AttachmentLogContext = {
  accountId: string;
  roomId: string;
  messageId: string;
};

function logAttachmentWarn(
  context: AttachmentLogContext,
  payload: Record<string, unknown>
): void {
  console.warn(formatAttachmentLog(context, payload));
}

function formatAttachmentLog(
  context: AttachmentLogContext,
  payload: Record<string, unknown>
): string {
  return `[rocketchat:${context.accountId}] ${JSON.stringify({
    roomId: context.roomId,
    messageId: context.messageId,
    ...payload
  })}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
