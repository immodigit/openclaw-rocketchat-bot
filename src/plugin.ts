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
import { getInboundAnchor, recordInboundAnchor } from "./inbound-state.js";

export type ResolvedAccount = PluginAccountConfig & {
  accountId: string;
};

export type OpenClawConfig = {
  session?: {
    store?: string;
  };
  channels?: {
    rocketchat?: unknown;
  };
};

type GatewayContext = {
  accountId: string;
  account?: ResolvedAccount;
  cfg?: OpenClawConfig;
  abortSignal?: AbortSignal;
  channelRuntime?: ChannelRuntimeLike;
  setStatus?: (status: string) => void;
};

export function resolveAccount(
  cfg: unknown,
  accountId?: string
): ResolvedAccount | null {
  const accounts = parseChannelConfig(cfg as OpenClawConfig).accounts;
  if (!accountId) return null;
  const account = accounts[accountId];
  return account ? { ...account, accountId } : null;
}

export function inspectAccount(
  cfg: unknown,
  accountId?: string
): { accountId: string; enabled: boolean; serverUrl: string; transportMode: string } | null {
  if (!accountId) return null;
  const account = parseChannelConfig(cfg as OpenClawConfig).accounts[accountId];
  return account
    ? {
        accountId,
        enabled: account.enabled,
        serverUrl: account.serverUrl,
        transportMode: account.transport.mode
      }
    : null;
}

export function listAccountIds(cfg: OpenClawConfig): string[] {
  return Object.keys(parseChannelConfig(cfg).accounts);
}

function isConfigured(account: Partial<ResolvedAccount> | null | undefined): boolean {
  return Boolean(account?.serverUrl && account.auth);
}

export const rocketchatPlugin = {
  config: {
    listAccountIds,
    resolveAccount,
    isConfigured
  },
  id: "rocketchat",
  gateway: {
    startAccount: startGateway
  },
  base: {
    id: "rocketchat",
    setup: {
      resolveAccount,
      inspectAccount
    }
  },
  security: {
    dm: {
      channelKey: "rocketchat" as const,
      resolvePolicy() {
        return "allowlist";
      },
      resolveAllowFrom() {
        return [];
      },
      defaultPolicy: "allowlist"
    }
  },
  threading: {
    topLevelReplyToMode: "reply" as const
  },
  messaging: {
    targetPrefixes: ["rocketchat", "channel", "user", "@"],
    normalizeTarget: (target: string): string | undefined => {
      const trimmed = target?.trim();
      if (!trimmed) {
        return undefined;
      }
      // `rocketchat:<roomId>` / `channel:<roomId>` / `user:<userId>` -> raw id
      return trimmed.replace(/^rocketchat:(?:channel:|user:)?/i, "").replace(/^channel:/i, "");
    },
    targetResolver: {
      looksLikeId: (id: string): boolean => {
        const trimmed = id?.trim();
        if (!trimmed) {
          return false;
        }
        // Mongo ObjectId-style (24 hex) or 17-char base62 Rocket.Chat ids,
        // plus prefixed forms we accept above.
        return (
          /^[a-z0-9]{8,32}$/i.test(trimmed) ||
          /^rocketchat:/i.test(trimmed) ||
          /^channel:/i.test(trimmed) ||
          /^user:/i.test(trimmed) ||
          /^@/.test(trimmed)
        );
      },
      hint: "<roomId|rocketchat:roomId|channel:roomId|user:userId|@username>"
    }
  },
  outbound: {
    deliveryMode: "direct" as const,
    resolveTarget: ({ to }: { to: string }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return { ok: false as const, error: new Error("Rocket.Chat send requires a target id") };
      }
      const normalized = trimmed
        .replace(/^rocketchat:(?:channel:|user:)?/i, "")
        .replace(/^channel:/i, "");
      return { ok: true as const, to: normalized };
    },
    sendText: async (params: {
      cfg?: unknown;
      accountId: string;
      to: string;
      text: string;
      replyToId?: string;
    }): Promise<{ ok: boolean; messageId: string; channel: string }> => {
      const account = resolveAccount(params.cfg ?? {}, params.accountId);
      if (!account) {
        throw new Error(`Unknown Rocket.Chat account: ${params.accountId}`);
      }
      const client = new RocketChatClient({
        serverUrl: account.serverUrl,
        auth: account.auth,
        mediaDir: attachmentMediaDir()
      });
      await client.initialize();
      const target = params.to
        .trim()
        .replace(/^rocketchat:(?:channel:|user:)?/i, "")
        .replace(/^channel:/i, "");

      // Compute the thread anchor. Caller-supplied replyToId wins;
      // otherwise consult the per-room cache populated by onEvent
      // (so tool-based sends that lack inbound context still thread).
      let tmid = params.replyToId;
      if (!tmid && account.forceThread !== false) {
        const anchor = getInboundAnchor(target);
        if (anchor) {
          tmid = anchor.tmid ?? anchor.messageId;
        }
      }

      const tmidOptions = tmid ? { tmid } : undefined;
      const messageId = await client.postMessage(target, params.text, tmidOptions);
      return { ok: true, messageId, channel: "rocketchat" };
    }
  }
};

