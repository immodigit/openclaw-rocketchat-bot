import { describe, expect, it } from "vitest";

async function loadSubject() {
  return import("../src/inbound/attachments.js");
}

describe("normalizeInboundAttachments", () => {
  it("classifies image attachments as image", async () => {
    const { normalizeInboundAttachments } = await loadSubject();

    const attachments = normalizeInboundAttachments([
      {
        title: "photo.jpg",
        title_link: "https://chat.example.com/file-upload/photo.jpg",
        type: "image/jpeg"
      }
    ]);

    expect(attachments).toEqual([
      expect.objectContaining({
        kind: "image",
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        url: "https://chat.example.com/file-upload/photo.jpg"
      })
    ]);
  });

  it("classifies pdf, office, and text attachments as document", async () => {
    const { normalizeInboundAttachments } = await loadSubject();

    const attachments = normalizeInboundAttachments([
      {
        title: "report.pdf",
        title_link: "https://chat.example.com/file-upload/report.pdf",
        type: "application/pdf"
      },
      {
        title: "deck.pptx",
        title_link: "https://chat.example.com/file-upload/deck.pptx",
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      },
      {
        title: "notes.md",
        title_link: "https://chat.example.com/file-upload/notes.md",
        type: "text/markdown"
      }
    ]);

    expect(attachments).toEqual([
      expect.objectContaining({
        kind: "document",
        fileName: "report.pdf"
      }),
      expect.objectContaining({
        kind: "document",
        fileName: "deck.pptx"
      }),
      expect.objectContaining({
        kind: "document",
        fileName: "notes.md"
      })
    ]);
  });

  it("classifies voice notes and audio uploads as audio", async () => {
    const { normalizeInboundAttachments } = await loadSubject();

    const attachments = normalizeInboundAttachments([
      // typical Rocket.Chat mobile voice note: audio/webm MIME wins
      // over the .webm extension that would otherwise look like video
      {
        title: "audio-record.webm",
        title_link: "https://chat.example.com/file/audio-record.webm",
        type: "audio/webm"
      },
      // iOS voice memo / m4a
      {
        title: "voice-memo.m4a",
        title_link: "https://chat.example.com/file/voice-memo.m4a",
        type: "audio/mp4"
      },
      // plain mp3 upload with mime missing → extension-based fallback
      {
        title: "podcast-snippet.mp3",
        title_link: "https://chat.example.com/file/podcast-snippet.mp3"
      },
      // .opus extension typical for ogg-encapsulated voice notes
      {
        title: "voice-2026-05-18.opus",
        title_link: "https://chat.example.com/file/voice-2026-05-18.opus"
      }
    ]);

    expect(attachments).toEqual([
      expect.objectContaining({ kind: "audio", fileName: "audio-record.webm" }),
      expect.objectContaining({ kind: "audio", fileName: "voice-memo.m4a" }),
      expect.objectContaining({ kind: "audio", fileName: "podcast-snippet.mp3" }),
      expect.objectContaining({ kind: "audio", fileName: "voice-2026-05-18.opus" })
    ]);
  });

  it("classifies mp4, mov, and webm attachments as video", async () => {
    const { normalizeInboundAttachments } = await loadSubject();

    const attachments = normalizeInboundAttachments([
      {
        title: "demo.mp4",
        title_link: "https://chat.example.com/file/demo.mp4"
      },
      {
        title: "walkthrough.mov",
        title_link: "https://chat.example.com/file/walkthrough.mov"
      },
      {
        title: "capture.webm",
        title_link: "https://chat.example.com/file/capture.webm"
      }
    ]);

    expect(attachments).toEqual([
      expect.objectContaining({
        kind: "video",
        fileName: "demo.mp4"
      }),
      expect.objectContaining({
        kind: "video",
        fileName: "walkthrough.mov"
      }),
      expect.objectContaining({
        kind: "video",
        fileName: "capture.webm"
      })
    ]);
  });

  it("falls back to file extension when mime type is missing", async () => {
    const { normalizeInboundAttachments } = await loadSubject();

    const attachments = normalizeInboundAttachments([
      {
        title: "scanned-report.PDF",
        title_link: "https://chat.example.com/file/scanned-report.PDF"
      }
    ]);

    expect(attachments).toEqual([
      expect.objectContaining({
        kind: "document",
        fileName: "scanned-report.PDF",
        mimeType: undefined
      })
    ]);
  });

  it("returns unknown for unsupported payloads without throwing", async () => {
    const { normalizeInboundAttachments } = await loadSubject();

    expect(() =>
      normalizeInboundAttachments([
        {
          title: "archive.zip",
          title_link: "https://chat.example.com/file/archive.zip",
          type: "application/zip"
        },
        {
          description: "missing known attachment fields"
        }
      ])
    ).not.toThrow();

    expect(
      normalizeInboundAttachments([
        {
          title: "archive.zip",
          title_link: "https://chat.example.com/file/archive.zip",
          type: "application/zip"
        },
        {
          description: "missing known attachment fields"
        }
      ])
    ).toEqual([
      expect.objectContaining({
        kind: "unknown",
        fileName: "archive.zip"
      }),
      expect.objectContaining({
        kind: "unknown"
      })
    ]);
  });
});
