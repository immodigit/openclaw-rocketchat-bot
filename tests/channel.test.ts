import { describe, expect, it, vi } from "vitest";

import { sendReplyLifecycle, shouldHandleInboundEvent } from "../src/channel.js";
import type { InboundEvent } from "../src/inbound/types.js";

describe("shouldHandleInboundEvent", () => {
  const baseEvent: InboundEvent = {
    accountId: "main",
    roomId: "room-1",
    roomType: "channel",
    messageId: "m1",
    tmid: null,
    senderId: "user-1",
    senderName: "alice",
    text: "hello",
    mentions: [],
    attachments: [],
    sentAt: "2026-03-26T11:00:00.000Z",
    raw: {}
  };

  it("accepts direct messages", () => {
    expect(
      shouldHandleInboundEvent(
        {
          ...baseEvent,
          roomType: "direct"
        },
        {
          botUserId: "bot-1",
          mentionNames: ["rocketbot"]
        }
      )
    ).toBe(true);
  });

  it("requires a mention in group contexts", () => {
    expect(
      shouldHandleInboundEvent(baseEvent, {
        botUserId: "bot-1",
        mentionNames: ["rocketbot"]
      })
    ).toBe(false);
  });

  it("accepts mention metadata and alias text fallback", () => {
    expect(
      shouldHandleInboundEvent(
        {
          ...baseEvent,
          roomType: "group",
          mentions: ["rocketbot"]
        },
        {
          botUserId: "bot-1",
          mentionNames: ["rocketbot"]
        }
      )
    ).toBe(true);

    expect(
      shouldHandleInboundEvent(
        {
          ...baseEvent,
          roomType: "group",
          text: "@assistant help"
        },
        {
          botUserId: "bot-1",
          mentionNames: ["rocketbot", "assistant"]
        }
      )
    ).toBe(true);
  });

  it("ignores self-authored messages", () => {
    expect(
      shouldHandleInboundEvent(
        {
          ...baseEvent,
          senderId: "bot-1",
          roomType: "direct"
        },
        {
          botUserId: "bot-1",
          mentionNames: ["rocketbot"]
        }
      )
    ).toBe(false);
  });
});

