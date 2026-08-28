import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { FilePendingReplyStore, reconcilePendingReplies } from "../src/pending-replies.js";

async function storeInTempDir(): Promise<FilePendingReplyStore> {
  const dir = await mkdtemp(join(tmpdir(), "rc-pending-"));
  return new FilePendingReplyStore(join(dir, "pending.json"));
}

describe("FilePendingReplyStore", () => {
  it("records, lists and removes entries per account", async () => {
    const store = await storeInTempDir();
    await store.start("marco", { roomId: "r1", messageId: "m1", triggerMessageId: "t1" });
    await store.start("bettina", { roomId: "r2", messageId: "m2" });

    expect((await store.list("marco")).map((e) => e.messageId)).toEqual(["m1"]);
    expect((await store.list("bettina")).map((e) => e.messageId)).toEqual(["m2"]);

    await store.settle("marco", "m1");
    expect(await store.list("marco")).toEqual([]);
    // Accounts must not interfere with each other.
    expect((await store.list("bettina")).map((e) => e.messageId)).toEqual(["m2"]);
  });

  it("keeps a finished answer for retry", async () => {
    const store = await storeInTempDir();
    await store.start("marco", { roomId: "r1", messageId: "m1", triggerMessageId: "t1" });
    await store.keepForRetry("marco", "m1", "Die Antwort.", "done");

    const [entry] = await store.list("marco");
    expect(entry.finalText).toBe("Die Antwort.");
    expect(entry.outcome).toBe("done");
    expect(entry.triggerMessageId).toBe("t1");
  });

  it("survives a truncated or corrupted state file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rc-pending-"));
    const path = join(dir, "pending.json");
    await writeFile(path, "{not json");
    const store = new FilePendingReplyStore(path);

    expect(await store.list("marco")).toEqual([]);
    await store.start("marco", { roomId: "r1", messageId: "m1" });
    expect((await store.list("marco")).map((e) => e.messageId)).toEqual(["m1"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("marco");
  });
});

describe("reconcilePendingReplies", () => {
  // A run killed by a pod restart leaves its placeholder behind forever:
  // the watchdog that would have timed it out lived in the dead process.
  // On 2026-08-27 that left marco frozen on a progress view and bettina on
  // "⏳ Moment … (denke nach)" — indefinitely, in both cases.
  it("marks an interrupted run and swaps the working reaction for a warning", async () => {
    const store = await storeInTempDir();
    await store.start("marco", { roomId: "r1", messageId: "m1", triggerMessageId: "t1" });

    const client = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await reconcilePendingReplies({ accountId: "marco", client, store });

    expect(client.updateMessage).toHaveBeenCalledWith("r1", "m1", expect.stringContaining("unterbrochen"));
    expect(client.reactMessage).toHaveBeenCalledWith("t1", ":hourglass_flowing_sand:", false);
    expect(client.reactMessage).toHaveBeenCalledWith("t1", ":warning:", true);
    expect(await store.list("marco")).toEqual([]);
  });

  // bettina's answer existed — the run finished at 20:11:22 while the
  // channel was still in reconnect backoff until 20:11:34. Twelve seconds
  // must not cost the user their answer.
  it("delivers an answer that was finished while the channel was down", async () => {
    const store = await storeInTempDir();
    await store.start("bettina", { roomId: "r2", messageId: "m2", triggerMessageId: "t2" });
    await store.keepForRetry("bettina", "m2", "Liquidität ist solide.", "done");

    const client = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await reconcilePendingReplies({ accountId: "bettina", client, store });

    expect(client.updateMessage).toHaveBeenCalledWith("r2", "m2", "Liquidität ist solide.");
    expect(client.reactMessage).toHaveBeenCalledWith("t2", ":hourglass_flowing_sand:", false);
    expect(client.reactMessage).toHaveBeenCalledWith("t2", ":white_check_mark:", true);
    expect(await store.list("bettina")).toEqual([]);
  });

  it("keeps the entry when redelivery fails again", async () => {
    const store = await storeInTempDir();
    await store.start("bettina", { roomId: "r2", messageId: "m2" });
    await store.keepForRetry("bettina", "m2", "Liquidität ist solide.", "done");

    const client = {
      updateMessage: vi.fn().mockRejectedValue(new Error("still offline")),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await reconcilePendingReplies({ accountId: "bettina", client, store });

    const [entry] = await store.list("bettina");
    expect(entry?.finalText).toBe("Liquidität ist solide.");
  });

  it("does nothing when there is nothing pending", async () => {
    const store = await storeInTempDir();
    const client = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };
    await reconcilePendingReplies({ accountId: "marco", client, store });
    expect(client.updateMessage).not.toHaveBeenCalled();
  });
});

