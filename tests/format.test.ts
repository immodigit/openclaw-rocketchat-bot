import { describe, expect, it } from "vitest";

import {
  THINKING_PLACEHOLDER,
  TOOL_PROGRESS_HEADER,
  TOOL_REPLY_FALLBACK,
  createReplyProgressState,
  formatFinalReply,
  formatReplyUpdate,
  isToolTraceStub
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

describe("formatReplyUpdate with a failed tool step", () => {
  // Kurt read an .xlsx, a `cat` from the wrong directory failed, he
  // corrected himself and read the file completely. The customer saw only
  // "⚠️ 🛠️ show xl/workbook.xml → … failed" and concluded the agent had
  // crashed. A failed intermediate step is not a result.
  const failedStep = "⚠️ 🛠️ show xl/workbook.xml → print text → show xl/_rels/workbook.xml.rels (in /tmp/xlsx) failed";

  it("does not surface the failed step when there is no progress view", () => {
    const rendered = formatReplyUpdate("tool", { text: failedStep });
    expect(rendered).not.toContain("failed");
    expect(rendered).toBe(TOOL_REPLY_FALLBACK);
  });

  it("keeps earlier steps visible instead of appending the failure", () => {
    const progress = { lines: ["read agent.yaml"] };
    const rendered = formatReplyUpdate("tool", { text: failedStep }, progress);
    expect(progress.lines).toEqual(["read agent.yaml"]);
    expect(rendered).toContain("read agent.yaml");
    expect(rendered).not.toContain("failed");
  });

  it("still shows normal steps", () => {
    const progress = { lines: [] as string[] };
    const rendered = formatReplyUpdate("tool", { text: "read agent.yaml" }, progress);
    expect(rendered).toContain("read agent.yaml");
  });
});

describe("isToolTraceStub", () => {
  // OpenClaw only emits kind:"tool" deliveries when verbose tool progress
  // is switched on. With it off — the state of the production instance —
  // tool notices arrive on the prose path (block/final) instead, wearing
  // the same wrench prefix core uses to mark tool-owned payloads.
  it("recognises tool failure notices delivered as prose", () => {
    expect(
      isToolTraceStub(
        '⚠️ 🛠️ Bash failed: print lines 1-260 from scripts/notion-helpers.js → search "Datum" in 2>/dev/null (workspace)'
      )
    ).toBe(true);
    expect(isToolTraceStub("⚠️ 🔧 gog drive ls --parent 1no6 failed")).toBe(true);
    expect(isToolTraceStub("🛠️ Ich arbeite daran …")).toBe(true);
  });

  it("does not swallow an answer that merely opens with a warning sign", () => {
    // An agent is allowed to lead with ⚠️ — that is a real answer and must
    // reach the user untouched. Anchoring on ⚠️ alone would eat it.
    expect(isToolTraceStub("⚠️ Achtung: der Postingkalender ist ab 01.09. leer.")).toBe(false);
    expect(isToolTraceStub("Nein – heute wurde nichts gepostet.")).toBe(false);
  });

  it("treats absent text as no stub", () => {
    expect(isToolTraceStub(undefined)).toBe(false);
    expect(isToolTraceStub("")).toBe(false);
  });
});
