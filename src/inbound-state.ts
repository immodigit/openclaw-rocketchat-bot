/**
 * Per-room cache of the last inbound message we received. The outbound
 * sendText path consults this when the agent reaches for the `send` tool
 * and we need to anchor the reply to the thread that triggered it.
 *
 * The cache is in-process only — it is intentionally not persisted because
 * the anchor only matters while a conversation window is still warm, and
 * we want the bot to restart cleanly into a fresh state after a crash.
 */

export type InboundAnchor = {
  messageId: string;
  /** Parent thread id of the inbound. `null` if the inbound was top-level. */
  tmid: string | null;
};

const lastInboundByRoom = new Map<string, InboundAnchor>();

export function recordInboundAnchor(roomId: string, anchor: InboundAnchor): void {
  if (!roomId) return;
  lastInboundByRoom.set(roomId, anchor);
}

export function getInboundAnchor(roomId: string): InboundAnchor | undefined {
  return lastInboundByRoom.get(roomId);
}

export function clearInboundAnchor(roomId: string): void {
  lastInboundByRoom.delete(roomId);
}