describe("sendReplyLifecycle", () => {
  it("posts one placeholder and updates the same message for tool, block, and final output", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "tool", payload: {} });
        await session.update({ kind: "block", payload: { text: "正在整理结果" } });
        await session.update({ kind: "final", payload: { text: "最终答案" } });
      }
    });

    expect(client.postMessage).toHaveBeenCalledTimes(1);
    expect(client.postMessage).toHaveBeenCalledWith("room-1", "⏳ Moment … (denke nach)", undefined);
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      1,
      "room-1",
      "placeholder-1",
      "🛠️ Ich arbeite daran …"
    );
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      2,
      "room-1",
      "placeholder-1",
      "正在整理结果"
    );
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      3,
      "room-1",
      "placeholder-1",
      "最终答案"
    );
  });

  it("folds successive tool steps into one rolling progress view", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "tool", payload: { text: "🔎 Web Search: Markt" } });
        await session.update({ kind: "tool", payload: { text: "📖 Read: docs/markt.md" } });
        await session.update({ kind: "final", payload: { text: "Analyse fertig." } });
      }
    });

    // First tool step: header + the step itself replaces "denke nach".
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      1,
      "room-1",
      "placeholder-1",
      "🛠️ Ich arbeite daran …\n🔎 Web Search: Markt"
    );
    // Second step is appended below the first — the user sees the history.
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      2,
      "room-1",
      "placeholder-1",
      "🛠️ Ich arbeite daran …\n🔎 Web Search: Markt\n📖 Read: docs/markt.md"
    );
    // The final answer replaces the progress view entirely.
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      3,
      "room-1",
      "placeholder-1",
      "Analyse fertig."
    );
  });

  it("replaces the placeholder with an error note when execution fails after creation", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined)
    };

    await expect(
      sendReplyLifecycle({
        client,
        roomId: "room-1",
        run: async (session) => {
          await session.update({ kind: "tool", payload: {} });
          throw new Error("boom");
        }
      })
    ).rejects.toThrow("boom");

    expect(client.postMessage).toHaveBeenCalledTimes(1);
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      1,
      "room-1",
      "placeholder-1",
      "🛠️ Ich arbeite daran …"
    );
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      2,
      "room-1",
      "placeholder-1",
      "❌ Etwas ist beim Antworten schiefgelaufen. Bitte nochmal mentionen."
    );
  });

  it("resolves the placeholder with an empty final fallback when run completes without a final update and the client cannot delete", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "tool", payload: {} });
      }
    });

    expect(client.postMessage).toHaveBeenCalledTimes(1);
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      1,
      "room-1",
      "placeholder-1",
      "🛠️ Ich arbeite daran …"
    );
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      2,
      "room-1",
      "placeholder-1",
      "(no reply generated)"
    );
  });

  it("salvages the last block prose as the closing reply when the run ends on a trailing tool stub", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        // Agent fails a tool, then reports success as prose, then runs one
        // more tool — and the run ends without a clean final delivery.
        await session.update({ kind: "tool", payload: { text: "🛠️ pip install … failed" } });
        await session.update({ kind: "block", payload: { text: "✅ Fertig — 332 Posts in der KB." } });
        await session.update({ kind: "tool", payload: { text: "📦 git push" } });
      }
    });

    // There IS prose to salvage, so we must not delete the message.
    expect(client.deleteMessage).not.toHaveBeenCalled();
    // The closing update restores the agent's real prose, not the tool stub.
    expect(client.updateMessage.mock.calls.at(-1)).toEqual([
      "room-1",
      "placeholder-1",
      "✅ Fertig — 332 Posts in der KB."
    ]);
  });

  it("deletes the placeholder instead of leaving an empty-reply fallback when the client supports deleteMessage", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "tool", payload: {} });
      }
    });

    // Tool stage still updates the placeholder once with "🛠️ Ich arbeite daran …"
    expect(client.updateMessage).toHaveBeenCalledTimes(1);
    expect(client.updateMessage).toHaveBeenCalledWith(
      "room-1",
      "placeholder-1",
      "🛠️ Ich arbeite daran …"
    );
    // The empty-final stage deletes instead of leaving fallback text behind
    expect(client.deleteMessage).toHaveBeenCalledExactlyOnceWith(
      "room-1",
      "placeholder-1"
    );
  });

  it("falls back to updating the placeholder when deleteMessage throws", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockRejectedValue(new Error("forbidden"))
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "tool", payload: {} });
      }
    });

    expect(client.deleteMessage).toHaveBeenCalledTimes(1);
    // tool stage update + fallback update after delete fails
    expect(client.updateMessage).toHaveBeenCalledTimes(2);
    expect(client.updateMessage).toHaveBeenNthCalledWith(
      2,
      "room-1",
      "placeholder-1",
      "(no reply generated)"
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("uploads a final attachment after updating the placeholder message", async () => {
    const postMessage = vi.fn().mockResolvedValue("placeholder-1");
    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const uploadAttachment = vi.fn().mockResolvedValue("attachment-1");

    await sendReplyLifecycle({
      client: {
        postMessage,
        updateMessage,
        uploadAttachment
      },
      roomId: "room-1",
      run: async (session) => {
        await session.update({
          kind: "final",
          payload: {
            text: "结果已生成",
            attachmentPath: "/tmp/result.zip"
          }
        });
      }
    });

    expect(updateMessage).toHaveBeenCalledWith("room-1", "placeholder-1", "结果已生成");
    expect(uploadAttachment).toHaveBeenCalledWith("room-1", "/tmp/result.zip", "结果已生成", undefined);
  });

  it("ignores attachmentPath on non-final stages", async () => {
    const uploadAttachment = vi.fn().mockResolvedValue("attachment-1");

    await sendReplyLifecycle({
      client: {
        postMessage: vi.fn().mockResolvedValue("placeholder-1"),
        updateMessage: vi.fn().mockResolvedValue(undefined),
        uploadAttachment
      },
      roomId: "room-1",
      run: async (session) => {
        await session.update({
          kind: "block",
          payload: {
            text: "处理中",
            attachmentPath: "/tmp/result.zip"
          }
        });
        await session.update({
          kind: "final",
          payload: {
            text: "完成"
          }
        });
      }
    });

    expect(uploadAttachment).not.toHaveBeenCalled();
  });

  it("propagates upload errors after final text update", async () => {
    const error = new Error("upload failed");
    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const uploadAttachment = vi.fn().mockRejectedValue(error);

    await expect(
      sendReplyLifecycle({
        client: {
          postMessage: vi.fn().mockResolvedValue("placeholder-1"),
          updateMessage,
          uploadAttachment
        },
        roomId: "room-1",
        run: async (session) => {
          await session.update({
            kind: "final",
            payload: {
              text: "最终结果",
              attachmentPath: "/tmp/result.zip"
            }
          });
        }
      })
    ).rejects.toThrow("upload failed");

    expect(updateMessage).toHaveBeenCalledWith("room-1", "placeholder-1", "最终结果");
  });

  it("updates the placeholder through watchdog stages when the agent stays silent", async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn().mockResolvedValue("placeholder-1");
    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const deleteMessage = vi.fn().mockResolvedValue(undefined);

    // Run the lifecycle with a `run` that never emits any update, then
    // resolves at the end. While `run` is pending, advance fake time so
    // the watchdog reports each elapsed stage without declaring failure.
    const lifecycle = sendReplyLifecycle({
      client: { postMessage, updateMessage, deleteMessage },
      roomId: "room-1",
      run: () =>
        new Promise<void>((resolve) => {
          // Resolve after the 15-minute progress stage.
          setTimeout(resolve, 16 * 60 * 1000);
        })
    });

    // Allow the placeholder postMessage to land.
    await vi.advanceTimersByTimeAsync(0);
    expect(postMessage).toHaveBeenCalledTimes(1);

    // First watchdog tick after 60s elapsed: stage 1.
    await vi.advanceTimersByTimeAsync(60_000);
    // Second after 5m elapsed: stage 2.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    // Third after 15m elapsed: stage 3 remains non-terminal.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    // Now let the lifecycle's `run` resolve so the lifecycle finishes.
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await lifecycle;

    const watchdogCalls = updateMessage.mock.calls
      .map(([, , text]) => text as string)
      .filter((t) => t.includes("Bin dran") || t.includes("Dauert länger") || t.includes("Läuft weiter"));

    expect(watchdogCalls).toEqual([
      "⏳ Bin dran … (1m+)",
      "🤔 Dauert länger als üblich (5m+)",
      "⏳ Läuft weiter … (15m+)"
    ]);

    vi.useRealTimers();
  });

  it("stops the watchdog as soon as the agent emits its first real update", async () => {
    vi.useFakeTimers();
    const postMessage = vi.fn().mockResolvedValue("placeholder-1");
    const updateMessage = vi.fn().mockResolvedValue(undefined);

    const lifecycle = sendReplyLifecycle({
      client: { postMessage, updateMessage },
      roomId: "room-1",
      run: async (session) => {
        // Agent emits a tool update 30s in — before the first watchdog
        // stage would fire (60s).
        await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
        await session.update({ kind: "tool", payload: {} });
        await session.update({ kind: "final", payload: { text: "fertig" } });
      }
    });

    // Advance to 30s — agent's tool update lands.
    await vi.advanceTimersByTimeAsync(30_000);
    // Now jump way past all watchdog stages.
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    await lifecycle;

    // No watchdog text should have been written — only the tool fallback
    // and the final.
    const watchdogCalls = updateMessage.mock.calls
      .map(([, , text]) => text as string)
      .filter((t) => t.includes("Bin dran") || t.includes("Dauert länger") || t.includes("Keine Antwort"));

    expect(watchdogCalls).toEqual([]);
    vi.useRealTimers();
  });

  it("shows ⏳ while working and clears it without a verdict when the agent gives no signal", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      triggerMessageId: "trigger-1",
      run: async (session) => {
        await session.update({ kind: "final", payload: { text: "Hier der Zwischenstand …" } });
      }
    });

    // ⏳ on at the start, off at the end …
    expect(client.reactMessage).toHaveBeenCalledWith("trigger-1", ":hourglass_flowing_sand:", true);
    expect(client.reactMessage).toHaveBeenCalledWith("trigger-1", ":hourglass_flowing_sand:", false);
    // … and no terminal verdict is applied without a signal.
    expect(client.reactMessage).not.toHaveBeenCalledWith("trigger-1", ":white_check_mark:", true);
    expect(client.reactMessage).not.toHaveBeenCalledWith("trigger-1", ":question:", true);
    expect(client.reactMessage).not.toHaveBeenCalledWith("trigger-1", ":warning:", true);
  });

  it("clears ⏳ → ✅ and strips the marker when the agent signals done", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      triggerMessageId: "trigger-1",
      run: async (session) => {
        await session.update({
          kind: "final",
          payload: { text: "✅ Reel 8 gepostet, Status auf POSTED. [[ERLEDIGT]]" }
        });
      }
    });

    expect(client.reactMessage).toHaveBeenCalledWith("trigger-1", ":hourglass_flowing_sand:", false);
    expect(client.reactMessage).toHaveBeenCalledWith("trigger-1", ":white_check_mark:", true);
    expect(client.updateMessage.mock.calls.at(-1)).toEqual([
      "room-1",
      "placeholder-1",
      "✅ Reel 8 gepostet, Status auf POSTED."
    ]);
  });

  it("clears ⏳ → ❓ when the agent needs the user's input", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      triggerMessageId: "trigger-1",
      run: async (session) => {
        await session.update({ kind: "final", payload: { text: "v6 oder v7 nehmen? [[FRAGE]]" } });
      }
    });

    expect(client.reactMessage).toHaveBeenCalledWith("trigger-1", ":question:", true);
    expect(client.reactMessage).not.toHaveBeenCalledWith("trigger-1", ":white_check_mark:", true);
    expect(client.updateMessage.mock.calls.at(-1)).toEqual(["room-1", "placeholder-1", "v6 oder v7 nehmen?"]);
  });

  it("clears ⏳ → ⚠️ when the agent flags a problem", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      triggerMessageId: "trigger-1",
      run: async (session) => {
        await session.update({ kind: "final", payload: { text: "VirusTotal-Key abgelaufen. [[ACHTUNG]]" } });
      }
    });

    expect(client.reactMessage).toHaveBeenCalledWith("trigger-1", ":warning:", true);
    expect(client.updateMessage.mock.calls.at(-1)).toEqual([
      "room-1",
      "placeholder-1",
      "VirusTotal-Key abgelaufen."
    ]);
  });

  it("reacts ⚠️ on the trigger message when the run throws", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await expect(
      sendReplyLifecycle({
        client,
        roomId: "room-1",
        triggerMessageId: "trigger-1",
        run: async () => {
          throw new Error("boom");
        }
      })
    ).rejects.toThrow("boom");

    expect(client.reactMessage).toHaveBeenCalledWith("trigger-1", ":warning:", true);
  });

  it("does not react when no trigger message id is provided", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "final", payload: { text: "fertig" } });
      }
    });

    expect(client.reactMessage).not.toHaveBeenCalled();
  });

  it("keeps a 46-minute silent run alive without a false warning reaction", async () => {
    vi.useFakeTimers();
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    const lifecycle = sendReplyLifecycle({
      client,
      roomId: "room-1",
      triggerMessageId: "trigger-1",
      run: () => new Promise<void>((resolve) => setTimeout(resolve, 46 * 60 * 1000))
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(45 * 60 * 1000 + 1000);

    expect(client.updateMessage).toHaveBeenCalledWith(
      "room-1",
      "placeholder-1",
      expect.stringMatching(/45m\+.*Arbeit|Arbeit.*45m\+/i)
    );
    expect(client.reactMessage).not.toHaveBeenCalledWith("trigger-1", ":warning:", true);

    // Let the run resolve so the lifecycle settles.
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await lifecycle;
    vi.useRealTimers();
  });
});

