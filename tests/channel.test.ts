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
    expect(client.postMessage).toHaveBeenCalledWith("room-1", "思考中...", undefined);
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      1,
      "room-1",
      "placeholder-1",
      "正在调用工具..."
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
      "正在调用工具..."
    );
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      2,
      "room-1",
      "placeholder-1",
      "处理失败，请稍后重试。"
    );
  });

  it("resolves the placeholder with an empty final fallback when run completes without a final update", async () => {
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
      "正在调用工具..."
    );
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      2,
      "room-1",
      "placeholder-1",
      "未生成可发送的回复。"
    );
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
});
