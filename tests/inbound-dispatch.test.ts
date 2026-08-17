import { describe, expect, it, vi } from "vitest";

import type { InboundEvent } from "../src/inbound/types.js";
import {
  applyAgentOverride,
  dispatchInboundEventWithChannelRuntime,
  rebuildSessionKeyForAgent
} from "../src/inbound-dispatch.js";

describe("dispatchInboundEventWithChannelRuntime", () => {
  it("records and dispatches direct messages through channelRuntime", async () => {
    const resolveAgentRoute = vi.fn().mockReturnValue({
      agentId: "main",
      sessionKey: "agent:main:session",
      accountId: "main"
    });
    const resolveStorePath = vi.fn().mockReturnValue("/tmp/openclaw/session-store");
    const readSessionUpdatedAt = vi.fn().mockReturnValue(undefined);
    const resolveEnvelopeFormatOptions = vi.fn().mockReturnValue({ format: "envelope" });
    const formatAgentEnvelope = vi.fn().mockReturnValue("[Rocket.Chat] 你好");
    const finalizeInboundContext = vi.fn((ctx) => ({
      ...ctx,
      SessionKey: ctx.SessionKey
    }));
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "收到" }, { kind: "final" });
      return { queuedFinal: true };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onRecordError = vi.fn();
    const onDispatchError = vi.fn();
    const cfg = {
      session: {
        store: "memory"
      }
    };
    const event: InboundEvent = {
      accountId: "main",
      roomId: "room-1",
      roomType: "direct",
      messageId: "message-1",
      tmid: null,
      senderId: "user-1",
      senderName: "Alice",
      text: "你好",
      mentions: [],
      attachments: [],
      sentAt: "2026-03-26T17:35:00.000Z",
      raw: { text: "你好" }
    };

    await dispatchInboundEventWithChannelRuntime({
      cfg,
      accountId: "main",
      event,
      channelRuntime: {
        routing: {
          resolveAgentRoute
        },
        session: {
          resolveStorePath,
          readSessionUpdatedAt,
          recordInboundSession
        },
        reply: {
          resolveEnvelopeFormatOptions,
          formatAgentEnvelope,
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher
        }
      },
      deliver,
      onRecordError,
      onDispatchError
    });

    expect(resolveAgentRoute).toHaveBeenCalledWith({
      cfg,
      channel: "rocketchat",
      accountId: "main",
      peer: {
        kind: "direct",
        id: "room-1"
      }
    });
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        InboundEventKind: "user_request"
      })
    );
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: {
          sourceReplyDeliveryMode: "automatic"
        }
      })
    );
    expect(deliver).toHaveBeenCalledWith({
      text: "收到"
    }, { kind: "final" });
    expect(onRecordError).not.toHaveBeenCalled();
    expect(onDispatchError).not.toHaveBeenCalled();
  });

  it("forwards tool, block, and final payloads to the deliver callback in order", async () => {
    const resolveAgentRoute = vi.fn().mockReturnValue({
      agentId: "main",
      sessionKey: "agent:main:session",
      accountId: "main"
    });
    const resolveStorePath = vi.fn().mockReturnValue("/tmp/openclaw/session-store");
    const readSessionUpdatedAt = vi.fn().mockReturnValue(undefined);
    const resolveEnvelopeFormatOptions = vi.fn().mockReturnValue({ format: "envelope" });
    const formatAgentEnvelope = vi.fn().mockReturnValue("[Rocket.Chat] 你好");
    const finalizeInboundContext = vi.fn((ctx) => ({
      ...ctx,
      SessionKey: ctx.SessionKey
    }));
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({}, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "中间结果" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "最终答案" }, { kind: "final" });
      return { queuedFinal: true };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onRecordError = vi.fn();
    const onDispatchError = vi.fn();
    const event: InboundEvent = {
      accountId: "main",
      roomId: "room-1",
      roomType: "direct",
      messageId: "message-1",
      tmid: null,
      senderId: "user-1",
      senderName: "Alice",
      text: "你好",
      mentions: [],
      attachments: [],
      sentAt: "2026-03-26T17:35:00.000Z",
      raw: { text: "你好" }
    };

    await dispatchInboundEventWithChannelRuntime({
      cfg: {
        session: {
          store: "memory"
        }
      },
      accountId: "main",
      event,
      channelRuntime: {
        routing: {
          resolveAgentRoute
        },
        session: {
          resolveStorePath,
          readSessionUpdatedAt,
          recordInboundSession
        },
        reply: {
          resolveEnvelopeFormatOptions,
          formatAgentEnvelope,
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher
        }
      },
      deliver,
      onRecordError,
      onDispatchError
    });

    expect(deliver).toHaveBeenNthCalledWith(1, {}, { kind: "tool" });
    expect(deliver).toHaveBeenNthCalledWith(2, { text: "中间结果" }, { kind: "block" });
    expect(deliver).toHaveBeenNthCalledWith(3, { text: "最终答案" }, { kind: "final" });
  });

  it("falls back to interactive text blocks when the final payload has no plain text", async () => {
    const resolveAgentRoute = vi.fn().mockReturnValue({
      agentId: "main",
      sessionKey: "agent:main:session",
      accountId: "main"
    });
    const resolveStorePath = vi.fn().mockReturnValue("/tmp/openclaw/session-store");
    const readSessionUpdatedAt = vi.fn().mockReturnValue(undefined);
    const resolveEnvelopeFormatOptions = vi.fn().mockReturnValue({ format: "envelope" });
    const formatAgentEnvelope = vi.fn().mockReturnValue("[Rocket.Chat] 你好");
    const finalizeInboundContext = vi.fn((ctx) => ({
      ...ctx,
      SessionKey: ctx.SessionKey
    }));
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({
        interactive: {
          blocks: [
            {
              type: "text",
              text: "最终答案"
            },
            {
              type: "buttons",
              buttons: [
                {
                  label: "确认",
                  value: "confirm"
                }
              ]
            }
          ]
        }
      }, { kind: "final" });
      return { queuedFinal: true };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onRecordError = vi.fn();
    const onDispatchError = vi.fn();
    const event: InboundEvent = {
      accountId: "main",
      roomId: "room-1",
      roomType: "direct",
      messageId: "message-1",
      tmid: null,
      senderId: "user-1",
      senderName: "Alice",
      text: "你好",
      mentions: [],
      attachments: [],
      sentAt: "2026-03-26T17:35:00.000Z",
      raw: { text: "你好" }
    };

    await dispatchInboundEventWithChannelRuntime({
      cfg: {
        session: {
          store: "memory"
        }
      },
      accountId: "main",
      event,
      channelRuntime: {
        routing: {
          resolveAgentRoute
        },
        session: {
          resolveStorePath,
          readSessionUpdatedAt,
          recordInboundSession
        },
        reply: {
          resolveEnvelopeFormatOptions,
          formatAgentEnvelope,
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher
        }
      },
      deliver,
      onRecordError,
      onDispatchError
    });

    expect(deliver).toHaveBeenCalledWith({
      text: "最终答案"
    }, { kind: "final" });
  });

  it("only warns when the runtime completes without any replies", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolveAgentRoute = vi.fn().mockReturnValue({
      agentId: "main",
      sessionKey: "agent:main:session",
      accountId: "main"
    });
    const resolveStorePath = vi.fn().mockReturnValue("/tmp/openclaw/session-store");
    const readSessionUpdatedAt = vi.fn().mockReturnValue(undefined);
    const resolveEnvelopeFormatOptions = vi.fn().mockReturnValue({ format: "envelope" });
    const formatAgentEnvelope = vi.fn().mockReturnValue("[Rocket.Chat] 你好");
    const finalizeInboundContext = vi.fn((ctx) => ({
      ...ctx,
      SessionKey: ctx.SessionKey
    }));
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({
      queuedFinal: false,
      counts: {
        tool: 0,
        block: 0,
        final: 0
      }
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const onRecordError = vi.fn();
    const onDispatchError = vi.fn();
    const event: InboundEvent = {
      accountId: "main",
      roomId: "room-1",
      roomType: "direct",
      messageId: "message-1",
      tmid: null,
      senderId: "user-1",
      senderName: "Alice",
      text: "你好",
      mentions: [],
      attachments: [],
      sentAt: "2026-03-26T17:35:00.000Z",
      raw: { text: "你好" }
    };

    await dispatchInboundEventWithChannelRuntime({
      cfg: {
        session: {
          store: "memory"
        }
      },
      accountId: "main",
      event,
      channelRuntime: {
        routing: {
          resolveAgentRoute
        },
        session: {
          resolveStorePath,
          readSessionUpdatedAt,
          recordInboundSession
        },
        reply: {
          resolveEnvelopeFormatOptions,
          formatAgentEnvelope,
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher
        }
      },
      deliver,
      onRecordError,
      onDispatchError
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[rocketchat:main] {"roomId":"room-1","messageId":"message-1","type":"reply-dispatch-empty","queuedFinal":false,"counts":{"tool":0,"block":0,"final":0}}'
    );

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("rewrites the resolved route when an agent override is supplied", async () => {
    const resolveAgentRoute = vi.fn().mockReturnValue({
      agentId: "main",
      sessionKey: "agent:main:rocketchat:channel:room-1",
      mainSessionKey: "agent:main:rocketchat:channel:room-1",
      accountId: "main"
    });
    const resolveStorePath = vi.fn().mockReturnValue("/tmp/openclaw/bettina-store");
    const readSessionUpdatedAt = vi.fn().mockReturnValue(undefined);
    const resolveEnvelopeFormatOptions = vi.fn().mockReturnValue({});
    const formatAgentEnvelope = vi.fn().mockReturnValue("[Rocket.Chat]");
    const finalizeInboundContext = vi.fn((ctx) => ({ ...ctx, SessionKey: ctx.SessionKey }));
    const recordInboundSession = vi.fn().mockResolvedValue(undefined);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "pong" }, { kind: "final" });
      return { queuedFinal: true };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const event: InboundEvent = {
      accountId: "bettina",
      roomId: "room-1",
      roomType: "channel",
      messageId: "m-1",
      tmid: null,
      senderId: "u-1",
      senderName: "Alice",
      text: "hi",
      mentions: [],
      attachments: [],
      sentAt: "2026-05-17T08:00:00.000Z",
      raw: {}
    };

    await dispatchInboundEventWithChannelRuntime({
      cfg: { session: { store: "memory" } },
      accountId: "bettina",
      event,
      agent: "bettina",
      channelRuntime: {
        routing: { resolveAgentRoute },
        session: { resolveStorePath, readSessionUpdatedAt, recordInboundSession },
        reply: {
          resolveEnvelopeFormatOptions,
          formatAgentEnvelope,
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher
        }
      },
      deliver,
      onRecordError: vi.fn(),
      onDispatchError: vi.fn()
    });

    expect(resolveStorePath).toHaveBeenCalledWith("memory", { agentId: "bettina" });
    expect(readSessionUpdatedAt).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw/bettina-store",
      sessionKey: "agent:bettina:rocketchat:channel:room-1"
    });
    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({ SessionKey: "agent:bettina:rocketchat:channel:room-1" })
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:bettina:rocketchat:channel:room-1",
        updateLastRoute: expect.objectContaining({
          sessionKey: "agent:bettina:rocketchat:channel:room-1"
        })
      })
    );
  });
});

