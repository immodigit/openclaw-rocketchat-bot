export const THINKING_PLACEHOLDER = "思考中...";
export const EMPTY_REPLY_FALLBACK = "未生成可发送的回复。";
export const TOOL_REPLY_FALLBACK = "正在调用工具...";
export const BLOCK_REPLY_FALLBACK = "正在生成回复...";
export const FAILED_REPLY_FALLBACK = "处理失败，请稍后重试。";

type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

export function formatFinalReply(reply: string): string {
  return reply.trim().length > 0 ? reply : EMPTY_REPLY_FALLBACK;
}

export function formatReplyUpdate(
  kind: "tool" | "block" | "final",
  payload: ReplyPayload
): string {
  const content = formatReplyPayload(payload);

  if (kind === "final") {
    return formatFinalReply(content);
  }

  if (content.length > 0) {
    return content;
  }

  return kind === "tool" ? TOOL_REPLY_FALLBACK : BLOCK_REPLY_FALLBACK;
}

export function formatReplyFailure(): string {
  return FAILED_REPLY_FALLBACK;
}

function formatReplyPayload(payload: ReplyPayload): string {
  const parts: string[] = [];
  const text = payload.text?.trim();
  if (text) {
    parts.push(text);
  }

  const mediaUrls = [
    ...(payload.mediaUrls ?? []),
    ...(payload.mediaUrl ? [payload.mediaUrl] : [])
  ].map((value) => value.trim()).filter((value) => value.length > 0);

  if (mediaUrls.length > 0) {
    parts.push(mediaUrls.join("\n"));
  }

  return parts.join("\n\n").trim();
}
