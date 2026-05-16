import { describe, expect, it, vi } from "vitest";

import type { InboundEvent } from "../src/inbound/types.js";
import { dispatchInboundEventWithChannelRuntime } from "../src/inbound-dispatch.js";

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
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
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
});
