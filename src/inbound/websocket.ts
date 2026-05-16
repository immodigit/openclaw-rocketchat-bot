import type { RocketChatMessageRecord, RocketChatSubscriptionRecord } from "../client.js";
import { getMessageAttachmentInputs, normalizeInboundAttachments } from "./attachments.js";
import type { InboundEvent, InboundTransport } from "./types.js";

type CheckpointStoreLike = {
  hasSeen(accountId: string, messageId: string): Promise<boolean>;
  markSeen(accountId: string, messageId: string): Promise<void>;
};

type SubscriptionClient = {
  listSubscriptions(updatedSince: string | null): Promise<RocketChatSubscriptionRecord[]>;
};

type WebSocketMessageEvent = {
  data?: string;
};

type WebSocketLike = {
  addEventListener(type: string, listener: (event?: unknown) => void): void;
  send(payload: string): void;
  close(code?: number): void;
};

type WebSocketTransportOptions = {
  accountId: string;
  botUserId: string;
  serverUrl: string;
  userId: string;
  authToken: string;
  client: SubscriptionClient;
  checkpointStore: CheckpointStoreLike;
  onEvent(event: InboundEvent): Promise<void>;
  onError?(error: unknown): Promise<void> | void;
  onDisconnect?(error: unknown): Promise<void> | void;
  websocketFactory?: (url: string) => WebSocketLike;
};

export function createWebSocketTransport(options: WebSocketTransportOptions): InboundTransport {
  return new RocketChatWebSocketTransport(options);
}

class RocketChatWebSocketTransport implements InboundTransport {
  private readonly accountId: string;
  private readonly botUserId: string;
  private readonly serverUrl: string;
  private readonly userId: string;
  private readonly authToken: string;
  private readonly client: SubscriptionClient;
  private readonly checkpointStore: CheckpointStoreLike;
  private readonly onEvent: (event: InboundEvent) => Promise<void>;
  private readonly onError: (error: unknown) => Promise<void> | void;
  private readonly onDisconnect: (error: unknown) => Promise<void> | void;
  private readonly websocketFactory: (url: string) => WebSocketLike;
  private socket: WebSocketLike | null = null;
  private stopped = false;
  private startPromise: Promise<void> | null = null;
  private roomTypes = new Map<string, InboundEvent["roomType"]>();
  private subscribedRooms = new Set<string>();
  private refreshPromise: Promise<void> = Promise.resolve();

  constructor(options: WebSocketTransportOptions) {
    this.accountId = options.accountId;
    this.botUserId = options.botUserId;
    this.serverUrl = options.serverUrl;
    this.userId = options.userId;
    this.authToken = options.authToken;
    this.client = options.client;
    this.checkpointStore = options.checkpointStore;
    this.onEvent = options.onEvent;
    this.onError = options.onError ?? (() => undefined);
    this.onDisconnect = options.onDisconnect ?? (() => undefined);
    this.websocketFactory = options.websocketFactory ?? defaultWebSocketFactory;
  }

