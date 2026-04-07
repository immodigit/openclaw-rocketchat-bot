import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RocketChatClient,
  RocketChatClientError,
  RocketChatRateLimitError
} from "../src/client.js";
import type { RocketChatMessageRecord } from "../src/client.js";

describe("RocketChatClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("logs in with username and password", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "success",
          data: {
            authToken: "auth-1",
            userId: "user-1",
            me: {
              username: "rocketbot",
              name: "Rocket Bot"
            }
          }
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: {
        mode: "password",
        username: "rocketbot",
        password: "secret"
      }
    });

    await expect(client.initialize()).resolves.toEqual({
      userId: "user-1",
      authToken: "auth-1",
      username: "rocketbot",
      displayName: "Rocket Bot"
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://chat.example.com/api/v1/login");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST"
    });
  });

  it("verifies token auth with profile lookup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        user: {
          _id: "user-1",
          username: "rocketbot",
          name: "Rocket Bot"
        }
      })
    );

    vi.stubGlobal("fetch", fetchMock);

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: {
        mode: "token",
        userId: "user-1",
        accessToken: "token-1"
      }
    });

    await expect(client.initialize()).resolves.toEqual({
      userId: "user-1",
      authToken: "token-1",
      username: "rocketbot",
      displayName: "Rocket Bot"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chat.example.com/api/v1/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Auth-Token": "token-1",
          "X-User-Id": "user-1"
        })
      })
    );
  });

  it("attaches auth headers to authenticated requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          user: {
            _id: "user-1",
            username: "rocketbot",
            name: "Rocket Bot"
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          update: []
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: {
        mode: "token",
        userId: "user-1",
        accessToken: "token-1"
      }
    });

    await client.initialize();
    await client.listSubscriptions(null);

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://chat.example.com/api/v1/subscriptions.get",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Auth-Token": "token-1",
          "X-User-Id": "user-1"
        })
      })
    );
  });

  it("uses lastUpdate for syncMessages and returns updated messages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          user: {
            _id: "user-1",
            username: "rocketbot",
            name: "Rocket Bot"
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          result: {
            updated: [
              {
                _id: "m1",
                rid: "room-1",
                msg: "hello"
              }
            ],
            deleted: []
          }
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: {
        mode: "token",
        userId: "user-1",
        accessToken: "token-1"
      }
    });

    await client.initialize();
    await expect(client.syncMessages("room-1", "2026-03-26T10:00:00.000Z")).resolves.toEqual([
      {
        _id: "m1",
        rid: "room-1",
        msg: "hello"
      }
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://chat.example.com/api/v1/chat.syncMessages?roomId=room-1&lastUpdate=2026-03-26T10%3A00%3A00.000Z",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Auth-Token": "token-1",
          "X-User-Id": "user-1"
        })
      })
    );
  });

  it("accepts message attachment payload metadata", () => {
    const message: RocketChatMessageRecord = {
      _id: "m-attachment",
      rid: "room-1",
      msg: "Please review the attached files.",
      attachments: [
        {
          title: "report.pdf",
          title_link: "https://chat.example.com/file-upload/report.pdf",
          type: "application/pdf"
        }
      ],
      file: {
        _id: "file-1",
        name: "report.pdf",
        type: "application/pdf"
      },
      files: [
        {
          _id: "file-2",
          name: "clip.mp4",
          mimetype: "video/mp4"
        }
      ]
    };

    expect(message.attachments?.[0]).toMatchObject({
      title: "report.pdf",
      type: "application/pdf"
    });
    expect(message.file?.name).toBe("report.pdf");
    expect(message.files?.[0]?.mimetype).toBe("video/mp4");
  });

  it("resolves relative attachment urls against the Rocket.Chat server", async () => {
    const openclawHome = await mkdtemp(`${tmpdir()}/openclaw-home-`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          user: {
            _id: "user-1",
            username: "rocketbot",
            name: "Rocket Bot"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response("video-binary", {
          status: 200
        })
      );

    vi.stubEnv("OPENCLAW_HOME", openclawHome);
    vi.stubGlobal("fetch", fetchMock);

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: {
        mode: "token",
        userId: "user-1",
        accessToken: "token-1"
      }
    });

    const filePath = await client.downloadAttachmentToTempFile("/file-upload/demo.mp4", {
      fileName: "demo.mp4"
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://chat.example.com/file-upload/demo.mp4",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-Auth-Token": "token-1",
          "X-User-Id": "user-1"
        })
      })
    );
    expect(filePath).toMatch(/demo\.mp4$/);

    await rm(openclawHome, { recursive: true, force: true });
  });

  it("stores downloaded attachments inside the OpenClaw media directory", async () => {
    const openclawHome = await mkdtemp(`${tmpdir()}/openclaw-home-`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          user: {
            _id: "user-1",
            username: "rocketbot",
            name: "Rocket Bot"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response("image-binary", {
          status: 200
        })
      );

    vi.stubEnv("OPENCLAW_HOME", openclawHome);
    vi.stubGlobal("fetch", fetchMock);

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: {
        mode: "token",
        userId: "user-1",
        accessToken: "token-1"
      }
    });

    const filePath = await client.downloadAttachmentToTempFile("/file-upload/demo.png", {
      fileName: "demo.png"
    });

    expect(filePath).toContain(`${openclawHome}/media/rocketchat-attachment-`);

    await rm(openclawHome, { recursive: true, force: true });
  });

  it("normalizes api failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            success: false,
            error: "Unauthorized"
          })
        )
      )
    );

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: {
        mode: "token",
        userId: "user-1",
        accessToken: "token-1"
      }
    });

    await expect(client.initialize()).rejects.toBeInstanceOf(RocketChatClientError);
    await expect(client.initialize()).rejects.toThrow("Unauthorized");
  });

  it("converts 429 responses into rate limit errors with retry hints", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              success: false,
              error:
                "Error, too many requests. Please slow down. You must wait 35 seconds before trying this endpoint again. [error-too-many-requests]"
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "35"
              }
            }
          )
        )
      )
    );

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: {
        mode: "token",
        userId: "user-1",
        accessToken: "token-1"
      }
    });

    await expect(client.initialize()).rejects.toBeInstanceOf(RocketChatRateLimitError);
    await expect(client.initialize()).rejects.toMatchObject({
      retryAfterMs: 35000
    });
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
