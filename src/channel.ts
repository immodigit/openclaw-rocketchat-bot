import { formatReplyFailure, formatReplyUpdate, THINKING_PLACEHOLDER } from "./format.js";
import type { InboundEvent } from "./inbound/types.js";

type ChannelRuleOptions = {
  botUserId: string;
  mentionNames: string[];
};

type ReplyClient = {
  postMessage(roomId: string, text: string): Promise<string>;
  updateMessage(roomId: string, messageId: string, text: string): Promise<void>;
};

type SendReplyLifecycleOptions = {
  client: ReplyClient;
  roomId: string;
} & (
  | {
      finalText: string;
      run?: never;
    }
  | {
      finalText?: never;
      run(session: ReplySession): Promise<void>;
    }
);

type ReplyStageKind = "tool" | "block" | "final";

type ReplyStagePayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

type ReplySession = {
  messageId: string;
  update(params: { kind: ReplyStageKind; payload: ReplyStagePayload }): Promise<void>;
  hasFinalUpdate(): boolean;
  fail(error: unknown): Promise<void>;
};

export function shouldHandleInboundEvent(
  event: InboundEvent,
  options: ChannelRuleOptions
): boolean {
  if (event.senderId === options.botUserId) {
    return false;
  }

  if (event.roomType === "direct") {
    return true;
  }

  const aliases = options.mentionNames.map(normalizeMention);
  const explicitMentions = event.mentions.map(normalizeMention);
  if (explicitMentions.some((mention) => aliases.includes(mention))) {
    return true;
  }

  const normalizedText = event.text.toLowerCase();
  return aliases.some((alias) => normalizedText.includes(`@${alias}`));
}

export async function sendReplyLifecycle(
  options: SendReplyLifecycleOptions
): Promise<string> {
  const session = await createReplySession(options.client, options.roomId);

  try {
    if (typeof options.run === "function") {
      await options.run(session);
      if (!session.hasFinalUpdate()) {
        await session.update({
          kind: "final",
          payload: {}
        });
      }
    } else {
      await session.update({
        kind: "final",
        payload: {
          text: options.finalText
        }
      });
    }
  } catch (error) {
    await session.fail(error);
    throw error;
  }

  return session.messageId;
}

function normalizeMention(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

async function createReplySession(client: ReplyClient, roomId: string): Promise<ReplySession> {
  const messageId = await client.postMessage(roomId, THINKING_PLACEHOLDER);
  let finalUpdated = false;

  return {
    messageId,
    update: async ({ kind, payload }) => {
      if (kind === "final") {
        finalUpdated = true;
      }
      await client.updateMessage(roomId, messageId, formatReplyUpdate(kind, payload));
    },
    hasFinalUpdate: () => finalUpdated,
    fail: async (_error) => {
      await client.updateMessage(roomId, messageId, formatReplyFailure());
    }
  };
}
