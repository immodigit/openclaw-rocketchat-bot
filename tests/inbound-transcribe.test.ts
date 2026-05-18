import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadSubject() {
  return import("../src/inbound/transcribe.js");
}

type Attachment = {
  kind: "audio" | "image" | "video" | "document" | "unknown";
  url?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  source: "rocketchat-file" | "rocketchat-attachment";
  raw: unknown;
};

const ANY_AUDIO: Attachment = {
  kind: "audio",
  url: "https://chat.example.com/file/voice.webm",
  fileName: "voice.webm",
  mimeType: "audio/webm",
  source: "rocketchat-file",
  raw: {}
};

describe("transcribeConfigFromEnv", () => {
  it("returns null when no API key is provided", async () => {
    const { transcribeConfigFromEnv } = await loadSubject();
    expect(transcribeConfigFromEnv({})).toBeNull();
  });

  it("prefers OPENCLAW_TRANSCRIBE_API_KEY over OPENAI_API_KEY", async () => {
    const { transcribeConfigFromEnv } = await loadSubject();
    const cfg = transcribeConfigFromEnv({
      OPENAI_API_KEY: "sk-from-openai",
      OPENCLAW_TRANSCRIBE_API_KEY: "sk-from-openclaw"
    });
    expect(cfg?.apiKey).toBe("sk-from-openclaw");
  });

  it("defaults endpoint, model, and timeout", async () => {
    const { transcribeConfigFromEnv } = await loadSubject();
    const cfg = transcribeConfigFromEnv({ OPENAI_API_KEY: "sk-test" });
    expect(cfg).toEqual({
      apiKey: "sk-test",
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      model: "whisper-1",
      language: undefined,
      timeoutMs: 20_000
    });
  });

  it("honours overrides for endpoint, model, language, and timeout", async () => {
    const { transcribeConfigFromEnv } = await loadSubject();
    const cfg = transcribeConfigFromEnv({
      OPENAI_API_KEY: "sk-test",
      OPENCLAW_TRANSCRIBE_ENDPOINT: "http://whisper-local:9000/v1/audio/transcriptions",
      OPENCLAW_TRANSCRIBE_MODEL: "whisper-large-v3",
      OPENCLAW_TRANSCRIBE_LANGUAGE: "de",
      OPENCLAW_TRANSCRIBE_TIMEOUT_MS: "45000"
    });
    expect(cfg).toEqual({
      apiKey: "sk-test",
      endpoint: "http://whisper-local:9000/v1/audio/transcriptions",
      model: "whisper-large-v3",
      language: "de",
      timeoutMs: 45_000
    });
  });
});

describe("mergeTranscriptionsIntoText", () => {
  it("returns the original text unchanged when there are no usable transcripts", async () => {
    const { mergeTranscriptionsIntoText } = await loadSubject();
    expect(mergeTranscriptionsIntoText("hi there", [])).toBe("hi there");
    expect(
      mergeTranscriptionsIntoText("hi", [
        { attachment: ANY_AUDIO, text: null, durationMs: 1, error: "boom" }
      ])
    ).toBe("hi");
  });

  it("appends a single transcript inline when original text exists", async () => {
    const { mergeTranscriptionsIntoText } = await loadSubject();
    const merged = mergeTranscriptionsIntoText("Schau mal hier", [
      { attachment: ANY_AUDIO, text: "@andi check bitte den Bug", durationMs: 1 }
    ]);
    expect(merged).toBe(
      "Schau mal hier\n[Sprachnachricht-Transkription]: @andi check bitte den Bug"
    );
  });

  it("replaces empty text with the transcript block (so the mention filter sees the @-mention)", async () => {
    const { mergeTranscriptionsIntoText } = await loadSubject();
    const merged = mergeTranscriptionsIntoText("", [
      { attachment: ANY_AUDIO, text: "Hey @andi, leg bitte ein Issue an.", durationMs: 1 }
    ]);
    expect(merged).toBe(
      "[Sprachnachricht-Transkription]: Hey @andi, leg bitte ein Issue an."
    );
  });

  it("numbers blocks when several audio attachments were transcribed", async () => {
    const { mergeTranscriptionsIntoText } = await loadSubject();
    const merged = mergeTranscriptionsIntoText("Zwei Sprachen:", [
      { attachment: ANY_AUDIO, text: "Erste Notiz", durationMs: 1 },
      { attachment: ANY_AUDIO, text: "Zweite Notiz", durationMs: 1 }
    ]);
    expect(merged).toBe(
      "Zwei Sprachen:\n[Sprachnachricht-Transkription 1]: Erste Notiz\n[Sprachnachricht-Transkription 2]: Zweite Notiz"
    );
  });
});

