import { homedir } from "node:os";
import { join } from "node:path";

import { FileCheckpointStore } from "./checkpoints.js";
import { sendReplyLifecycle, shouldHandleInboundEvent } from "./channel.js";
import { RocketChatClient } from "./client.js";
import { parsePluginConfig, type PluginAccountConfig } from "./config.js";
import type { InboundAttachment } from "./inbound/attachments.js";
import { RestPollingTransport } from "./inbound/polling.js";
import type { InboundTransport } from "./inbound/types.js";
import { createWebSocketTransport } from "./inbound/websocket.js";
import {
  dispatchInboundEventWithChannelRuntime,
  type ChannelRuntimeLike,
  type OpenClawConfigLike
} from "./inbound-dispatch.js";

type ResolvedAccount = PluginAccountConfig & {
  accountId: string;
};

type OpenClawConfig = {
  session?: {
    store?: string;
  };
  channels?: {
    rocketchat?: unknown;
  };
};

type PluginApi = {
  registerChannel(args: { plugin: unknown }): void;
};

type RuntimeReplyHandler = {
  handleInboundMessage?: (payload: {
    channel: string;
    accountId: string;
    senderId: string;
    senderName: string;
    chatType: "direct" | "group" | "channel";
    chatId: string;
    text: string;
    raw: unknown;
    mentions: string[];
    attachments: InboundAttachment[];
    reply: (responseText: string) => Promise<void>;
  }) => Promise<void>;
};

