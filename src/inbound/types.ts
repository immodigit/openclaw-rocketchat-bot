import type { InboundAttachment } from "./attachments.js";

export type InboundEvent = {
  accountId: string;
  roomId: string;
  roomType: "direct" | "group" | "channel";
  messageId: string;
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
