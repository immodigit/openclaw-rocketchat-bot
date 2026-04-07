import { describe, expect, it, vi } from "vitest";

import { RocketChatRateLimitError } from "../src/client.js";
import { RestPollingTransport } from "../src/inbound/polling.js";
import type { InboundEvent } from "../src/inbound/types.js";

describe("RestPollingTransport", () => {
  it("uses the stored checkpoint to narrow subscription and message sync requests", async () => {
    const events: InboundEvent[] = [];
    const checkpointStore = createCheckpointStore();
    const client = {
      listSubscriptions: vi.fn().mockResolvedValue([
        { rid: "dm-1", t: "d", _updatedAt: "2026-03-26T10:01:00.000Z" },
        { rid: "channel-1", t: "c", _updatedAt: "2026-03-26T10:02:00.000Z" }
      ]),
      syncMessages: vi
        .fn()
        .mockResolvedValueOnce([
          {
            _id: "m1",
            rid: "dm-1",
            msg: "hello",
            ts: "2026-03-26T10:01:30.000Z",
            u: { _id: "user-a", username: "alice", name: "Alice" },
            mentions: []
          }
        ])
        .mockResolvedValueOnce([
          {
            _id: "m2",
            rid: "channel-1",
            msg: "@rocketbot hi",
            ts: "2026-03-26T10:02:30.000Z",
            u: { _id: "user-b", username: "bob", name: "Bob" },
            mentions: [{ username: "rocketbot" }]
          }
        ])
    };

    const transport = new RestPollingTransport({
      accountId: "main",
      botUserId: "bot-user",
      client,
      checkpointStore,
      onEvent: async (event) => {
        events.push(event);
      }
    });

    await transport.pollOnce();

    expect(client.listSubscriptions).toHaveBeenCalledWith("2026-03-26T10:00:00.000Z");
    expect(client.syncMessages).toHaveBeenNthCalledWith(1, "dm-1", "2026-03-26T10:00:00.000Z");
    expect(client.syncMessages).toHaveBeenNthCalledWith(2, "channel-1", "2026-03-26T10:00:00.000Z");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      roomType: "direct",
      messageId: "m1",
      attachments: []
    });
    expect(events[1]).toMatchObject({
      roomType: "channel",
      mentions: ["rocketbot"],
      attachments: []
    });
    await expect(checkpointStore.read("main")).resolves.toEqual({
      updatedSince: "2026-03-26T10:02:30.000Z",
      recentMessageIds: ["m1", "m2"]
    });
  });

  it("filters duplicate, self-authored, and system messages", async () => {
    const events: InboundEvent[] = [];
    const checkpointStore = createCheckpointStore({
      updatedSince: "2026-03-26T10:00:00.000Z",
      recentMessageIds: ["dup-1"]
    });
    const client = {
      listSubscriptions: vi.fn().mockResolvedValue([{ rid: "room-1", t: "p" }]),
      syncMessages: vi.fn().mockResolvedValue([
        {
          _id: "dup-1",
          rid: "room-1",
          msg: "duplicate",
          ts: "2026-03-26T10:01:00.000Z",
          u: { _id: "user-a", username: "alice", name: "Alice" },
          mentions: []
        },
        {
          _id: "self-1",
          rid: "room-1",
          msg: "self",
          ts: "2026-03-26T10:02:00.000Z",
          u: { _id: "bot-user", username: "rocketbot", name: "Rocket Bot" },
          mentions: []
        },
        {
          _id: "system-1",
          rid: "room-1",
          msg: "",
          ts: "2026-03-26T10:03:00.000Z",
          t: "uj",
          u: { _id: "user-b", username: "bob", name: "Bob" },
          mentions: []
        },
        {
          _id: "ok-1",
          rid: "room-1",
          msg: "valid",
          ts: "2026-03-26T10:04:00.000Z",
          u: { _id: "user-c", username: "carol", name: "Carol" },
          mentions: [{ username: "rocketbot" }]
        }
      ])
    };

    const transport = new RestPollingTransport({
      accountId: "main",
      botUserId: "bot-user",
      client,
      checkpointStore,
      onEvent: async (event) => {
        events.push(event);
      }
    });

    await transport.pollOnce();

    expect(events).toHaveLength(1);
    expect(events[0]?.messageId).toBe("ok-1");
  });

  it("maps Rocket.Chat attachments into inbound events", async () => {
    const events: InboundEvent[] = [];
    const checkpointStore = createCheckpointStore();
    const client = {
      listSubscriptions: vi.fn().mockResolvedValue([{ rid: "room-1", t: "c" }]),
      syncMessages: vi.fn().mockResolvedValue([
        {
          _id: "m-attachment",
          rid: "room-1",
          msg: "see attachment",
          ts: "2026-03-26T10:01:00.000Z",
          u: { _id: "user-a", username: "alice", name: "Alice" },
          mentions: [],
          attachments: [
            {
              title: "diagram.png",
              title_link: "https://chat.example.com/file-upload/diagram.png",
              type: "image/png"
            }
          ]
        }
      ])
    };

    const transport = new RestPollingTransport({
      accountId: "main",
      botUserId: "bot-user",
      client,
      checkpointStore,
      onEvent: async (event) => {
        events.push(event);
      }
    });

    await transport.pollOnce();

    expect(events).toHaveLength(1);
    expect(events[0]?.attachments).toEqual([
      expect.objectContaining({
        kind: "image",
        fileName: "diagram.png",
        url: "https://chat.example.com/file-upload/diagram.png"
      })
    ]);
  });

  it("does not drop attachment-only messages and merges file metadata with attachment links", async () => {
    const events: InboundEvent[] = [];
    const checkpointStore = createCheckpointStore();
    const client = {
      listSubscriptions: vi.fn().mockResolvedValue([{ rid: "room-1", t: "c" }]),
      syncMessages: vi.fn().mockResolvedValue([
        {
          _id: "m-file-only",
          rid: "room-1",
          msg: "",
          ts: "2026-03-26T10:01:00.000Z",
          u: { _id: "user-a", username: "alice", name: "Alice" },
          mentions: [],
          attachments: [
            {
              title: "diagram.png",
              title_link: "/file-upload/diagram.png"
            }
          ],
          file: {
            _id: "file-1",
            name: "diagram.png",
            mimetype: "image/png"
          }
        }
      ])
    };

    const transport = new RestPollingTransport({
      accountId: "main",
      botUserId: "bot-user",
      client,
      checkpointStore,
      serverUrl: "https://chat.example.com",
      onEvent: async (event) => {
        events.push(event);
      }
    });

    await transport.pollOnce();

    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("");
    expect(events[0]?.attachments).toEqual([
      expect.objectContaining({
        source: "rocketchat-file",
        kind: "image",
        fileName: "diagram.png",
        mimeType: "image/png",
        url: "https://chat.example.com/file-upload/diagram.png"
      })
    ]);
  });

  it("does not advance the checkpoint when event handling fails", async () => {
    const checkpointStore = createCheckpointStore();
    const client = {
      listSubscriptions: vi.fn().mockResolvedValue([{ rid: "dm-1", t: "d" }]),
      syncMessages: vi.fn().mockResolvedValue([
        {
          _id: "m1",
          rid: "dm-1",
          msg: "hello",
          ts: "2026-03-26T10:01:30.000Z",
          u: { _id: "user-a", username: "alice", name: "Alice" },
          mentions: []
        }
      ])
    };

    const transport = new RestPollingTransport({
      accountId: "main",
      botUserId: "bot-user",
      client,
      checkpointStore,
      onEvent: async () => {
        throw new Error("boom");
      }
    });

    await expect(transport.pollOnce()).rejects.toThrow("boom");
    await expect(checkpointStore.read("main")).resolves.toEqual({
      updatedSince: "2026-03-26T10:00:00.000Z",
      recentMessageIds: []
    });
  });

  it("seeds the initial checkpoint when none exists", async () => {
    const checkpointStore = createCheckpointStore({
      updatedSince: null,
      recentMessageIds: []
    });
    const client = {
      listSubscriptions: vi.fn(),
      syncMessages: vi.fn()
    };

    const transport = new RestPollingTransport({
      accountId: "main",
      botUserId: "bot-user",
      client,
      checkpointStore,
      now: () => "2026-03-26T10:05:00.000Z",
      onEvent: async () => {
        throw new Error("should not be called");
      }
    });

    await transport.pollOnce();

    expect(client.listSubscriptions).not.toHaveBeenCalled();
    expect(client.syncMessages).not.toHaveBeenCalled();
    await expect(checkpointStore.read("main")).resolves.toEqual({
      updatedSince: "2026-03-26T10:05:00.000Z",
      recentMessageIds: []
    });
  });

  it("backs off instead of crashing when the api rate limits polling", async () => {
    let nowMs = 1_000;
    const onError = vi.fn();
    const checkpointStore = createCheckpointStore();
    const client = {
      listSubscriptions: vi
        .fn()
        .mockRejectedValue(
          new RocketChatRateLimitError("rate limited", {
            retryAfterMs: 35_000
          })
        ),
      syncMessages: vi.fn()
    };

    const transport = new RestPollingTransport({
      accountId: "main",
      botUserId: "bot-user",
      client,
      checkpointStore,
      onEvent: async () => {
        return undefined;
      },
      onError,
      nowMs: () => nowMs
    });

    await transport.safePollOnce();
    await transport.safePollOnce();
    nowMs = 40_000;
    await transport.safePollOnce();

    expect(client.listSubscriptions).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

function createCheckpointStore(initialState?: {
  updatedSince?: string | null;
  recentMessageIds?: string[];
}) {
  let state = {
    updatedSince:
      initialState && "updatedSince" in initialState
        ? (initialState.updatedSince ?? null)
        : "2026-03-26T10:00:00.000Z",
    recentMessageIds: initialState?.recentMessageIds ?? []
  };

  return {
    async read(_accountId: string) {
      return {
        updatedSince: state.updatedSince,
        recentMessageIds: [...state.recentMessageIds]
      };
    },
    async write(_accountId: string, nextState: typeof state) {
      state = {
        updatedSince: nextState.updatedSince,
        recentMessageIds: [...nextState.recentMessageIds]
      };
    },
    async hasSeen(_accountId: string, messageId: string) {
      return state.recentMessageIds.includes(messageId);
    },
    async markSeen(_accountId: string, messageId: string) {
      if (!state.recentMessageIds.includes(messageId)) {
        state.recentMessageIds = [...state.recentMessageIds, messageId];
      }
    }
  };
}
