import type { CheckpointState } from "../checkpoints.js";
import type {
  RocketChatClient,
  RocketChatMessageRecord as MessageRecord,
  RocketChatRateLimitError,
  RocketChatSubscriptionRecord as SubscriptionRecord
} from "../client.js";
import { getMessageAttachmentInputs, normalizeInboundAttachments } from "./attachments.js";
import type { InboundEvent, InboundTransport } from "./types.js";

type CheckpointStoreLike = {
  read(accountId: string): Promise<CheckpointState>;
  write(accountId: string, state: CheckpointState): Promise<void>;
  hasSeen(accountId: string, messageId: string): Promise<boolean>;
  markSeen(accountId: string, messageId: string): Promise<void>;
};

type PollingClient = Pick<RocketChatClient, "listSubscriptions" | "syncMessages">;

type RestPollingTransportOptions = {
  accountId: string;
  botUserId: string;
  client: PollingClient;
  serverUrl?: string;
  checkpointStore: CheckpointStoreLike;
  onEvent(event: InboundEvent): Promise<void>;
  onError?(error: unknown): Promise<void> | void;
  now?: () => string;
  nowMs?: () => number;
  pollIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
};

export class RestPollingTransport implements InboundTransport {
  private readonly accountId: string;
  private readonly botUserId: string;
  private readonly client: PollingClient;
  private readonly serverUrl: string | undefined;
  private readonly checkpointStore: CheckpointStoreLike;
  private readonly onEvent: (event: InboundEvent) => Promise<void>;
  private readonly onError: (error: unknown) => Promise<void> | void;
  private readonly now: () => string;
  private readonly nowMs: () => number;
  private readonly pollIntervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private timer: ReturnType<typeof setInterval> | null = null;
  private blockedUntilMs = 0;

  constructor(options: RestPollingTransportOptions) {
    this.accountId = options.accountId;
    this.botUserId = options.botUserId;
    this.client = options.client;
    this.serverUrl = options.serverUrl;
    this.checkpointStore = options.checkpointStore;
    this.onEvent = options.onEvent;
    this.onError = options.onError ?? (() => undefined);
    this.now = options.now ?? (() => new Date().toISOString());
    this.nowMs = options.nowMs ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  }

  kind(): "polling" {
    return "polling";
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    this.timer = this.setIntervalFn(() => {
      void this.safePollOnce();
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    const checkpoint = await this.checkpointStore.read(this.accountId);
    if (!checkpoint.updatedSince) {
      await this.checkpointStore.write(this.accountId, {
        updatedSince: this.now(),
        recentMessageIds: checkpoint.recentMessageIds
      });
      return;
    }

    const subscriptions = await this.client.listSubscriptions(checkpoint.updatedSince);
    let nextUpdatedSince: string = checkpoint.updatedSince;

    for (const subscription of subscriptions) {
      nextUpdatedSince = maxTimestampStrict(
        nextUpdatedSince,
        subscription._updatedAt ?? subscription.updatedAt ?? null
      );

      const messages = await this.client.syncMessages(subscription.rid, checkpoint.updatedSince);

      for (const message of messages) {
        if (await this.shouldIgnoreMessage(message)) {
          nextUpdatedSince = maxTimestampStrict(
            nextUpdatedSince,
            message.ts ?? message._updatedAt ?? null
          );
          continue;
        }

        const event = toInboundEvent(this.accountId, subscription, message, this.serverUrl);
        await this.onEvent(event);
        await this.checkpointStore.markSeen(this.accountId, message._id);
        nextUpdatedSince = maxTimestampStrict(
          nextUpdatedSince,
          message.ts ?? message._updatedAt ?? null
        );
      }
    }

    const current = await this.checkpointStore.read(this.accountId);
    await this.checkpointStore.write(this.accountId, {
      updatedSince: nextUpdatedSince,
      recentMessageIds: current.recentMessageIds
    });
  }

  async safePollOnce(): Promise<void> {
    if (this.nowMs() < this.blockedUntilMs) {
      return;
    }

    try {
      await this.pollOnce();
    } catch (error) {
      if (isRateLimitError(error)) {
        this.blockedUntilMs = this.nowMs() + error.retryAfterMs;
      }
      await this.onError(error);
    }
  }

  private async shouldIgnoreMessage(message: MessageRecord): Promise<boolean> {
    if (!message._id) {
      return true;
    }

    if (message.t) {
      return true;
    }

    if ((!message.msg || message.msg.trim().length === 0) && getMessageAttachmentInputs(message).length === 0) {
      return true;
    }

    if (message.u?._id === this.botUserId) {
      return true;
    }

    return this.checkpointStore.hasSeen(this.accountId, message._id);
  }
}

function toInboundEvent(
  accountId: string,
  subscription: SubscriptionRecord,
  message: MessageRecord,
  serverUrl: string | undefined
): InboundEvent {
  return {
    accountId,
    roomId: message.rid,
    roomType: mapRoomType(subscription.t),
    messageId: message._id,
    tmid: message.tmid ?? null,
    senderId: message.u?._id ?? "",
    senderName: message.u?.username ?? message.u?.name ?? "",
    text: message.msg ?? "",
    mentions: (message.mentions ?? [])
      .map((mention) => mention.username ?? mention.name ?? "")
      .filter((mention): mention is string => mention.length > 0),
    attachments: normalizeInboundAttachments(getMessageAttachmentInputs(message), {
      serverUrl
    }),
    sentAt: message.ts ?? new Date(0).toISOString(),
    raw: message
  };
}

function mapRoomType(type: string | undefined): InboundEvent["roomType"] {
  if (type === "d") {
    return "direct";
  }

  if (type === "p") {
    return "group";
  }

  return "channel";
}

function maxTimestamp(current: string | null, next: string | null): string | null {
  if (!next) {
    return current;
  }

  if (!current) {
    return next;
  }

  return Date.parse(next) > Date.parse(current) ? next : current;
}

function maxTimestampStrict(current: string, next: string | null): string {
  return maxTimestamp(current, next) ?? current;
}

function isRateLimitError(error: unknown): error is RocketChatRateLimitError {
  return (
    error instanceof Error &&
    error.name === "RocketChatRateLimitError" &&
    "retryAfterMs" in error &&
    typeof error.retryAfterMs === "number"
  );
}
