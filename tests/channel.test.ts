import { describe, expect, it, vi } from "vitest";

import { sendReplyLifecycle, shouldHandleInboundEvent } from "../src/channel.js";
import type { InboundEvent } from "../src/inbound/types.js";

describe("shouldHandleInboundEvent", () => {
  const baseEvent: InboundEvent = {
    accountId: "main",
    roomId: "room-1",
    roomType: "channel",
    messageId: "m1",
    tmid: null,
    senderId: "user-1",
    senderName: "alice",
    text: "hello",
    mentions: [],
    attachments: [],
    sentAt: "2026-03-26T11:00:00.000Z",
    raw: {}
  };

  it("accepts direct messages", () => {
    expect(
      shouldHandleInboundEvent(
        {
          ...baseEvent,
          roomType: "direct"
        },
        {
          botUserId: "bot-1",
          mentionNames: ["rocketbot"]
        }
      )
    ).toBe(true);
  });

  it("requires a mention in group contexts", () => {
    expect(
      shouldHandleInboundEvent(baseEvent, {
        botUserId: "bot-1",
        mentionNames: ["rocketbot"]
      })
    ).toBe(false);
  });

  it("accepts mention metadata and alias text fallback", () => {
    expect(
      shouldHandleInboundEvent(
        {
          ...baseEvent,
          roomType: "group",
          mentions: ["rocketbot"]
        },
        {
          botUserId: "bot-1",
          mentionNames: ["rocketbot"]
        }
      )
    ).toBe(true);

    expect(
      shouldHandleInboundEvent(
        {
          ...baseEvent,
          roomType: "group",
          text: "@assistant help"
        },
        {
          botUserId: "bot-1",
          mentionNames: ["rocketbot", "assistant"]
        }
      )
    ).toBe(true);
  });

  it("ignores self-authored messages", () => {
    expect(
      shouldHandleInboundEvent(
        {
          ...baseEvent,
          senderId: "bot-1",
          roomType: "direct"
        },
        {
          botUserId: "bot-1",
          mentionNames: ["rocketbot"]
        }
      )
    ).toBe(false);
  });
});

