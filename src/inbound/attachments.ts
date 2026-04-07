export type InboundAttachmentKind = "image" | "document" | "video" | "unknown";

export type InboundAttachment = {
  kind: InboundAttachmentKind;
  mimeType?: string;
  fileName?: string;
  url?: string;
  sizeBytes?: number;
  source: "rocketchat-attachment" | "rocketchat-file";
  raw: unknown;
};

type MessageAttachmentEnvelope = {
  attachments?: unknown[];
  file?: unknown;
  files?: unknown[];
};

type AttachmentRecord = {
  _id?: string;
  title?: string;
  title_link?: string;
  url?: string;
  image_url?: string;
  video_url?: string;
  audio_url?: string;
  type?: string;
  mimeType?: string;
  mimetype?: string;
  contentType?: string;
  name?: string;
  filename?: string;
  size?: number;
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v"]);
const DOCUMENT_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "txt",
  "md",
  "csv",
  "json"
]);
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain"
]);

export function normalizeInboundAttachments(
  inputs: unknown[],
  options?: {
    serverUrl?: string;
  }
): InboundAttachment[] {
  return inputs.map((input) => toInboundAttachment(input, options));
}

export function getMessageAttachmentInputs(message: MessageAttachmentEnvelope): unknown[] {
  const attachmentRecords = toAttachmentRecords(message.attachments ?? []);
  const fileRecords = toAttachmentRecords([
    ...(message.file ? [message.file] : []),
    ...(message.files ?? [])
  ]);
  const unmatchedAttachments = attachmentRecords.map((record) => ({
    record,
    used: false
  }));

  const mergedFiles = fileRecords.map((fileRecord) => {
    const matchIndex = findMatchingAttachmentIndex(fileRecord, unmatchedAttachments);
    if (matchIndex < 0) {
      return fileRecord;
    }

    unmatchedAttachments[matchIndex]!.used = true;
    return mergeAttachmentRecord(unmatchedAttachments[matchIndex]!.record, fileRecord);
  });

  return [
    ...mergedFiles,
    ...unmatchedAttachments.filter((entry) => !entry.used).map((entry) => entry.record)
  ];
}

function toInboundAttachment(
  input: unknown,
  options?: {
    serverUrl?: string;
  }
): InboundAttachment {
  const record = asAttachmentRecord(input);
  const mimeType = getMimeType(record);
  const url = getAttachmentUrl(record, options?.serverUrl);
  const fileName = getFileName(record, url);

  return {
    kind: classifyAttachment(mimeType, fileName),
    mimeType,
    fileName,
    url,
    sizeBytes: typeof record?.size === "number" ? record.size : undefined,
    source: isFileRecord(record) ? "rocketchat-file" : "rocketchat-attachment",
    raw: input
  };
}

function asAttachmentRecord(input: unknown): AttachmentRecord | null {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as AttachmentRecord;
  }

  return null;
}

function isFileRecord(record: AttachmentRecord | null): boolean {
  return Boolean(record?._id);
}

function toAttachmentRecords(inputs: unknown[]): AttachmentRecord[] {
  return inputs
    .map((input) => asAttachmentRecord(input))
    .filter((record): record is AttachmentRecord => record !== null);
}

function findMatchingAttachmentIndex(
  fileRecord: AttachmentRecord,
  attachments: Array<{ record: AttachmentRecord; used: boolean }>
): number {
  const fileName = getComparableFileName(fileRecord);
  if (fileName) {
    const exactIndex = attachments.findIndex(
      (entry) => !entry.used && getComparableFileName(entry.record) === fileName
    );
    if (exactIndex >= 0) {
      return exactIndex;
    }
  }

  const remainingIndexes = attachments
    .map((entry, index) => (entry.used ? -1 : index))
    .filter((index) => index >= 0);
  return remainingIndexes.length === 1 ? remainingIndexes[0]! : -1;
}

function mergeAttachmentRecord(
  attachmentRecord: AttachmentRecord,
  fileRecord: AttachmentRecord
): AttachmentRecord {
  return {
    ...attachmentRecord,
    ...fileRecord,
    _id: fileRecord._id ?? attachmentRecord._id,
    title: attachmentRecord.title ?? fileRecord.name ?? fileRecord.filename,
    title_link:
      attachmentRecord.title_link ??
      attachmentRecord.url ??
      fileRecord.title_link ??
      fileRecord.url,
    url:
      fileRecord.url ??
      attachmentRecord.url ??
      attachmentRecord.title_link ??
      fileRecord.title_link,
    type: fileRecord.type ?? attachmentRecord.type,
    mimeType: fileRecord.mimeType ?? attachmentRecord.mimeType,
    mimetype: fileRecord.mimetype ?? attachmentRecord.mimetype,
    contentType: fileRecord.contentType ?? attachmentRecord.contentType,
    name: fileRecord.name ?? attachmentRecord.name ?? attachmentRecord.filename ?? attachmentRecord.title,
    filename: fileRecord.filename ?? attachmentRecord.filename ?? fileRecord.name ?? attachmentRecord.title,
    size: fileRecord.size ?? attachmentRecord.size
  };
}

function getMimeType(record: AttachmentRecord | null): string | undefined {
  const value = record?.type ?? record?.mimeType ?? record?.mimetype ?? record?.contentType;
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : undefined;
}

function getAttachmentUrl(record: AttachmentRecord | null, serverUrl: string | undefined): string | undefined {
  const candidates = [
    record?.url,
    record?.title_link,
    record?.image_url,
    record?.video_url,
    record?.audio_url
  ];
  const rawUrl = candidates.find((value): value is string => typeof value === "string" && value.length > 0);
  return rawUrl ? resolveAttachmentUrl(rawUrl, serverUrl) : undefined;
}

function getFileName(record: AttachmentRecord | null, url: string | undefined): string | undefined {
  const candidates = [record?.title, record?.name, record?.filename];
  const directName = candidates.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  if (directName) {
    return directName.trim();
  }

  if (!url) {
    return undefined;
  }

  try {
    const path = new URL(url).pathname;
    const segment = path.split("/").filter(Boolean).at(-1);
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
}

function classifyAttachment(
  mimeType: string | undefined,
  fileName: string | undefined
): InboundAttachmentKind {
  if (mimeType?.startsWith("image/")) {
    return "image";
  }

  if (mimeType?.startsWith("video/")) {
    return "video";
  }

  if (mimeType?.startsWith("text/") || (mimeType && DOCUMENT_MIME_TYPES.has(mimeType))) {
    return "document";
  }

  const extension = getExtension(fileName);
  if (!extension) {
    return "unknown";
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return "document";
  }

  return "unknown";
}

function getComparableFileName(record: AttachmentRecord | null): string | undefined {
  const fileName = getFileName(record, getAttachmentUrl(record, undefined));
  return fileName?.trim().toLowerCase();
}

function getExtension(fileName: string | undefined): string | undefined {
  if (!fileName) {
    return undefined;
  }

  const cleanName = fileName.trim().toLowerCase();
  const lastDot = cleanName.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === cleanName.length - 1) {
    return undefined;
  }

  return cleanName.slice(lastDot + 1);
}

function resolveAttachmentUrl(url: string, serverUrl: string | undefined): string {
  try {
    return new URL(url).toString();
  } catch {
    if (!serverUrl) {
      return url;
    }
  }

  try {
    return new URL(url, serverUrl).toString();
  } catch {
    return url;
  }
}