describe("sendReplyLifecycle with tool notices on the prose path", () => {
  // The production instance runs with verbose tool progress off, so the
  // host never emits kind:"tool" — tool failure notices arrive as block or
  // final deliveries instead. On 2026-08-26 marco produced a complete
  // posting-calendar answer at 22:40:48.070; 620 ms later the queued
  // "⚠️ 🛠️ Bash failed: …" notice landed as the closing delivery and
  // overwrote it. The ✅ reaction stayed — proof the answer had arrived
  // and been written — but the user saw only the tool trace.
  const toolNotice =
    '⚠️ 🛠️ Bash failed: print lines 1-260 from scripts/notion-helpers.js → search "Datum" in 2>/dev/null (workspace)';
  const answer = "Nein – heute wurde nichts gepostet. Der Kalender ist zu dünn.";

  it("keeps the answer when a tool notice arrives as the closing final delivery", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      triggerMessageId: "trigger-1",
      run: async (session) => {
        await session.update({ kind: "block", payload: { text: `${answer} [[ERLEDIGT]]` } });
        await session.update({ kind: "final", payload: { text: toolNotice } });
      }
    });

    expect(client.updateMessage.mock.calls.at(-1)).toEqual(["room-1", "placeholder-1", answer]);
    expect(client.deleteMessage).not.toHaveBeenCalled();
    expect(client.reactMessage).toHaveBeenCalledWith("trigger-1", ":white_check_mark:", true);
  });

  it("keeps the answer when a tool notice arrives as a trailing block delivery", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "final", payload: { text: answer } });
        await session.update({ kind: "block", payload: { text: toolNotice } });
      }
    });

    expect(client.updateMessage.mock.calls.at(-1)).toEqual(["room-1", "placeholder-1", answer]);
  });

  it("does not let a tool notice count as the final delivery, so salvage still runs", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "block", payload: { text: answer } });
        await session.update({ kind: "final", payload: { text: toolNotice } });
        await session.update({ kind: "final", payload: { text: toolNotice } });
      }
    });

    expect(client.updateMessage.mock.calls.at(-1)).toEqual(["room-1", "placeholder-1", answer]);
  });

  it("keeps a lone tool notice visible rather than deleting the message", async () => {
    // Nothing to salvage: the run really did produce only a failed tool.
    // Silence is worse than the trace — the user must see that something
    // happened and can re-trigger.
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "final", payload: { text: toolNotice } });
      }
    });

    expect(client.deleteMessage).not.toHaveBeenCalled();
    expect(client.updateMessage.mock.calls.at(-1)).toEqual([
      "room-1",
      "placeholder-1",
      toolNotice
    ]);
  });

  it("still delivers an answer that opens with a warning sign", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      triggerMessageId: "trigger-1",
      run: async (session) => {
        await session.update({
          kind: "final",
          payload: { text: "⚠️ Achtung: der Kalender ist ab 01.09. leer. [[ACHTUNG]]" }
        });
      }
    });

    expect(client.updateMessage.mock.calls.at(-1)).toEqual([
      "room-1",
      "placeholder-1",
      "⚠️ Achtung: der Kalender ist ab 01.09. leer."
    ]);
    expect(client.reactMessage).toHaveBeenCalledWith("trigger-1", ":warning:", true);
  });
});