describe("sendReplyLifecycle", () => {
  it("posts one placeholder and updates the same message for tool, block, and final output", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "tool", payload: {} });
        await session.update({ kind: "block", payload: { text: "正在整理结果" } });
        await session.update({ kind: "final", payload: { text: "最终答案" } });
      }
    });

    expect(client.postMessage).toHaveBeenCalledTimes(1);
    expect(client.postMessage).toHaveBeenCalledWith("room-1", "⏳ Moment … (denke nach)", undefined);
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      1,
      "room-1",
      "placeholder-1",
      "🔧 Tool wird benutzt …"
    );
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      2,
      "room-1",
      "placeholder-1",
      "正在整理结果"
    );
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      3,
      "room-1",
      "placeholder-1",
      "最终答案"
    );
  });

  it("replaces the placeholder with an error note when execution fails after creation", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined)
    };

    await expect(
      sendReplyLifecycle({
        client,
        roomId: "room-1",
        run: async (session) => {
          await session.update({ kind: "tool", payload: {} });
          throw new Error("boom");
        }
      })
    ).rejects.toThrow("boom");

    expect(client.postMessage).toHaveBeenCalledTimes(1);
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      1,
      "room-1",
      "placeholder-1",
      "🔧 Tool wird benutzt …"
    );
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      2,
      "room-1",
      "placeholder-1",
      "❌ Etwas ist beim Antworten schiefgelaufen. Bitte nochmal mentionen."
    );
  });

  it("resolves the placeholder with an empty final fallback when run completes without a final update and the client cannot delete", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "tool", payload: {} });
      }
    });

    expect(client.postMessage).toHaveBeenCalledTimes(1);
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      1,
      "room-1",
      "placeholder-1",
      "🔧 Tool wird benutzt …"
    );
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      2,
      "room-1",
      "placeholder-1",
      "(no reply generated)"
    );
  });

  it("deletes the placeholder instead of leaving an empty-reply fallback when the client supports deleteMessage", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "tool", payload: {} });
      }
    });

    // Tool stage still updates the placeholder once with "🔧 Tool wird benutzt …"
    expect(client.updateMessage).toHaveBeenCalledTimes(1);
    expect(client.updateMessage).toHaveBeenCalledWith(
      "room-1",
      "placeholder-1",
      "🔧 Tool wird benutzt …"
    );
    // The empty-final stage deletes instead of leaving fallback text behind
    expect(client.deleteMessage).toHaveBeenCalledExactlyOnceWith(
      "room-1",
      "placeholder-1"
    );
  });

  it("falls back to updating the placeholder when deleteMessage throws", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockRejectedValue(new Error("forbidden"))
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "tool", payload: {} });
      }
    });

    expect(client.deleteMessage).toHaveBeenCalledTimes(1);
    // tool stage update + fallback update after delete fails
    expect(client.updateMessage).toHaveBeenCalledTimes(2);
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      2,
      "room-1",
      "placeholder-1",
      "(no reply generated)"
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("uploads a final attachment after updating the placeholder message", async () => {
    const postMessage = vi.fn().mockResolvedValue("placeholder-1");
    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const uploadAttachment = vi.fn().mockResolvedValue("attachment-1");

    await sendReplyLifecycle({
      client: {
        postMessage,
        updateMessage,
        uploadAttachment
      },
      roomId: "room-1",
      run: async (session) => {
        await session.update({
          kind: "final",
          payload: {
            text: "结果已生成",
            attachmentPath: "/tmp/result.zip"
          }
        });
      }
    });

    expect(updateMessage).toHaveBeenCalledWith("room-1", "placeholder-1", "结果已生成");
    expect(uploadAttachment).toHaveBeenCalledWith("room-1", "/tmp/result.zip", "结果已生成", undefined);
  });

  it("ignores attachmentPath on non-final stages", async () => {
    const uploadAttachment = vi.fn().mockResolvedValue("attachment-1");

    await sendReplyLifecycle({
      client: {
        postMessage: vi.fn().mockResolvedValue("placeholder-1"),
        updateMessage: vi.fn().mockResolvedValue(undefined),
        uploadAttachment
      },
      roomId: "room-1",
      run: async (session) => {
        await session.update({
          kind: "block",
          payload: {
            text: "处理中",
            attachmentPath: "/tmp/result.zip"
          }
        });
        await session.update({
          kind: "final",
          payload: {
            text: "完成"
          }
        });
      }
    });

    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it("propagates upload errors after final text update", async () => {
    const error = new Error("upload failed");
    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const uploadAttachment = vi.fn().mockRejectedValue(error);

    await expect(
      sendReplyLifecycle({
        client: {
          postMessage: vi.fn().mockResolvedValue("placeholder-1"),
          updateMessage,
          uploadAttachment
        },
        roomId: "room-1",
        run: async (session) => {
          await session.update({
            kind: "final",
            payload: {
              text: "最终结果",
              attachmentPath: "/tmp/result.zip"
            }
          });
        }
      })
    ).rejects.toThrow("upload failed");

    expect(updateMessage).toHaveBeenCalledWith("room-1", "placeholder-1", "最终结果");
  });

  it("updates the placeholder through watchdog stages when the agent stays silent", async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn().mockResolvedValue("placeholder-1");
    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const deleteMessage = vi.fn().mockResolvedValue(undefined);

    // Run the lifecycle with a `run` that never emits any update, then
    // resolves at the end. While `run` is pending, advance fake time so
    // the watchdog fires all three stages.
    const lifecycle = sendReplyLifecycle({
      client: { postMessage, updateMessage, deleteMessage },
      roomId: "room-1",
      run: () =>
        new Promise<void>((resolve) => {
          // Resolve once we've advanced past the terminal stage.
          setTimeout(resolve, 16 * 60 * 1000);
        })
    });

    // Allow the placeholder postMessage to land.
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage).toHaveBeenCalledTimes(1);

    // First watchdog tick after 60s elapsed: stage 1.
    await vi.advanceTimersByTimeAsync(60_000);
    // Second after 5m elapsed: stage 2.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    // Third after 15m elapsed: stage 3 (terminal).
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    // Now let the lifecycle's `run` resolve so the lifecycle finishes.
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await lifecycle;

    const watchdogCalls = updateMessage.mock.calls
      .map(([, , text]) => text as string)
      .filter((t) => t.includes("Bin dran") || t.includes("Dauert länger") || t.includes("Keine Antwort"));

    expect(watchdogCalls).toEqual([
      "⏳ Bin dran … (1m+)",
      "🤔 Dauert länger als üblich (5m+)",
      "❌ Keine Antwort. Bitte @-noch-mal-mentionen."
    ]);

    vi.useRealTimers();
  });

  it("stops the watchdog as soon as the agent emits its first real update", async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn().mockResolvedValue("placeholder-1");
    const updateMessage = vi.fn().mockResolvedValue(undefined);

    const lifecycle = sendReplyLifecycle({
      client: { postMessage, updateMessage },
      roomId: "room-1",
      run: async (session) => {
        // Agent emits a tool update 30s in — before the first watchdog
        // stage would fire (60s).
        await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
        await session.update({ kind: "tool", payload: {} });
        await session.update({ kind: "final", payload: { text: "fertig" } });
      }
    });

    // Advance to 30s — agent's tool update lands.
    await vi.advanceTimersByTimeAsync(30_000);
    // Now jump way past all watchdog stages.
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    await lifecycle;

    // No watchdog text should have been written — only the tool fallback
    // and the final.
    const watchdogCalls = updateMessage.mock.calls
      .map(([, , text]) => text as string)
      .filter((t) => t.includes("Bin dran") || t.includes("Dauert länger") || t.includes("Keine Antwort"));

    expect(watchdogCalls).toEqual([]);
    vi.useRealTimers();
  });
});
