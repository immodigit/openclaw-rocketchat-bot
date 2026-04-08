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
    }): Promise<unknown>;
  };
};

export async function dispatchInboundEventWithChannelRuntime(params: {
  cfg: OpenClawConfigLike;
  accountId: string;
  event: InboundEvent;
  channelRuntime: ChannelRuntimeLike;
  attachmentClient?: AttachmentDownloadClientLike;
  deliver(payload: OutboundReplyPayload, info: ReplyDeliverInfo): Promise<void>;
  onRecordError(err: unknown): void;
  onDispatchError(err: unknown, info: ReplyDeliverInfo): void;
}): Promise<void> {
  const logContext = {
    accountId: params.accountId,
    roomId: params.event.roomId,
    messageId: params.event.messageId
  };
  const route = params.channelRuntime.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: "rocketchat",
    accountId: params.accountId,
    peer: {
      kind: params.event.roomType,
      id: params.event.roomId
    }
  });
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
  const body = params.channelRuntime.reply.formatAgentEnvelope({
    channel: "Rocket.Chat",
    from: buildConversationLabel(params.event),
    timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: params.event.text
  });
  const mediaContext = await buildMediaContext(
    params.event.attachments,
    params.attachmentClient,
    logContext
  );
  const ctxPayload = params.channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.event.text,
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
      }
    })
  );

  logAttachmentInfo(logContext, {
    type: "reply-dispatch-result",
    queuedFinal: dispatchResult.queuedFinal,
    counts: dispatchResult.counts
  });

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

async function buildMediaContext(
  attachments: InboundAttachment[],
  attachmentClient: AttachmentDownloadClientLike | undefined,
  logContext: AttachmentLogContext
): Promise<Record<string, unknown>> {
  const mediaUrls: string[] = [];
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];

  if (attachments.length > 0) {
    logAttachmentInfo(logContext, {
      type: "attachment-summary",
      attachments: attachments.map((attachment, index) => ({
        index,
        source: attachment.source,
        kind: attachment.kind,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        url: attachment.url
      }))
    });
  }

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
        logAttachmentInfo(logContext, {
          type: "attachment-materialized",
          source: attachment.source,
          kind: attachment.kind,
          fileName: attachment.fileName,
          mimeType,
          url: attachment.url,
          path: filePath
        });
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

  if (attachments.length > 0) {
    logAttachmentInfo(logContext, {
      type: "attachment-media-context",
      mediaUrlCount: mediaUrls.length,
      mediaPathCount: mediaPaths.length,
      mediaTypes
    });
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

function logAttachmentInfo(
  context: AttachmentLogContext,
  payload: Record<string, unknown>
): void {
  console.info(formatAttachmentLog(context, payload));
}

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