export async function startGateway(ctx: GatewayContext): Promise<void> {
  const account =
    ctx.account ?? resolveAccount(ctx.cfg ?? {}, ctx.accountId);
  if (!account || !account.enabled) {
    ctx.setStatus?.("disabled");
    return;
  }

  const client = new RocketChatClient({
    serverUrl: account.serverUrl,
    auth: account.auth,
    mediaDir: attachmentMediaDir()
  });
  const identity = await client.initialize();
  ctx.setStatus?.("connected");

  const checkpointStore = new FileCheckpointStore(
    checkpointPathForAccount(account.accountId),
    250
  );
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

      // Cache the anchor so tool-based outbound (which doesn't carry the
      // inbound context) can still pin its reply to the right thread.
      recordInboundAnchor(event.roomId, {
        messageId: event.messageId,
        tmid: event.tmid
      });

      if (ctx.channelRuntime) {
        const channelRuntime = ctx.channelRuntime;
        // Always reply inside a thread. If the user @mentioned us inside an
        // existing thread, stick with that thread; otherwise create a new
        // thread anchored to the trigger message so channels stay tidy and
        // each conversation has its own thread context.
        const forceThread = account.forceThread !== false;
        const replyTmid = forceThread
          ? event.tmid ?? event.messageId
          : event.tmid ?? undefined;
        await sendReplyLifecycle({
          client,
          roomId: event.roomId,
          tmid: replyTmid ?? undefined,
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

      if (!warnedAboutMissingRuntime) {
        warnedAboutMissingRuntime = true;
        console.warn(
          `[rocketchat:${account.accountId}] channel runtime is unavailable; inbound messages will be ignored`
        );
      }
    }
  });

  if (account.transport.mode === "polling" && hasSafePollOnce(transport)) {
    await transport.safePollOnce();
  }

  await transport.start();

  try {
    if (ctx.abortSignal) {
      await Promise.race([waitForAbort(ctx.abortSignal), fatalError.promise]);
      return;
    }

    await fatalError.promise;
  } finally {
    await transport.stop();
    ctx.setStatus?.("stopped");
  }
}

export function checkpointPathForAccount(
  accountId: string,
  options?: {
    env?: Record<string, string | undefined>;
    homedir?: () => string;
  }
): string {
  return join(resolveOpenClawStateDir(options), "rocketchat", `${accountId}.json`);
}

export function attachmentMediaDir(options?: {
  env?: Record<string, string | undefined>;
  homedir?: () => string;
}): string {
  return join(resolveOpenClawStateDir(options), "media");
}

function parseChannelConfig(cfg: OpenClawConfig): ReturnType<typeof parsePluginConfig> {
  const nestedConfig = cfg.channels?.rocketchat;
  if (nestedConfig) {
    return parsePluginConfig(nestedConfig);
  }

  if (isPluginConfigLike(cfg)) {
    return parsePluginConfig(cfg);
  }

  return { accounts: {} };
}

function resolveOpenClawStateDir(options?: {
  env?: Record<string, string | undefined>;
  homedir?: () => string;
}): string {
  const env = options?.env ?? process.env;
  const getHomeDirectory = options?.homedir ?? homedir;
  const explicitStateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (explicitStateDir) {
    return explicitStateDir;
  }

  const explicitHome = env.OPENCLAW_HOME?.trim();
  if (explicitHome) {
    return join(explicitHome, ".openclaw");
  }

  return join(getHomeDirectory(), ".openclaw");
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
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createDeferred<T>() {
  let settled = false;
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rejectPromise = (reason) => {
      if (settled) return;
      settled = true;
      reject(reason);
    };
  });

  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isPluginConfigLike(input: unknown): input is Parameters<typeof parsePluginConfig>[0] {
  return Boolean(input && typeof input === "object" && "accounts" in input);
}