  kind(): "websocket" {
    return "websocket";
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.stopped = false;
    this.startPromise = new Promise<void>((resolve, reject) => {
      let startupComplete = false;
      const rejectOrDisconnect = (error: unknown) => {
        if (!startupComplete) {
          reject(asError(error));
          return;
        }

        void this.onDisconnect(error);
      };

      this.socket = this.websocketFactory(toWebSocketUrl(this.serverUrl));
      this.socket.addEventListener("open", () => {
        this.send({
          msg: "connect",
          version: "1",
          support: ["1"]
        });
      });
      this.socket.addEventListener("message", (event) => {
        void this.handleMessage(event as WebSocketMessageEvent, {
          markStartupComplete: () => {
            startupComplete = true;
            resolve();
          },
          rejectStartup: rejectOrDisconnect
        });
      });
      this.socket.addEventListener("error", () => {
        rejectOrDisconnect(new Error("Rocket.Chat websocket error"));
      });
      this.socket.addEventListener("close", () => {
        if (this.stopped) {
          return;
        }

        rejectOrDisconnect(new Error("Rocket.Chat websocket closed"));
      });
    });

    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  private async handleMessage(
    event: WebSocketMessageEvent,
    callbacks: {
      markStartupComplete(): void;
      rejectStartup(error: unknown): void;
    }
  ): Promise<void> {
    const payload = parseFrame(event);
    if (!payload) {
      return;
    }

    if (payload.msg === "ping") {
      this.send({ msg: "pong" });
      return;
    }

    if (payload.msg === "connected") {
      this.send({
        msg: "method",
        method: "login",
        id: "login",
        params: [{ resume: this.authToken }]
      });
      return;
    }

    if (payload.msg === "result" && payload.id === "login") {
      if (payload.error) {
        callbacks.rejectStartup(new Error(getFrameErrorMessage(payload.error)));
        return;
      }

      try {
        await this.bootstrapSubscriptions();
        callbacks.markStartupComplete();
      } catch (error) {
        callbacks.rejectStartup(error);
      }
      return;
    }

    if (payload.msg === "changed") {
      if (payload.collection === "stream-room-messages") {
        await this.handleRoomMessage(payload.fields);
        return;
      }

      if (payload.collection === "stream-notify-user") {
        this.handleUserNotification(payload.fields);
      }
    }
  }

  private async bootstrapSubscriptions(): Promise<void> {
    this.send({
      msg: "sub",
      id: "sub:user:subscriptions-changed",
      name: "stream-notify-user",
      params: [`${this.userId}/subscriptions-changed`, false]
    });
    this.send({
      msg: "sub",
      id: "sub:user:rooms-changed",
      name: "stream-notify-user",
      params: [`${this.userId}/rooms-changed`, false]
    });

    await this.refreshRoomSubscriptions();
  }

  private handleUserNotification(fields: ChangedFields | undefined): void {
    const eventName = fields?.eventName;
    if (
      eventName !== `${this.userId}/subscriptions-changed` &&
      eventName !== `${this.userId}/rooms-changed`
    ) {
      return;
    }

    this.refreshPromise = this.refreshPromise
      .then(() => this.refreshRoomSubscriptions())
      .catch(async (error) => {
        await this.onError(error);
      });
  }

  private async refreshRoomSubscriptions(): Promise<void> {
    const subscriptions = await this.client.listSubscriptions(null);
    for (const subscription of subscriptions) {
      if (!subscription.rid) {
        continue;
      }

      this.roomTypes.set(subscription.rid, mapRoomType(subscription.t));
      if (this.subscribedRooms.has(subscription.rid)) {
        continue;
      }

      this.send({
        msg: "sub",
        id: `sub:room:${subscription.rid}`,
        name: "stream-room-messages",
        params: [subscription.rid, false]
      });
      this.subscribedRooms.add(subscription.rid);
    }
  }

  private async handleRoomMessage(fields: ChangedFields | undefined): Promise<void> {
    const eventName = fields?.eventName ?? "";
    const message = asMessageRecord(fields?.args?.[0]);
    if (!message || (await this.shouldIgnoreMessage(message))) {
      return;
    }

    const roomId = message.rid || eventName;
    const event = toInboundEvent(this.accountId, this.roomTypes.get(roomId) ?? "channel", {
      ...message,
      rid: roomId
    }, this.serverUrl);

    await this.onEvent(event);
    await this.checkpointStore.markSeen(this.accountId, message._id);
  }

  private async shouldIgnoreMessage(message: RocketChatMessageRecord): Promise<boolean> {
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

  private send(frame: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(frame));
  }
}

type DdpFrame = {
  msg?: string;
  id?: string;
  collection?: string;
  fields?: ChangedFields;
  error?: unknown;
};

type ChangedFields = {
  eventName?: string;
  args?: unknown[];
};

function parseFrame(event: WebSocketMessageEvent): DdpFrame | null {
  if (!event.data || typeof event.data !== "string") {
    return null;
  }

  return JSON.parse(event.data) as DdpFrame;
}

function asMessageRecord(value: unknown): RocketChatMessageRecord | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as RocketChatMessageRecord;
  }

  return null;
}

function toInboundEvent(
  accountId: string,
  roomType: InboundEvent["roomType"],
  message: RocketChatMessageRecord,
  serverUrl: string | undefined
): InboundEvent {
  return {
    accountId,
    roomId: message.rid,
    roomType,
    messageId: message._id,
    tmid: message.tmid ?? null,
    senderId: message.u?._id ?? "",
    senderName: message.u?.username ?? message.u?.name ?? "",
    text: message.msg ?? "",
    mentions: (message.mentions ?? [])
      .map((mention) => mention.username ?? mention.name ?? "")
      .filter((mention): mention is string => Boolean(mention)),
    attachments: normalizeInboundAttachments(getMessageAttachmentInputs(message), {
      serverUrl
    }),
    sentAt: message.ts ?? message._updatedAt ?? new Date(0).toISOString(),
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

function toWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/websocket";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getFrameErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "reason" in error && typeof error.reason === "string") {
    return error.reason;
  }

  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  return "Rocket.Chat websocket login failed";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const ctor = globalThis.WebSocket;
  if (typeof ctor !== "function") {
    throw new Error("WebSocket is not available in this runtime");
  }

  return new ctor(url) as unknown as WebSocketLike;
}