describe("transcribeAudioAttachments", () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "transcribe-test-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("skips non-audio attachments without contacting the API", async () => {
    const { transcribeAudioAttachments } = await loadSubject();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const out = await transcribeAudioAttachments(
      [{ ...ANY_AUDIO, kind: "image" }],
      {
        async downloadAttachmentToTempFile() {
          throw new Error("must-not-be-called");
        }
      },
      {
        apiKey: "sk-test",
        endpoint: "http://whisper-local",
        model: "whisper-1",
        timeoutMs: 1000
      }
    );

    expect(out).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("downloads each audio attachment, posts to Whisper, and returns transcripts", async () => {
    const { transcribeAudioAttachments } = await loadSubject();
    const audioPath = join(tmpDir, "voice.webm");
    await writeFile(audioPath, Buffer.from("FAKEAUDIO"));

    const fetchSpy = vi.fn(async (_url, init) => {
      const form = init.body as FormData;
      // Sanity-check that the form carries the audio file + model
      expect(form.get("model")).toBe("whisper-1");
      expect(form.get("file")).toBeInstanceOf(Blob);
      return new Response(
        JSON.stringify({ text: "Hey @andi check bitte den Bug" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const out = await transcribeAudioAttachments(
      [ANY_AUDIO],
      {
        async downloadAttachmentToTempFile() {
          return audioPath;
        }
      },
      {
        apiKey: "sk-test",
        endpoint: "http://whisper-local/v1/audio/transcriptions",
        model: "whisper-1",
        timeoutMs: 5000
      }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("Hey @andi check bitte den Bug");
    expect(out[0]?.error).toBeUndefined();
  });

  it("captures per-attachment errors without aborting the rest", async () => {
    const { transcribeAudioAttachments } = await loadSubject();
    const audioPath = join(tmpDir, "voice.webm");
    await writeFile(audioPath, Buffer.from("FAKEAUDIO"));

    let call = 0;
    const fetchSpy = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({ text: "second one worked" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const out = await transcribeAudioAttachments(
      [ANY_AUDIO, ANY_AUDIO],
      {
        async downloadAttachmentToTempFile() {
          return audioPath;
        }
      },
      {
        apiKey: "sk-test",
        endpoint: "http://whisper-local/v1/audio/transcriptions",
        model: "whisper-1",
        timeoutMs: 5000
      }
    );

    expect(out).toHaveLength(2);
    expect(out[0]?.text).toBeNull();
    expect(out[0]?.error).toMatch(/HTTP 429/);
    expect(out[1]?.text).toBe("second one worked");
  });

  it("marks downloader-unavailable when no client is supplied", async () => {
    const { transcribeAudioAttachments } = await loadSubject();
    const out = await transcribeAudioAttachments(
      [ANY_AUDIO],
      undefined,
      {
        apiKey: "sk-test",
        endpoint: "http://whisper-local",
        model: "whisper-1",
        timeoutMs: 1000
      }
    );
    expect(out).toEqual([
      expect.objectContaining({ text: null, error: "downloader-unavailable" })
    ]);
  });
});
