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