export const rocketchatPlugin = {
  id: "rocketchat",
  meta: {
    id: "rocketchat",
    label: "Rocket.Chat",
    selectionLabel: "Rocket.Chat (REST Polling)",
    docsPath: "/channels/rocketchat",
    docsLabel: "rocketchat",
    blurb: "Rocket.Chat channel plugin with REST polling and mention-gated group replies.",
    aliases: ["rocket-chat", "rc"]
  },
  capabilities: {
    chatTypes: ["direct", "group", "channel"],
    media: false,
    threads: false
  },
  config: {
    listAccountIds(cfg: OpenClawConfig): string[] {
      return Object.keys(parseChannelConfig(cfg).accounts);
    },
    resolveAccount(cfg: OpenClawConfig, accountId: string): ResolvedAccount | null {
      const account = parseChannelConfig(cfg).accounts[accountId];
      return account ? { ...account, accountId } : null;
    },
    isConfigured(account: Partial<ResolvedAccount> | null | undefined): boolean {
      return Boolean(account?.serverUrl && account.auth);
    }
  },
  gateway: {
    async startAccount(ctx: {
      accountId: string;
      account?: ResolvedAccount;
      cfg?: OpenClawConfig;
      abortSignal?: AbortSignal;
      runtime?: {
        channel?: {
          reply?: RuntimeReplyHandler;
        };
      };
      channelRuntime?: ChannelRuntimeLike;
      setStatus?: (status: string) => void;
    }): Promise<void> {
      const account = ctx.account ?? rocketchatPlugin.config.resolveAccount(ctx.cfg ?? {}, ctx.accountId);
      if (!account || !account.enabled) {
        ctx.setStatus?.("disabled");
        return;
      }

      const client = new RocketChatClient({
        serverUrl: account.serverUrl,
        auth: account.auth
      });
      const identity = await client.initialize();
      ctx.setStatus?.("connected");

      const checkpointStore = new FileCheckpointStore(checkpointPathForAccount(account.accountId), 250);
      const fatalError = createDeferred<void>();
      let warnedAboutMissingRuntime = false;
      const transport = createInboundTransport({
        account,
        identity,
        client,
        checkpointStore,
        onDisconnect: async (error) => {
          fatalError.reject(asError(error));
        },
        onError: async (error) => {
          console.warn(
            `[rocketchat:${account.accountId}] inbound error: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        },
        onEvent: async (event) => {
          const mentionNames = dedupeMentions([identity.username, ...account.mentionNames]);
          if (
            !shouldHandleInboundEvent(event, {
              botUserId: identity.userId,
              mentionNames
            })
          ) {
            return;
          }

          if (ctx.channelRuntime) {
            const channelRuntime = ctx.channelRuntime;
            await sendReplyLifecycle({
              client,
              roomId: event.roomId,
              run: async (session) => {
                await dispatchInboundEventWithChannelRuntime({
                  cfg: (ctx.cfg ?? {}) as OpenClawConfigLike,
                  accountId: account.accountId,
                  event,
                  channelRuntime,
                  attachmentClient: client,
                  deliver: async (payload, info) => {
                    await session.update({
                      kind: info.kind,
                      payload
                    });
                  },
                  onRecordError: (error) => {
                    console.warn(
                      `[rocketchat:${account.accountId}] failed to record inbound session: ${
                        error instanceof Error ? error.message : String(error)
                      }`
                    );
                  },
                  onDispatchError: (error, info) => {
                    console.warn(
                      `[rocketchat:${account.accountId}] ${info.kind} dispatch failed: ${
                        error instanceof Error ? error.message : String(error)
                      }`
                    );
                  }
                });
              }
            });
            return;
          }

          const handleInboundMessage = ctx.runtime?.channel?.reply?.handleInboundMessage;
          if (typeof handleInboundMessage !== "function") {
            if (!warnedAboutMissingRuntime) {
              warnedAboutMissingRuntime = true;
              console.warn(
                `[rocketchat:${account.accountId}] channel runtime is unavailable; inbound messages will be ignored`
              );
            }
            return;
          }

          await handleInboundMessage({
            channel: "rocketchat",
            accountId: account.accountId,
            senderId: event.senderId,
            senderName: event.senderName,
            chatType: event.roomType,
            chatId: event.roomId,
            text: event.text,
            raw: event.raw,
            mentions: event.mentions,
            attachments: event.attachments,
            reply: async (responseText: string) => {
              await sendReplyLifecycle({
                client,
                roomId: event.roomId,
                finalText: responseText
              });
            }
          });
        }
      });

      if (account.transport.mode === "polling" && hasSafePollOnce(transport)) {
        await transport.safePollOnce();
      }

      await transport.start();

      if (!ctx.abortSignal) {
        return;
      }

      try {
        await Promise.race([waitForAbort(ctx.abortSignal), fatalError.promise]);
      } finally {
        await transport.stop();
        ctx.setStatus?.("stopped");
      }
    }
  },
  outbound: {
    deliveryMode: "direct",
    async sendText(params: {
      cfg?: OpenClawConfig;
      accountId: string;
      to: string;
      text: string;
    }): Promise<{ ok: true; messageId: string }> {
      const account = rocketchatPlugin.config.resolveAccount(params.cfg ?? {}, params.accountId);
      if (!account) {
        throw new Error(`Unknown Rocket.Chat account: ${params.accountId}`);
      }

      const client = new RocketChatClient({
        serverUrl: account.serverUrl,
        auth: account.auth
      });
      await client.initialize();
      const messageId = await client.postMessage(params.to, params.text);

      return {
        ok: true,
        messageId
      };
    }
  }
};

export function registerRockeChatPlugin(api: PluginApi): void {
  api.registerChannel({ plugin: rocketchatPlugin });
}

function parseChannelConfig(cfg: OpenClawConfig): ReturnType<typeof parsePluginConfig> {
  const input = cfg.channels?.rocketchat ?? cfg;
  return parsePluginConfig(input);
}

export function checkpointPathForAccount(
  accountId: string,
  options?: {
    env?: Record<string, string | undefined>;
    homedir?: () => string;
  }
): string {
  const env = options?.env ?? process.env;
  const getHomeDirectory = options?.homedir ?? homedir;
  const openclawHome = env.OPENCLAW_HOME?.trim() || join(getHomeDirectory(), ".openclaw");
  return join(openclawHome, "rocketchat", `${accountId}.json`);
}

function formatOutboundPayload(payload: {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}): string {
  const parts: string[] = [];
  const text = payload.text?.trim();
  if (text) {
    parts.push(text);
  }

  const mediaUrls = [
    ...(payload.mediaUrls ?? []),
    ...(payload.mediaUrl ? [payload.mediaUrl] : [])
  ].filter((value) => value.trim().length > 0);
  if (mediaUrls.length > 0) {
    parts.push(mediaUrls.join("\n"));
  }

  return parts.join("\n\n").trim();
}

function dedupeMentions(mentions: string[]): string[] {
  return [...new Set(mentions.map((mention) => mention.trim()).filter(Boolean))];
}

function createInboundTransport(params: {
  account: ResolvedAccount;
  identity: {
    userId: string;
    authToken: string;
  };
  client: RocketChatClient;
  checkpointStore: FileCheckpointStore;
  onEvent: Parameters<typeof createWebSocketTransport>[0]["onEvent"];
  onError: Parameters<typeof createWebSocketTransport>[0]["onError"];
  onDisconnect: Parameters<typeof createWebSocketTransport>[0]["onDisconnect"];
}): RestPollingTransport | ReturnType<typeof createWebSocketTransport> {
  if (params.account.transport.mode === "websocket") {
    return createWebSocketTransport({
      accountId: params.account.accountId,
      botUserId: params.identity.userId,
      serverUrl: params.account.serverUrl,
      userId: params.identity.userId,
      authToken: params.identity.authToken,
      client: params.client,
      checkpointStore: params.checkpointStore,
      onEvent: params.onEvent,
      onError: params.onError,
      onDisconnect: params.onDisconnect
    });
  }

  return new RestPollingTransport({
    accountId: params.account.accountId,
    botUserId: params.identity.userId,
    client: params.client,
    serverUrl: params.account.serverUrl,
    checkpointStore: params.checkpointStore,
    pollIntervalMs: params.account.transport.pollIntervalMs,
    onError: params.onError,
    onEvent: params.onEvent
  });
}

function hasSafePollOnce(
  transport: InboundTransport | RestPollingTransport
): transport is RestPollingTransport {
  return "safePollOnce" in transport && typeof transport.safePollOnce === "function";
}

async function waitForAbort(abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve(), {
      once: true
    });
  });
}

function createDeferred<T>() {
  let settled = false;
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };
    rejectPromise = (reason) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(reason);
    };
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
