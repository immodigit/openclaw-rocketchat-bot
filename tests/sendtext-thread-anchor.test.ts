import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture postMessage so we can assert which thread (tmid) the outbound send
// was anchored to. resolveRoomId lets the send map a channel name/slug back to
// the canonical roomId (the key the inbound anchor is stored under).
const mockInitialize = vi.fn();
const mockPostMessage = vi.fn();
const mockResolveRoomId = vi.fn();

vi.mock("../src/client.js", () => ({
  RocketChatClient: vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    postMessage: mockPostMessage,
    resolveRoomId: mockResolveRoomId
  }))
}));

import { rocketchatPlugin } from "../src/plugin.js";
import { clearInboundAnchor, recordInboundAnchor } from "../src/inbound-state.js";

const ROOM_ID = "6a08bebec0b42afff8db3bdf"; // internal Rocket.Chat room id
const ROOM_NAME = "buchhaltung"; // what an agent often types as the target
const THREAD_ID = "DeWiDEYjBwqGwkrAB"; // thread the conversation was triggered in

const cfg = {
  meta: { envFilePath: "/home/tester/.openclaw/.env" },
  channels: {
    rocketchat: {
      accounts: {
        main: {
          enabled: true,
          serverUrl: "https://chat.example.com",
          auth: { mode: "token", userId: "bot-1", accessToken: "tok-1" }
        }
      }
    }
  }
};

beforeEach(() => {
  mockInitialize.mockReset().mockResolvedValue({ userId: "bot-1", username: "bettina" });
  mockPostMessage.mockReset().mockResolvedValue("new-msg-id");
  // Default: the client resolves a name to the canonical roomId, ids pass through.
  mockResolveRoomId.mockReset().mockImplementation(async (target: string) =>
    target === ROOM_NAME ? ROOM_ID : target
  );
  clearInboundAnchor(ROOM_ID);
  clearInboundAnchor(ROOM_NAME);
});

describe("sendText thread anchoring", () => {
  it("threads a tool-send to the triggering thread when targeted by roomId", async () => {
    recordInboundAnchor(ROOM_ID, { messageId: "trigger-1", tmid: THREAD_ID });

    await rocketchatPlugin.outbound.sendText({
      cfg,
      accountId: "main",
      to: ROOM_ID,
      text: "done"
    });

    const call = mockPostMessage.mock.calls.at(-1);
    expect(call?.[2]).toEqual({ tmid: THREAD_ID });
  });

  it("threads a tool-send even when the agent targets the channel by name", async () => {
    // Inbound anchor is stored under the internal roomId (that's all onEvent knows).
    recordInboundAnchor(ROOM_ID, { messageId: "trigger-1", tmid: THREAD_ID });

    // Agent posts its final answer addressing the channel by name, not the roomId.
    await rocketchatPlugin.outbound.sendText({
      cfg,
      accountId: "main",
      to: ROOM_NAME,
      text: "done"
    });

    // Desired: the reply still lands in the thread it was triggered from,
    // not detached at the channel root.
    const call = mockPostMessage.mock.calls.at(-1);
    expect(call?.[2]).toEqual({ tmid: THREAD_ID });
  });
});
