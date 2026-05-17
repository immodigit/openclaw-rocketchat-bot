import { describe, expect, it } from "vitest";

import { THINKING_PLACEHOLDER, formatFinalReply } from "../src/format.js";

describe("formatFinalReply", () => {
  it("uses a stable thinking placeholder with a loading-style emoji", () => {
    expect(THINKING_PLACEHOLDER).toMatch(/⏳/);
    expect(THINKING_PLACEHOLDER).toMatch(/denke nach/i);
  });

  it("preserves fenced code blocks", () => {
    const reply = "```ts\nconst value = 1;\n```";

    expect(formatFinalReply(reply)).toBe(reply);
  });

  it("falls back for empty output", () => {
    expect(formatFinalReply("")).toBe("(no reply generated)");
    expect(formatFinalReply("   ")).toBe("(no reply generated)");
  });
});
