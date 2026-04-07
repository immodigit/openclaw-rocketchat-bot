import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { InboundAttachment } from "../src/inbound/attachments.js";
import type { InboundEvent } from "../src/inbound/types.js";
import { dispatchInboundEventWithChannelRuntime } from "../src/inbound-dispatch.js";

describe("dispatchInboundEventWithChannelRuntime attachments", () => {
  it("forwards public attachment urls into media context", async () => {
    const harness = createDispatchHarness({
      attachments: [
        {
          kind: "document",
          mimeType: "application/pdf",
          fileName: "report.pdf",
          url: "https://chat.example.com/public/report.pdf",
          source: "rocketchat-attachment",
          raw: {}
        }
      ]
    });

    await harness.dispatch();

    expect(harness.downloadAttachmentToTempFile).not.toHaveBeenCalled();
    expect(harness.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        MediaUrl: "https://chat.example.com/public/report.pdf",
        MediaUrls: ["https://chat.example.com/public/report.pdf"],
        MediaType: "application/pdf",
        MediaTypes: ["application/pdf"]
      })
    );
  });

  it("downloads protected Rocket.Chat files and forwards local media paths", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rocketchat-dispatch-test-"));
    const tempPath = join(tempDir, "clip.mp4");
    await writeFile(tempPath, "video");

    const harness = createDispatchHarness({
      attachments: [
        {
          kind: "video",
          mimeType: "video/mp4",
          fileName: "clip.mp4",
          url: "https://chat.example.com/file-upload/clip.mp4",
          source: "rocketchat-file",
          raw: {}
        }
      ],
      downloadAttachmentToTempFile: vi.fn().mockResolvedValue(tempPath)
    });

    try {
      await harness.dispatch();

      expect(harness.downloadAttachmentToTempFile).toHaveBeenCalledWith(
        "https://chat.example.com/file-upload/clip.mp4",
        {
          fileName: "clip.mp4"
        }
      );
      expect(harness.finalizeInboundContext).toHaveBeenCalledWith(
        expect.objectContaining({
          MediaPath: tempPath,
          MediaPaths: [tempPath],
          MediaType: "video/mp4",
          MediaTypes: ["video/mp4"]
        })
      );
      await expect(access(tempPath)).resolves.toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("logs attachment routing details for observable debugging", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const tempDir = await mkdtemp(join(tmpdir(), "rocketchat-dispatch-test-"));
    const tempPath = join(tempDir, "report.pdf");
    await writeFile(tempPath, "pdf");

    const harness = createDispatchHarness({
      attachments: [
        {
          kind: "document",
          mimeType: "application/pdf",
          fileName: "public-report.pdf",
          url: "https://chat.example.com/public/report.pdf",
          source: "rocketchat-attachment",
          raw: {}
        },
        {
          kind: "document",
          mimeType: "application/pdf",
          fileName: "private-report.pdf",
          url: "https://chat.example.com/file-upload/private-report.pdf",
          source: "rocketchat-file",
          raw: {}
        }
      ],
      downloadAttachmentToTempFile: vi.fn().mockResolvedValue(tempPath)
    });

    try {
      await harness.dispatch();

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"type":"attachment-summary"')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"type":"attachment-materialized"')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"type":"attachment-media-context"')
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("does not block plain text dispatch when attachment download fails", async () => {
    const harness = createDispatchHarness({
      attachments: [
        {
          kind: "document",
          mimeType: "application/pdf",
          fileName: "report.pdf",
          url: "https://chat.example.com/public/report.pdf",
          source: "rocketchat-attachment",
          raw: {}
        },
        {
          kind: "video",
          mimeType: "video/mp4",
          fileName: "clip.mp4",
          url: "https://chat.example.com/file-upload/clip.mp4",
          source: "rocketchat-file",
          raw: {}
        }
      ],
      downloadAttachmentToTempFile: vi.fn().mockRejectedValue(new Error("download failed"))
    });

    await expect(harness.dispatch()).resolves.toBeUndefined();

    expect(harness.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "你好",
        MediaUrl: "https://chat.example.com/public/report.pdf",
        MediaUrls: ["https://chat.example.com/public/report.pdf"],
        MediaType: "application/pdf",
        MediaTypes: ["application/pdf"]
      })
    );
    expect(harness.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(harness.deliver).toHaveBeenCalledWith({
      text: "收到"
    }, { kind: "final" });
  });

  it("warns when protected attachment download fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = createDispatchHarness({
      attachments: [
        {
          kind: "video",
          mimeType: "video/mp4",
          fileName: "clip.mp4",
          url: "https://chat.example.com/file-upload/clip.mp4",
          source: "rocketchat-file",
          raw: {}
        }
      ],
      downloadAttachmentToTempFile: vi.fn().mockRejectedValue(new Error("download failed"))
    });

    try {
      await harness.dispatch();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"type":"attachment-download-failed"')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

function createDispatchHarness(params?: {
  attachments?: InboundAttachment[];
  downloadAttachmentToTempFile?: ReturnType<typeof vi.fn>;
}) {
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
  const downloadAttachmentToTempFile =
    params?.downloadAttachmentToTempFile ?? vi.fn().mockResolvedValue("/tmp/downloaded-attachment");
  const event: InboundEvent = {
    accountId: "main",
    roomId: "room-1",
    roomType: "direct",
    messageId: "message-1",
    senderId: "user-1",
    senderName: "Alice",
    text: "你好",
    mentions: [],
    attachments: params?.attachments ?? [],
    sentAt: "2026-03-26T17:35:00.000Z",
    raw: { text: "你好" }
  };

  return {
    finalizeInboundContext,
    dispatchReplyWithBufferedBlockDispatcher,
    deliver,
    downloadAttachmentToTempFile,
    dispatch: () =>
      dispatchInboundEventWithChannelRuntime({
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
        attachmentClient: {
          downloadAttachmentToTempFile
        },
        deliver,
        onRecordError,
        onDispatchError
      })
  };
}
