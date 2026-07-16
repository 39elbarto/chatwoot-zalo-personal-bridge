import path from "path";

export type MediaMetadataInput = {
  fileName?: string;
  mediaUrl?: string;
  contentTypeHint?: string;
  responseContentType?: string;
  buffer: Buffer;
  fallbackBase?: string;
};

export type ResolvedMediaMetadata = {
  fileName: string;
  contentType: string;
};

const MIME_TO_EXTENSION: Record<string, string> = {
  "application/pdf": "pdf",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const EXTENSION_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  aac: "audio/aac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
};

function normalizeContentType(value?: string): string | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || undefined;
}

function isGenericContentType(value?: string): boolean {
  return !value || value === "application/octet-stream" || value === "binary/octet-stream";
}

function extensionOf(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const ext = path.extname(fileName).slice(1).trim().toLowerCase();
  return ext && ext !== "bin" ? ext : undefined;
}

function fileNameFromUrl(mediaUrl?: string): string | undefined {
  if (!mediaUrl) return undefined;
  try {
    const last = path.basename(new URL(mediaUrl).pathname);
    return last && extensionOf(last) ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

export function detectMediaContentType(buffer: Buffer): string | undefined {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.length >= 6) {
    const gif = buffer.subarray(0, 6).toString("ascii");
    if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

export function resolveMediaMetadata(input: MediaMetadataInput): ResolvedMediaMetadata {
  const requestedName = input.fileName?.trim();
  const urlName = fileNameFromUrl(input.mediaUrl);
  const requestedExtension = extensionOf(requestedName);
  const nameExtension = requestedExtension || extensionOf(urlName);
  const nameContentType = nameExtension ? EXTENSION_TO_MIME[nameExtension] : undefined;
  const hintedContentType = normalizeContentType(input.contentTypeHint);
  const responseContentType = normalizeContentType(input.responseContentType);
  const detectedContentType = detectMediaContentType(input.buffer);
  const contentType =
    nameContentType ||
    (!isGenericContentType(hintedContentType) ? hintedContentType : undefined) ||
    (!isGenericContentType(responseContentType) ? responseContentType : undefined) ||
    detectedContentType ||
    hintedContentType ||
    responseContentType ||
    "application/octet-stream";

  if (requestedExtension && requestedName) return { fileName: requestedName, contentType };

  const extension = MIME_TO_EXTENSION[contentType] || "bin";
  if (!requestedName && urlName) return { fileName: urlName, contentType };
  const base = requestedName?.replace(/\.bin$/i, "") || input.fallbackBase || "file";
  return { fileName: `${base}.${extension}`, contentType };
}
