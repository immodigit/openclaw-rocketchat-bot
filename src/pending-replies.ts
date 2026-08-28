import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  INTERRUPTED_REPLY_FALLBACK,
  REACTION_ATTENTION,
  REACTION_DONE,
  REACTION_INPUT,
  REACTION_WORKING,
  type ReplyOutcome
} from "./format.js";

/**
 * One reply we started but have not confirmed as delivered.
 *
 * The reply lifecycle lives entirely in memory: the placeholder's message
 * id, the watchdog that would eventually time it out, the final text on its
 * way to Rocket.Chat. When the process dies — a pod restart is enough — all
 * of that goes with it and the user is left staring at "⏳ Moment …"
 * forever, because the watchdog that would have replaced it died too.
 *
 * Persisting the entry *before* the run starts is what makes the placeholder
 * recoverable at the next channel start.
 */
export type PendingReply = {
  roomId: string;
  /** The placeholder message this turn owns. */
  messageId: string;
  triggerMessageId?: string;
  startedAt: string;
  /**
   * Set when the agent finished but delivery failed — the answer exists and
   * must not be thrown away just because the channel was down for a moment.
   */
  finalText?: string;
  /** Terminal signal that belongs with `finalText` (✅ / ❓ / ⚠️). */
  outcome?: ReplyOutcome;
};

type PersistedState = Record<string, PendingReply[]>;

export class FilePendingReplyStore {
  constructor(private readonly filePath: string) {}

  async list(accountId: string): Promise<PendingReply[]> {
    const state = await this.loadState();
    return [...(state[accountId] ?? [])];
  }

  /** Record a placeholder as soon as it exists, before any work happens. */
  async start(
    accountId: string,
    entry: { roomId: string; messageId: string; triggerMessageId?: string }
  ): Promise<void> {
    await this.mutate(accountId, (entries) => [
      ...entries.filter((e) => e.messageId !== entry.messageId),
      { ...entry, startedAt: new Date().toISOString() }
    ]);
  }

  /** The reply reached Rocket.Chat — nothing left to recover. */
  async settle(accountId: string, messageId: string): Promise<void> {
    await this.mutate(accountId, (entries) =>
      entries.filter((e) => e.messageId !== messageId)
    );
  }

  /** Delivery failed with an answer in hand; keep it for the next start. */
  async keepForRetry(
    accountId: string,
    messageId: string,
    finalText: string,
    outcome?: ReplyOutcome
  ): Promise<void> {
    await this.mutate(accountId, (entries) => {
      const existing = entries.find((e) => e.messageId === messageId);
      const updated: PendingReply = {
        roomId: existing?.roomId ?? "",
        messageId,
        triggerMessageId: existing?.triggerMessageId,
        startedAt: existing?.startedAt ?? new Date().toISOString(),
        finalText,
        outcome
      };
      return [...entries.filter((e) => e.messageId !== messageId), updated];
    });
  }

  private async mutate(
    accountId: string,
    fn: (entries: PendingReply[]) => PendingReply[]
  ): Promise<void> {
    const state = await this.loadState();
    state[accountId] = fn(state[accountId] ?? []);
    if (state[accountId].length === 0) {
      delete state[accountId];
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }

  private async loadState(): Promise<PersistedState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as PersistedState;
      }
    } catch {
      // Same reasoning as the checkpoint store: a corrupted file must not
      // take the channel down. Worst case we lose the ability to recover a
      // handful of placeholders — losing inbound entirely is far worse.
    }
    console.warn(`[pending-replies] ${this.filePath}: unreadable state, starting empty`);
    return {};
  }
}

type ReconcileClient = {
  updateMessage(roomId: string, messageId: string, text: string): Promise<void>;
  reactMessage?(messageId: string, emoji: string, shouldReact?: boolean): Promise<void>;
};

type PendingReplyReader = {
  list(accountId: string): Promise<PendingReply[]>;
  settle(accountId: string, messageId: string): Promise<void>;
};

/**
 * Eine Abbruchmeldung ist eine Hoeflichkeit, keine Buchhaltung.
 *
 * Am 28.08.2026 hinterliessen drei Pod-Neustarts erst 1143, dann 8653
 * Platzhalter — jeder wurde beim Start in ein "Der Lauf wurde unterbrochen"
 * verwandelt und die Kundenchats waren unbenutzbar. Zwei Meldungen je Raum
 * sagen dasselbe wie achttausend.
 */
const MAX_INTERRUPTION_NOTICES_PER_ROOM = 2;