describe("rebuildSessionKeyForAgent", () => {
  it("replaces the agent id segment in a standard session key", () => {
    expect(
      rebuildSessionKeyForAgent("agent:main:rocketchat:channel:room-1", "bettina")
    ).toBe("agent:bettina:rocketchat:channel:room-1");
  });

  it("returns the original key unchanged when the format is unexpected", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(rebuildSessionKeyForAgent("legacy-key", "bettina")).toBe("legacy-key");
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

describe("applyAgentOverride", () => {
  const baseRoute = {
    agentId: "main",
    sessionKey: "agent:main:rocketchat:channel:r",
    mainSessionKey: "agent:main:rocketchat:channel:r",
    accountId: "main"
  };

  it("returns the route unchanged when no override is supplied", () => {
    expect(applyAgentOverride(baseRoute, undefined)).toEqual(baseRoute);
  });

  it("returns the route unchanged when the override equals the resolved agent", () => {
    expect(applyAgentOverride(baseRoute, "main")).toEqual(baseRoute);
  });

  it("rewrites agentId and both session keys when override differs", () => {
    expect(applyAgentOverride(baseRoute, "bettina")).toEqual({
      agentId: "bettina",
      sessionKey: "agent:bettina:rocketchat:channel:r",
      mainSessionKey: "agent:bettina:rocketchat:channel:r",
      accountId: "main"
    });
  });
});
