import { describe, expect, it } from "vitest";

import {
  THINKING_PLACEHOLDER,
  TOOL_PROGRESS_HEADER,
  createReplyProgressState,
  formatFinalReply,
  formatReplyUpdate
} from "../src/format.js";

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

describe("formatReplyUpdate tool progress", () => {
  it("folds successive tool steps into one rolling progress view", () => {
    const progress = createReplyProgressState();

    const first = formatReplyUpdate("tool", { text: "🔎 Web Search" }, progress);
    expect(first).toBe(`${TOOL_PROGRESS_HEADER}\n🔎 Web Search`);

    const second = formatReplyUpdate("tool", { text: "📖 Read file" }, progress);
    expect(second).toBe(`${TOOL_PROGRESS_HEADER}\n🔎 Web Search\n📖 Read file`);
  });

  it("shows just the header for a tool delivery without text", () => {
    const progress = createReplyProgressState();
    expect(formatReplyUpdate("tool", {}, progress)).toBe(TOOL_PROGRESS_HEADER);
  });

  it("skips consecutive duplicate steps", () => {
    const progress = createReplyProgressState();
    formatReplyUpdate("tool", { text: "🔎 Web Search" }, progress);
    formatReplyUpdate("tool", { text: "🔎 Web Search" }, progress);
    expect(progress.lines).toEqual(["🔎 Web Search"]);
  });

  it("caps the rolling list to the most recent steps", () => {
    const progress = createReplyProgressState();
    for (let i = 0; i < 10; i++) {
      formatReplyUpdate("tool", { text: `step ${i}` }, progress);
    }
    expect(progress.lines).toHaveLength(6);
    expect(progress.lines[0]).toBe("step 4");
    expect(progress.lines[5]).toBe("step 9");
  });

  it("lets the final answer replace the progress view", () => {
    const progress = createReplyProgressState();
    formatReplyUpdate("tool", { text: "🔎 Web Search" }, progress);
    expect(formatReplyUpdate("final", { text: "Done." }, progress)).toBe("Done.");
  });

  it("falls back to a single line when no progress state is supplied", () => {
    expect(formatReplyUpdate("tool", { text: "🔎 Web Search" })).toBe("🔎 Web Search");
    expect(formatReplyUpdate("tool", {})).toBe("🔧 Tool wird benutzt …");
  });
});