/**
 * Aelter als das darf ein Platzhalter nicht sein, um noch eine Meldung wert
 * zu sein. Eine Wiederherstellung nach einem Neustart dauert Sekunden; wer
 * nach sechs Stunden noch wartet, hat den Thread laengst verlassen.
 */
const INTERRUPTION_NOTICE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Teilt den Rueckstand in "muss raus" und "still abraeumen".
 *
 * Die Leitplanke: Eine fertige Antwort wird NIE verworfen — sie ist nicht
 * ersetzbar. Gedeckelt wird ausschliesslich die Abbruchmeldung, und zwar je
 * Raum, damit ein einzelner ueberlaufender Kanal nicht das ganze Budget
 * aufbraucht und die anderen Raeume stumm bleiben.
 */
export function planRecovery(
  entries: PendingReply[],
  now: number = Date.now()
): { deliver: PendingReply[]; discard: PendingReply[] } {
  const deliver: PendingReply[] = [];
  const discard: PendingReply[] = [];
  const noticesByRoom = new Map<string, PendingReply[]>();

  for (const entry of entries) {
    if (entry.finalText !== undefined) {
      deliver.push(entry);
      continue;
    }
    const startedAt = Date.parse(entry.startedAt);
    // Ein unlesbares Datum gilt als frisch: im Zweifel lieber melden als
    // eine echte Unterbrechung verschlucken.
    const age = Number.isNaN(startedAt) ? 0 : now - startedAt;
    if (age > INTERRUPTION_NOTICE_MAX_AGE_MS) {
      discard.push(entry);
      continue;
    }
    const bucket = noticesByRoom.get(entry.roomId) ?? [];
    bucket.push(entry);
    noticesByRoom.set(entry.roomId, bucket);
  }

  for (const bucket of noticesByRoom.values()) {
    // Die juengsten zuletzt: der Nutzer sieht die Meldung dort, wo er
    // zuletzt gewartet hat.
    const keep = bucket.slice(-MAX_INTERRUPTION_NOTICES_PER_ROOM);
    const drop = bucket.slice(0, Math.max(0, bucket.length - keep.length));
    deliver.push(...keep);
    discard.push(...drop);
  }

  return { deliver, discard };
}

/**
 * Clean up whatever the previous process left behind. Runs once per channel
 * start, before any new inbound is handled:
 *
 * - answer in hand → deliver it late rather than lose it;
 * - nothing to deliver → say so, so the placeholder stops pretending to work.
 *
 * Failures are kept, not dropped: a channel that is still unhealthy gets
 * another attempt at the next start instead of silently discarding an answer.
 */
export async function reconcilePendingReplies(params: {
  accountId: string;
  client: ReconcileClient;
  store: PendingReplyReader;
}): Promise<void> {
  const { accountId, client, store } = params;
  const entries = await store.list(accountId);
  if (entries.length === 0) {
    return;
  }

  const { deliver, discard } = planRecovery(entries);

  // Stillschweigend abraeumen, damit der Rueckstand nicht ueber den
  // naechsten Neustart weiterwaechst. Sichtbar bleibt es im Log, nicht im
  // Kundenchat.
  for (const entry of discard) {
    await store.settle(accountId, entry.messageId);
  }
  if (discard.length > 0) {
    console.warn(
      `[rocketchat:${accountId}] discarded ${discard.length} stale placeholder(s) without notifying the room`
    );
  }

  for (const entry of deliver) {
    const text = entry.finalText ?? INTERRUPTED_REPLY_FALLBACK;
    try {
      await client.updateMessage(entry.roomId, entry.messageId, text);
    } catch (error) {
      console.warn(
        `[rocketchat:${accountId}] could not recover placeholder ${entry.messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }

    if (entry.triggerMessageId && client.reactMessage) {
      const verdict = entry.finalText
        ? outcomeReaction(entry.outcome)
        : REACTION_ATTENTION;
      try {
        await client.reactMessage(entry.triggerMessageId, REACTION_WORKING, false);
        if (verdict) {
          await client.reactMessage(entry.triggerMessageId, verdict, true);
        }
      } catch {
        /* status reactions are cosmetic — never block the recovery */
      }
    }

    await store.settle(accountId, entry.messageId);
    console.warn(
      `[rocketchat:${accountId}] recovered placeholder ${entry.messageId} (${
        entry.finalText ? "delivered pending answer" : "marked as interrupted"
      })`
    );
  }
}

function outcomeReaction(outcome: ReplyOutcome | undefined): string | undefined {
  if (outcome === "done") return REACTION_DONE;
  if (outcome === "input") return REACTION_INPUT;
  if (outcome === "attention") return REACTION_ATTENTION;
  return undefined;
}
