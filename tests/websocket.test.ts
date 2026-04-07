import { describe, expect, it, vi } from "vitest";

import { createWebSocketTransport } from "../src/inbound/websocket.js";
import type { InboundEvent } from "../src/inbound/types.js";

describe("createWebSocketTransport", () => {
  it("connects, logs in, subscribes rooms, and emits inbound events", async () => {
    const events: InboundEvent[] = [];
    const socket = new FakeWebSocket();
    const client = {
      listSubscriptions: vi.fn().mockResolvedValue([{ rid: "room-1", t: "d" }])
    };
    const checkpointStore = createCheckpointStore();

    const transport = createWebSocketTransport({
      accountId: "main",
      botUserId: "bot-user",
      serverUrl: "https://chat.example.com",
      userId: "bot-user",
      authToken: "resume-token",
      client,
      checkpointStore,
      onEvent: async (event) => {
        events.push(event);
      },
      websocketFactory: () => socket
    });

    const startPromise = transport.start();

    socket.emitOpen();
    socket.emitMessage({ msg: "connected", session: "session-1" });
    socket.emitMessage({
      msg: "result",
      id: "login",
      result: {
        id: "bot-user",
        token: "resume-token",
        type: "resume"
      }
    });

    await startPromise;

    expect(socket.sentFrames).toContainEqual({
      msg: "connect",
      version: "1",
      support: ["1"]
    });
    expect(socket.sentFrames).toContainEqual({
      msg: "method",
      method: "login",
      id: "login",
      params: [{ resume: "resume-token" }]
    });
    expect(socket.sentFrames).toContainEqual({
      msg: "sub",
      id: "sub:room:room-1",
      name: "stream-room-messages",
      params: ["room-1", false]
    });
    expect(socket.sentFrames).toContainEqual({
      msg: "sub",
      id: "sub:user:subscriptions-changed",
      name: "stream-notify-user",
      params: ["bot-user/subscriptions-changed", false]
    });
    expect(socket.sentFrames).toContainEqual({
      msg: "sub",
      id: "sub:user:rooms-changed",
      name: "stream-notify-user",
      params: ["bot-user/rooms-changed", false]
    });

    socket.emitMessage({
      msg: "changed",
      collection: "stream-room-messages",
      fields: {
        eventName: "room-1",
        args: [
          {
            _id: "m-1",
            rid: "room-1",
            msg: "hello",
            ts: "2026-03-26T08:40:00.000Z",
            u: {
              _id: "user-1",
              username: "alice",
              name: "Alice"
            },
            mentions: [{ username: "ai" }]
          }
        ]
      }
    });

    await flushAsync();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      roomType: "direct",
      messageId: "m-1",
      roomId: "room-1",
      senderId: "user-1",
      mentions: ["ai"],
      attachments: []
    });
  });

  it("maps websocket file metadata into inbound attachments", async () => {
    const events: InboundEvent[] = [];
    const socket = new FakeWebSocket();
    const client = {
      listSubscriptions: vi.fn().mockResolvedValue([{ rid: "room-9", t: "c" }])
    };
    const checkpointStore = createCheckpointStore();

    const transport = createWebSocketTransport({
      accountId: "main",
      botUserId: "bot-user",
      serverUrl: "https://chat.example.com",
      userId: "bot-user",
      authToken: "resume-token",
      client,
      checkpointStore,
      onEvent: async (event) => {
        events.push(event);
      },
      websocketFactory: () => socket
    });

    const startPromise = transport.start();

    socket.emitOpen();
    socket.emitMessage({ msg: "connected", session: "session-1" });
    socket.emitMessage({
      msg: "result",
      id: "login",
      result: {
        id: "bot-user",
        token: "resume-token",
        type: "resume"
      }
    });

    await startPromise;

    socket.emitMessage({
      msg: "changed",
      collection: "stream-room-messages",
      fields: {
        eventName: "room-9",
        args: [
          {
            _id: "m-file",
            rid: "room-9",
            msg: "watch this",
            ts: "2026-03-26T08:41:00.000Z",
            u: {
              _id: "user-2",
              username: "bob",
              name: "Bob"
            },
            mentions: [],
            file: {
              _id: "file-1",
              name: "demo.mp4",
              url: "https://chat.example.com/file-upload/demo.mp4",
              mimetype: "video/mp4"
            }
          }
        ]
      }
    });

    await flushAsync();

    expect(events).toHaveLength(1);
    expect(events[0]?.attachments).toEqual([
      expect.objectContaining({
        kind: "video",
        fileName: "demo.mp4",
        url: "https://chat.example.com/file-upload/demo.mp4"
      })
    ]);
  });

  it("refreshes room subscriptions when the user room list changes", async () => {
    const socket = new FakeWebSocket();
    const client = {
      listSubscriptions: vi
        .fn()
        .mockResolvedValueOnce([{ rid: "room-1", t: "d" }])
        .mockResolvedValueOnce([
          { rid: "room-1", t: "d" },
          { rid: "room-2", t: "c" }
        ])
    };
    const transport = createWebSocketTransport({
      accountId: "main",
      botUserId: "bot-user",
      serverUrl: "https://chat.example.com",
      userId: "bot-user",
      authToken: "resume-token",
      client,
      checkpointStore: createCheckpointStore(),
      onEvent: async () => {
        return undefined;
      },
      websocketFactory: () => socket
    });

    const startPromise = transport.start();

    socket.emitOpen();
    socket.emitMessage({ msg: "connected", session: "session-1" });
    socket.emitMessage({
      msg: "result",
      id: "login",
      result: {
        id: "bot-user",
        token: "resume-token",
        type: "resume"
      }
    });

    await startPromise;

    socket.emitMessage({
      msg: "changed",
      collection: "stream-notify-user",
      fields: {
        eventName: "bot-user/subscriptions-changed",
        args: [["updated", { rid: "room-2" }]]
      }
    });

    await flushAsync();

    expect(client.listSubscriptions).toHaveBeenCalledTimes(2);
    expect(
      socket.sentFrames.some(
        (frame) =>
          frame.msg === "sub" &&
          frame.id === "sub:room:room-2" &&
          frame.name === "stream-room-messages"
      )
    ).toBe(true);
    expect(
      socket.sentFrames.filter(
        (frame) => frame.msg === "sub" && frame.id === "sub:room:room-1"
      )
    ).toHaveLength(1);
  });
});

type Frame = Record<string, unknown>;

class FakeWebSocket {
  sentFrames: Frame[] = [];
  private readonly listeners: Record<string, Array<(event?: unknown) => void>> = {};

  addEventListener(type: string, listener: (event?: unknown) => void) {
    this.listeners[type] ??= [];
    this.listeners[type].push(listener);
  }

  send(payload: string) {
    this.sentFrames.push(JSON.parse(payload) as Frame);
  }

  close() {
    return undefined;
  }

  emitOpen() {
    this.emit("open");
  }

  emitMessage(payload: unknown) {
    this.emit("message", {
      data: JSON.stringify(payload)
    });
  }

  private emit(type: string, event?: unknown) {
    for (const listener of this.listeners[type] ?? []) {
      listener(event);
    }
  }
}

function createCheckpointStore() {
  const seen = new Set<string>();

  return {
    async hasSeen(_accountId: string, messageId: string) {
      return seen.has(messageId);
    },
    async markSeen(_accountId: string, messageId: string) {
      seen.add(messageId);
    }
  };
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