describe("sendReplyLifecycle with a pending-reply tracker", () => {
  const tracker = () => ({
    start: vi.fn().mockResolvedValue(undefined),
    settle: vi.fn().mockResolvedValue(undefined),
    keepForRetry: vi.fn().mockResolvedValue(undefined)
  });

  it("registers the placeholder up front and settles it once the answer is out", async () => {
    // The entry has to exist *before* the run does any work — a process
    // that dies mid-run cannot write it afterwards, and that is exactly
    // the case reconciliation has to clean up.
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };
    const pending = tracker();

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      triggerMessageId: "trigger-1",
      pending,
      run: async (session) => {
        expect(pending.start).toHaveBeenCalledWith({
          roomId: "room-1",
          messageId: "placeholder-1",
          triggerMessageId: "trigger-1"
        });
        expect(pending.settle).not.toHaveBeenCalled();
        await session.update({ kind: "final", payload: { text: "Fertig. [[ERLEDIGT]]" } });
      }
    });

    expect(pending.settle).toHaveBeenCalledWith("placeholder-1");
    expect(pending.keepForRetry).not.toHaveBeenCalled();
  });

  it("hands a finished answer to the tracker when delivery fails", async () => {
    // bettina finished her liquidity answer 12s before the channel came
    // back. Losing it was the bug — it has to survive for redelivery.
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error("channel offline")),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };
    const pending = tracker();

    await expect(
      sendReplyLifecycle({
        client,
        roomId: "room-1",
        triggerMessageId: "trigger-1",
        pending,
        run: async (session) => {
          await session.update({ kind: "block", payload: { text: "Zwischenstand" } });
          await session.update({ kind: "final", payload: { text: "Die Antwort. [[ERLEDIGT]]" } });
        }
      })
    ).rejects.toThrow();

    expect(pending.keepForRetry).toHaveBeenCalledWith(
      "placeholder-1",
      "Die Antwort.",
      "done"
    );
    expect(pending.settle).not.toHaveBeenCalled();
  });

  it("works unchanged when no tracker is supplied", async () => {
    const client = {
      postMessage: vi.fn().mockResolvedValue("placeholder-1"),
      updateMessage: vi.fn().mockResolvedValue(undefined)
    };

    await sendReplyLifecycle({
      client,
      roomId: "room-1",
      run: async (session) => {
        await session.update({ kind: "final", payload: { text: "Fertig." } });
      }
    });

    expect(client.updateMessage.mock.calls.at(-1)).toEqual(["room-1", "placeholder-1", "Fertig."]);
  });
});
