import type { InboundAttachment } from "./attachments.js";

export type InboundEvent = {
  accountId: string;
  roomId: string;
  roomType: "direct" | "group" | "channel";
  messageId: string;
  /**
   * Thread message id of the incoming message. `null` for top-level
   * messages. Used to keep bot replies inside the same thread.
   */
  tmid: string | null;
  senderId: string;
  senderName: string;
  text: string;
  mentions: string[];
  attachments: InboundAttachment[];
  sentAt: string;
  raw: unknown;
};

export type InboundTransport = {
  kind(): "polling" | "websocket";
  start(): Promise<void>;
  stop(): Promise<void>;
};
