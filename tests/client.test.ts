import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(filePath).toMatch(/demo---[0-9a-f-]+\.mp4$/);

    await rm(openclawHome, { recursive: true, force: true });
  });

  it("stores downloaded attachments inside the OpenClaw media directory", async () => {
    const openclawHome = await mkdtemp(`${tmpdir()}/openclaw-home-`);
    const mediaDir = `${openclawHome}/media`;
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

    vi.stubGlobal("fetch", fetchMock);

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: {
        mode: "token",
        userId: "user-1",
        accessToken: "token-1"
      },
      mediaDir
    });

    const filePath = await client.downloadAttachmentToTempFile("/file-upload/demo.png", {
      fileName: "demo.png"
    });

    expect(filePath).toContain(`${mediaDir}/inbound/`);
    expect(filePath).not.toContain("rocketchat-attachment-");
    await expect(readFile(filePath, "utf8")).resolves.toBe("image-binary");

    await rm(openclawHome, { recursive: true, force: true });
  });

  it("uploads a local file attachment to Rocket.Chat", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rocketchat-upload-"));
    const filePath = join(tempDir, "result.zip");
    await writeFile(filePath, Buffer.from("demo"));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "success",
          data: {
            userId: "bot-1",
            authToken: "token-1",
            me: { username: "bot" }
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, file: { _id: "f-uploaded" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, message: { _id: "m-attachment" } }));

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: { mode: "password", username: "bot", password: "secret" },
      mediaDir: tempDir,
      fetch: fetchMock
    });

    const attachmentId = await client.uploadAttachment("room-1", filePath, "结果附件");

    expect(attachmentId).toBe("m-attachment");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://chat.example.com/api/v1/rooms.media/room-1",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://chat.example.com/api/v1/rooms.mediaConfirm/room-1/f-uploaded",
      expect.objectContaining({ method: "POST" })
    );

    await rm(tempDir, { recursive: true, force: true });
  });

  it("throws when uploading a missing local file", async () => {
    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: { mode: "token", userId: "bot-1", accessToken: "token-1" },
      mediaDir: "/tmp"
    });

    await expect(client.uploadAttachment("room-1", "/tmp/missing.zip")).rejects.toThrow();
  });

  it("throws RocketChatClientError when attachment upload fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rocketchat-upload-"));
    const filePath = join(tempDir, "result.zip");
    await writeFile(filePath, Buffer.from("demo"));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "success",
          data: {
            userId: "bot-1",
            authToken: "token-1",
            me: { username: "bot" }
          }
        })
      )
      .mockResolvedValueOnce(
        new Response("upload failed", { status: 500, statusText: "Internal Server Error" })
      );

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: { mode: "password", username: "bot", password: "secret" },
      mediaDir: tempDir,
      fetch: fetchMock
    });

    await expect(client.uploadAttachment("room-1", filePath)).rejects.toThrow(RocketChatClientError);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("throws RocketChatClientError when media confirm fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rocketchat-upload-"));
    const filePath = join(tempDir, "result.zip");
    await writeFile(filePath, Buffer.from("demo"));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "success",
          data: {
            userId: "bot-1",
            authToken: "token-1",
            me: { username: "bot" }
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, file: { _id: "f-only" } }))
      .mockResolvedValueOnce(
        new Response("confirm failed", { status: 500, statusText: "Internal Server Error" })
      );

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: { mode: "password", username: "bot", password: "secret" },
      mediaDir: tempDir,
      fetch: fetchMock
    });

    await expect(client.uploadAttachment("room-1", filePath)).rejects.toThrow(RocketChatClientError);

    await rm(tempDir, { recursive: true, force: true });
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
  // While Rocket.Chat restarts, Traefik answers with a plain-text 503
  // ("no available server"). Parsing that as JSON threw
  // `SyntaxError: Unexpected token 'o'` — an error nobody can act on, that
  // is not a RocketChatClientError, and that skipped the rate-limit branch
  // entirely. On 2026-08-27 it put all 13 bot channels into restart backoff.
  it("reports a non-JSON error body by status instead of failing to parse it", async () => {
    // A Response body can only be read once — hand out a fresh one per call.
    const fetchMock = vi.fn(async () => textResponse("no available server", 503));
    vi.stubGlobal("fetch", fetchMock);

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: { mode: "token", userId: "user-1", accessToken: "auth-1" }
    });

    const error = await client.initialize().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RocketChatClientError);
    expect((error as Error).message).toMatch(/503/);
    expect((error as Error).message).toMatch(/no available server/);
    // The raw parser error must not leak through.
    expect((error as Error).message).not.toMatch(/Unexpected token/);
  });

  it("still recognises a rate limit when the body is not JSON", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>Too Many Requests</html>", {
          status: 429,
          headers: { "Content-Type": "text/html", "Retry-After": "3" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: { mode: "token", userId: "user-1", accessToken: "auth-1" }
    });

    await expect(client.initialize()).rejects.toThrow(RocketChatRateLimitError);
  });

  it("reports an unparseable body on a 200 as a client error", async () => {
    // A reverse proxy that answers 200 with an HTML error page must not
    // surface as a raw SyntaxError either.
    const fetchMock = vi.fn(async () => textResponse("<html>oops</html>", 200, "text/html"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new RocketChatClient({
      serverUrl: "https://chat.example.com",
      auth: { mode: "token", userId: "user-1", accessToken: "auth-1" }
    });

    await expect(client.initialize()).rejects.toThrow(RocketChatClientError);
  });
});

function textResponse(body: string, status: number, contentType = "text/plain"): Response {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