describe("reconcilePendingReplies under a backlog", () => {
  // Am 28.08.2026 hinterliessen drei Pod-Neustarts 1143, dann 8653
  // Platzhalter. Jeder wurde beim Start in eine Abbruchmeldung verwandelt —
  // die Kundenchats waren unbenutzbar. Eine Abbruchmeldung ist eine
  // Hoeflichkeit, keine Buchhaltung: ein paar genuegen, der Rest ist Laerm.
  const flood = (n: number, roomId = "r1") =>
    Array.from({ length: n }, (_, i) => ({
      roomId,
      messageId: `m${i}`,
      triggerMessageId: `t${i}`
    }));

  it("posts only a handful of interruption notices and settles the rest silently", async () => {
    const store = await storeInTempDir();
    for (const e of flood(40)) await store.start("vera", e);

    const client = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await reconcilePendingReplies({ accountId: "vera", client, store });

    expect(client.updateMessage.mock.calls.length).toBeLessThanOrEqual(3);
    // Nichts bleibt liegen: was nicht gemeldet wird, wird stillschweigend
    // abgeraeumt, sonst waechst der Rueckstand ueber jeden Neustart weiter.
    expect(await store.list("vera")).toEqual([]);
  });

  it("keeps every room informed instead of spending the budget on one", async () => {
    const store = await storeInTempDir();
    for (const e of flood(20, "ankauf")) await store.start("vera", e);
    for (const e of flood(20, "verwaltung")) await store.start("vera", { ...e, messageId: `v-${e.messageId}` });

    const client = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await reconcilePendingReplies({ accountId: "vera", client, store });

    const rooms = new Set(client.updateMessage.mock.calls.map((c) => c[0]));
    expect(rooms).toEqual(new Set(["ankauf", "verwaltung"]));
  });

  // Der Deckel darf niemals eine fertige Antwort verschlucken. Eine
  // Abbruchmeldung ist ersetzbar, eine Antwort ist es nicht.
  it("never drops an answer, however large the backlog", async () => {
    const store = await storeInTempDir();
    for (const e of flood(30)) {
      await store.start("vera", e);
      await store.keepForRetry("vera", e.messageId, `Antwort ${e.messageId}`, "done");
    }

    const client = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await reconcilePendingReplies({ accountId: "vera", client, store });

    expect(client.updateMessage).toHaveBeenCalledTimes(30);
    expect(await store.list("vera")).toEqual([]);
  });

  // Ein Platzhalter von vorgestern braucht keine Entschuldigung mehr — der
  // Nutzer hat den Thread laengst verlassen.
  it("does not announce an interruption for a stale placeholder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rc-pending-"));
    const path = join(dir, "pending.json");
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await writeFile(
      path,
      JSON.stringify({ vera: [{ roomId: "r1", messageId: "old", startedAt: twoDaysAgo }] })
    );
    const store = new FilePendingReplyStore(path);

    const client = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
      reactMessage: vi.fn().mockResolvedValue(undefined)
    };

    await reconcilePendingReplies({ accountId: "vera", client, store });

    expect(client.updateMessage).not.toHaveBeenCalled();
    expect(await store.list("vera")).toEqual([]);
  });
});
