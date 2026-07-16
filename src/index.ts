import dotenv from "dotenv";
import { ChatwootClient } from "./chatwootClient";
import { ZaloPersonalClient } from "./zaloClient";
import { OutgoingCache } from "./outgoingCache";
import { createServer } from "./server";
import { contentKey } from "./messageKeys";
import { MessageMapStore } from "./messageMapStore";
import { MappingAwareMap, RecallCoordinator } from "./recallCoordinator";
import {
  normalizeActionlistSystemMessage,
  normalizeCalltimeSystemMessage,
  normalizeMisscallSystemMessage,
  normalizeRecommendedLinkMessage,
  normalizeRecommendedUserMessage,
  normalizeShowProfileSystemMessage,
} from "./zaloSystemMessages";

dotenv.config();

const PORT = Number(process.env.PORT || "4001");
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || "";
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN || "";
const CHATWOOT_ACCOUNT_ID = Number(process.env.CHATWOOT_ACCOUNT_ID || "0");
const CHATWOOT_INBOX_ID = Number(process.env.CHATWOOT_INBOX_ID || "0");
const CHATWOOT_INBOX_IDENTIFIER = process.env.CHATWOOT_INBOX_IDENTIFIER || "";
const CHATWOOT_INSTANCE_KEY = process.env.CHATWOOT_INSTANCE_KEY || "";
const CHATWOOT_CONTACT_IDENTIFIER_PREFIX = process.env.CHATWOOT_CONTACT_IDENTIFIER_PREFIX || "";
const CHATWOOT_CONTACT_IDENTIFIER_LEGACY_PREFIXES = process.env.CHATWOOT_CONTACT_IDENTIFIER_LEGACY_PREFIXES || "";
const CHATWOOT_SOURCE_ID_PREFIX = process.env.CHATWOOT_SOURCE_ID_PREFIX || "";

const ZALO_IMEI = process.env.ZALO_IMEI || "";
const ZALO_USER_AGENT = process.env.ZALO_USER_AGENT || "";
const ZALO_LANGUAGE = process.env.ZALO_LANGUAGE || "vi";
const ZALO_COOKIE_JSON = process.env.ZALO_COOKIE_JSON || "";
const ZALO_SESSION_FILE = process.env.ZALO_SESSION_FILE || "./data/session.json";
const ZALO_MENTIONS_CONFIG_FILE = process.env.ZALO_MENTIONS_CONFIG_FILE || "./data/zalo-mentions.json";

if (!CHATWOOT_BASE_URL || !CHATWOOT_API_TOKEN || !CHATWOOT_ACCOUNT_ID || !CHATWOOT_INBOX_ID || !CHATWOOT_INBOX_IDENTIFIER) {
  throw new Error("Chatwoot env vars are required (BASE_URL, API_TOKEN, ACCOUNT_ID, INBOX_ID, INBOX_IDENTIFIER)");
}
if (!ZALO_IMEI || !ZALO_USER_AGENT || !ZALO_COOKIE_JSON) {
  throw new Error("ZALO_IMEI, ZALO_USER_AGENT and ZALO_COOKIE_JSON must be set");
}

async function bootstrap() {
  const cache = new OutgoingCache();
  const threadMap = new Map<number, string>();
  type RuntimeMessageMapping = {
    conversationId: number;
    cwId: number;
    preview: string;
    sender?: "self" | "contact";
    quote?: Record<string, unknown>;
  };
  let recallCoordinator: RecallCoordinator | null = null;
  const messageMap = new MappingAwareMap<RuntimeMessageMapping>((zaloMsgId) => {
    if (recallCoordinator) void recallCoordinator.mappingAvailable(zaloMsgId);
  }); // Zalo msgId -> Chatwoot message id + preview
  const captionBuffer = new Map<string, { text: string; exp: number; used: boolean; isSelf: boolean }>(); // key: threadId
  const groupThreadIds = new Set<string>(); // raw Zalo group threadIds we have seen (used to route self events correctly)
  const groupInferenceCache = new Map<string, { isGroup: boolean; exp: number }>();
  const threadKindLogCount = new Map<string, number>();
  const messageStore = new MessageMapStore();
  await messageStore.load();

  const resolveReplyTarget = async (conversationId: number, targetZaloMsgId?: string) => {
    if (!targetZaloMsgId) return null;
    const cached = messageMap.get(targetZaloMsgId) || messageStore.get(targetZaloMsgId) || null;
    if (cached) return cached;
    const lookedUp = await chatwootClient.findMessageByZaloMsgId(conversationId, targetZaloMsgId);
    if (!lookedUp) {
      console.log("[zalo-reply-lookup]", { zaloTarget: targetZaloMsgId, cwId: null });
      return null;
    }
    console.log("[zalo-reply-lookup]", { zaloTarget: targetZaloMsgId, cwId: lookedUp.cwId });
    return { conversationId, cwId: lookedUp.cwId, preview: lookedUp.preview };
  };

  const replyContextPrefix = (
    event: { targetMsgId?: string; targetPreview?: string },
    target?: { cwId: number; preview?: string } | null,
  ) => {
    if (!event.targetMsgId) return "";
    const raw = (target?.preview || event.targetPreview || "").trim();
    const firstLine = raw.split(/\r?\n/)[0]?.replace(/^\[|\]$/g, "").trim();
    if (firstLine && /^Zalo (image|photo|gif|sticker|file|video|voice|audio) ref \w+/i.test(firstLine)) {
      return `[Reply to ${firstLine}]\n`;
    }
    const isMedia = /^(image|photo|gif|sticker|file|video|voice|audio)\b/i.test(raw) || raw.toUpperCase() === "IMAGE";
    if (target && isMedia) {
      const rawKind = raw.split(/\s+/)[0] || "media";
      const kind = rawKind.charAt(0).toUpperCase() + rawKind.slice(1).toLowerCase();
      return `[Reply to ${kind} #${target.cwId}]\n`;
    }
    if (target || !raw) return "";
    const label = raw.length <= 120 ? raw : "earlier message";
    return `[Reply to ${label}]\n`;
  };

  const ensureFileName = (
    candidate: string | undefined,
    url?: string,
    fallbackBase?: string,
    fallbackExt?: string,
  ) => {
    if (candidate && candidate.includes(".")) return candidate;
    if (url) {
      try {
        const parsed = new URL(url);
        const last = parsed.pathname.split("/").pop() || "";
        if (last.includes(".")) return last;
      } catch {
        // ignore
      }
    }
    const base = fallbackBase || "file";
    const ext = fallbackExt || "bin";
    return `${base}.${ext}`;
  };

  const mediaPlaceholder = (type: string) => {
    if (type === "image") return "IMAGE";
    if (type === "gif") return "GIF";
    if (type === "sticker") return "STICKER";
    return "FILE";
  };

  const mediaFallbackBase = (
    type: string,
    placeholder: string,
    stickerId?: string,
    msgId?: string,
  ) => {
    if (type === "sticker") return `sticker-${stickerId || msgId}`;
    return placeholder.toLowerCase();
  };

  const mediaFallbackExt = (type: string) => {
    if (type === "sticker") return "webp";
    if (type === "gif") return "gif";
    if (type === "image") return "jpg";
    return "bin";
  };

  const mediaContentTypeHint = (type: string, fileName: string) => {
    if (type === "sticker") return "image/webp";
    if (type === "gif") return "image/gif";
    if (type === "image") return inferContentTypeHint(fileName, "image/jpeg");
    return inferContentTypeHint(fileName, "application/octet-stream");
  };

  const mediaChatwootType = (type: string): "image" | "file" => {
    if (type === "image" || type === "gif" || type === "sticker") return "image";
    return "file";
  };

  const mediaPreviewLabel = (type: string) => {
    if (type === "image") return "Image";
    if (type === "gif") return "GIF";
    if (type === "sticker") return "Sticker";
    return "File";
  };

  const shortZaloRef = (msgId?: string) => {
    const raw = String(msgId || "").replace(/\D/g, "");
    return raw.slice(-6) || "unknown";
  };

  const mediaKindLabel = (type: string) => {
    if (type === "image") return "image";
    if (type === "gif") return "gif";
    if (type === "sticker") return "sticker";
    return "file";
  };

  const mediaRefLabel = (type: string, msgId?: string) => `Zalo ${mediaKindLabel(type)} ref ${shortZaloRef(msgId)}`;

  const mediaContentWithRef = (type: string, msgId: string | undefined, caption?: string | null) => {
    const ref = `[${mediaRefLabel(type, msgId)}]`;
    const cleanCaption = (caption || "").trim();
    return cleanCaption ? `${ref}\n${cleanCaption}` : ref;
  };

  const inferContentTypeHint = (fileName: string, fallback?: string) => {
    const ext = fileName.split(".").pop()?.toLowerCase();
    if (ext === "png") return "image/png";
    if (ext === "webp") return "image/webp";
    if (ext === "gif") return "image/gif";
    if (ext === "jpeg" || ext === "jpg") return "image/jpeg";
    if (ext === "mp4") return "video/mp4";
    if (ext === "mov") return "video/quicktime";
    if (ext === "webm") return "video/webm";
    if (ext === "mkv") return "video/x-matroska";
    if (ext === "aac") return "audio/aac";
    if (ext === "m4a") return "audio/mp4";
    if (ext === "mp3") return "audio/mpeg";
    if (ext === "ogg") return "audio/ogg";
    if (ext === "wav") return "audio/wav";
    if (ext === "pdf") return "application/pdf";
    if (ext === "doc") return "application/msword";
    if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (ext === "xls") return "application/vnd.ms-excel";
    if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (ext === "ppt") return "application/vnd.ms-powerpoint";
    if (ext === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    if (ext === "txt") return "text/plain";
    return fallback;
  };

  const applyRtfStylesToMarkdown = (text: string, styles: any): string => {
    if (!text || !Array.isArray(styles) || styles.length === 0) return text;

    type InlineStyle = "b" | "i" | "s" | "u";
    type BlockStyle = "lst_1" | "lst_2";

    const markdownTokens: Partial<Record<InlineStyle, string>> = {
      b: "**",
      i: "*",
      s: "~~",
    };

    const openOrder: InlineStyle[] = ["b", "i", "u", "s"];
    const closeOrder: InlineStyle[] = [...openOrder].reverse();

    const startAt = new Map<number, Set<InlineStyle>>();
    const endAt = new Map<number, Set<InlineStyle>>();
    const addAt = (map: Map<number, Set<InlineStyle>>, idx: number, st: InlineStyle) => {
      const set = map.get(idx) || new Set<InlineStyle>();
      set.add(st);
      map.set(idx, set);
    };

    const parsedStyles: Array<{ start: number; end: number; st: string }> = [];
    for (const s of styles) {
      if (!s || typeof s !== "object") continue;
      if (typeof s?.start !== "number" || typeof s?.len !== "number") continue;
      const start = Math.max(0, Math.floor(s.start));
      const len = Math.max(0, Math.floor(s.len));
      const end = Math.min(text.length, start + len);
      if (!len || start >= text.length || end <= start) continue;
      parsedStyles.push({ start, end, st: String(s.st || "") });
    }

    for (const s of parsedStyles) {
      const st = s.st as InlineStyle;
      if (!["b", "i", "u", "s"].includes(st)) continue;
      addAt(startAt, s.start, st);
      addAt(endAt, s.end, st);
    }

    // Precompute line prefixes for lists/indentation. Indent is encoded as "ind_10" meaning indentSize=1.
    const linePrefixes = new Map<number, string>();
    const lineStarts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") lineStarts.push(i + 1);
    }

    let orderedCounter = 0;
    for (const lineStart of lineStarts) {
      // Determine a stable "anchor" position inside the line to test style coverage.
      let anchor = lineStart;
      while (anchor < text.length && text[anchor] === " ") anchor++;

      const covered = (st: string) => parsedStyles.some((s) => s.st === st && s.start <= anchor && anchor < s.end);
      const listUnordered = covered("lst_1");
      const listOrdered = covered("lst_2");
      const indentStyle = parsedStyles.find((s) => s.st.startsWith("ind_") && s.start <= anchor && anchor < s.end)?.st;

      let indent = "";
      if (indentStyle) {
        const m = indentStyle.match(/^ind_(\d+)$/);
        if (m) {
          const raw = Number(m[1]);
          if (!Number.isNaN(raw)) {
            const level = Math.max(0, Math.round(raw / 10));
            indent = "  ".repeat(level);
          }
        }
      }

      let prefix = "";
      if (listOrdered) {
        orderedCounter += 1;
        prefix = `${orderedCounter}. `;
      } else {
        orderedCounter = 0;
        if (listUnordered) prefix = "- ";
      }
      if (indent || prefix) {
        linePrefixes.set(lineStart, `${indent}${prefix}`);
      }
    }

    const active = new Set<InlineStyle>();
    let out = "";
    for (let i = 0; i <= text.length; i++) {
      const ends = endAt.get(i);
      if (ends && ends.size) {
        for (const st of closeOrder) {
          if (ends.has(st) && active.has(st)) {
            out += markdownTokens[st] || "";
            active.delete(st);
          }
        }
      }

      const prefix = linePrefixes.get(i);
      if (prefix) out += prefix;

      const starts = startAt.get(i);
      if (starts && starts.size) {
        for (const st of openOrder) {
          if (starts.has(st) && !active.has(st)) {
            out += markdownTokens[st] || "";
            active.add(st);
          }
        }
      }

      if (i < text.length) {
        const ch = text[i];
        if (active.has("u") && ch !== "\n" && ch !== "\r") {
          out += `${ch}\u0332`;
        } else {
          out += ch;
        }
      }
    }

    // If the input had inconsistent ranges, close anything left open to avoid broken markdown.
    if (active.size) {
      for (const st of closeOrder) {
        if (!active.has(st)) continue;
        out += markdownTokens[st] || "";
      }
    }
    return out;
  };

  const attachmentEchoKey = (threadId: string, text: string) => `cwatt:${contentKey(threadId, text)}`;
  const cwTextKey = (threadId: string, text: string) => `cwtext:${contentKey(threadId, text)}`;
  const recentAttachmentKey = (threadId: string, fileName: string) => `cwatt_recent:${threadId}:${fileName}`;

  const chatwootClient = new ChatwootClient({
    baseUrl: CHATWOOT_BASE_URL,
    apiToken: CHATWOOT_API_TOKEN,
    accountId: CHATWOOT_ACCOUNT_ID,
    inboxId: CHATWOOT_INBOX_ID,
    inboxIdentifier: CHATWOOT_INBOX_IDENTIFIER,
    instanceKey: CHATWOOT_INSTANCE_KEY || undefined,
    contactIdentifierPrefix: CHATWOOT_CONTACT_IDENTIFIER_PREFIX || undefined,
    contactIdentifierLegacyPrefixes: CHATWOOT_CONTACT_IDENTIFIER_LEGACY_PREFIXES
      ? CHATWOOT_CONTACT_IDENTIFIER_LEGACY_PREFIXES.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    conversationSourceIdPrefix: CHATWOOT_SOURCE_ID_PREFIX || undefined,
  });

  const zaloClient = new ZaloPersonalClient({
    imei: ZALO_IMEI,
    userAgent: ZALO_USER_AGENT,
    language: ZALO_LANGUAGE,
    cookieJson: ZALO_COOKIE_JSON,
    sessionFile: ZALO_SESSION_FILE,
  });

  recallCoordinator = new RecallCoordinator({
    lookup: (zaloMsgId) => messageMap.get(zaloMsgId) || messageStore.get(zaloMsgId),
    deleteMessage: (conversationId, cwId) => chatwootClient.deleteMessage(conversationId, cwId),
    onDeleted: (zaloMsgId) => {
      messageMap.delete(zaloMsgId);
      messageStore.delete(zaloMsgId);
    },
  });

  await zaloClient.connect();

  zaloClient.onEvent(async (event) => {
    try {
      if (event.type === "undo") {
        if (!event.targetMsgId) {
          console.warn("[zalo-recall-missing-target]", { msgId: event.msgId, threadId: event.threadId });
          return;
        }
        await recallCoordinator?.recall({ targetMsgId: event.targetMsgId, threadId: event.threadId });
        return;
      }

      if (event.type === "image") {
        console.log("[zalo-image-debug]", {
          isSelf: event.isSelf,
          type: event.type,
          text: (event as any).text ?? null,
          message: (event as any).message ?? null,
          caption: (event as any).caption ?? null,
          rawKeys: Object.keys(event as any),
        });
      }

      const maybeGroupByIds = !!event.threadId && !!event.fromId && event.threadId !== event.fromId;
      // IMPORTANT: do NOT treat "self + fromId!=threadId" as group. In 1:1 chats fromId is self UID and threadId is peer UID,
      // so fromId!=threadId is expected and must not create group contacts.
      let inferredGroupInfo: { name?: string; avatarUrl?: string } | null = null;
      let isGroupThread = (!event.isSelf && maybeGroupByIds) || groupThreadIds.has(event.threadId);
      if (!event.isSelf && maybeGroupByIds) {
        groupThreadIds.add(event.threadId);
        isGroupThread = true;
      }

      // For self events we can’t rely on fromId/threadId comparison (it’s also true in 1:1),
      // so we do a cached best-effort group lookup to avoid misrouting group echoes as 1:1.
      if (!isGroupThread && event.isSelf && maybeGroupByIds) {
        const cached = groupInferenceCache.get(event.threadId);
        if (cached && cached.exp > Date.now()) {
          isGroupThread = cached.isGroup;
          if (cached.isGroup) groupThreadIds.add(event.threadId);
        } else {
          try {
            inferredGroupInfo = await zaloClient.fetchGroup(event.threadId);
            const isGroup = !!(inferredGroupInfo && (inferredGroupInfo.name || inferredGroupInfo.avatarUrl));
            groupInferenceCache.set(event.threadId, { isGroup, exp: Date.now() + 24 * 60 * 60 * 1000 });
            if (isGroup) {
              groupThreadIds.add(event.threadId);
              isGroupThread = true;
            }
          } catch {
            groupInferenceCache.set(event.threadId, { isGroup: false, exp: Date.now() + 24 * 60 * 60 * 1000 });
          }
        }
      }

      const derivedIsSelf = event.isSelf;

      const logKey = `${event.threadId}`;
      const prev = threadKindLogCount.get(logKey) || 0;
      threadKindLogCount.set(logKey, prev + 1);
      const shouldLogKind = (maybeGroupByIds || isGroupThread) && (prev < 3 || (prev + 1) % 50 === 0);
      if (shouldLogKind) {
        console.log("[zalo-thread-classify]", {
          threadId: event.threadId,
          fromId: event.fromId,
          isSelf: event.isSelf,
          maybeGroupByIds,
          isGroupThread,
          seenAsGroup: groupThreadIds.has(event.threadId),
          type: event.type,
        });
      }

      let groupInfo: { name?: string; avatarUrl?: string } | null = inferredGroupInfo;
      if (isGroupThread && !groupInfo) groupInfo = await zaloClient.fetchGroup(event.threadId);

      const groupName =
        (event.threadDisplayName && event.threadDisplayName.trim()) ||
        (groupInfo?.name && groupInfo.name.trim()) ||
        "";

      let senderName =
        (event.displayName && event.displayName.trim()) ||
        (!derivedIsSelf && event.fromId ? `Member ${event.fromId.slice(-4)}` : "") ||
        "";

      if (isGroupThread && !derivedIsSelf && senderName.startsWith("Member ") && event.fromId) {
        const profile = await zaloClient.fetchProfile(event.fromId);
        if (profile?.displayName) senderName = profile.displayName;
      }

      const groupPrefix = isGroupThread && !derivedIsSelf ? (senderName ? `${senderName}: ` : "Group: ") : "";
      const applyGroupPrefix = (value: string) => (groupPrefix ? `${groupPrefix}${value}` : value);
      let peerZaloId = event.fromId;
      if (isGroupThread) {
        peerZaloId = `group:${event.threadId}`;
      } else if (event.isSelf) {
        peerZaloId = event.threadId;
      }
      const peerDisplayName = isGroupThread
        ? groupName || `Zalo group ${event.threadId.slice(-4)}`
        : event.isSelf
        ? event.threadDisplayName || event.displayName
        : event.displayName || event.threadDisplayName;
      let name = peerDisplayName;
      let avatar = event.avatarUrl;

      if (isGroupThread) {
        avatar = avatar || groupInfo?.avatarUrl;
      } else if (!derivedIsSelf && !avatar) {
        const profile = await zaloClient.fetchProfile(peerZaloId);
        if (profile?.displayName && !name) name = profile.displayName;
        if (profile?.avatarUrl) avatar = profile.avatarUrl;
      }

      if (!derivedIsSelf) {
        console.log("[ensureContact]", {
          peerZaloId,
          name: name || null,
          avatarUrl: avatar || null,
        });
      }

      const chatwootThreadId = isGroupThread ? `group:${event.threadId}` : event.threadId;
      const { conversationId, sourceId } = await chatwootClient.ensureContactAndConversation(peerZaloId, {
        threadId: chatwootThreadId,
        name,
        avatarUrl: avatar,
        isSelf: derivedIsSelf,
        isGroup: isGroupThread,
        groupName: isGroupThread ? groupName || name : undefined,
      });
      threadMap.set(conversationId, chatwootThreadId);

      if (event.type === "reaction") {
        const reactionLabel = event.reactionType ? String(event.reactionType) : "reaction";
        let target =
          event.targetMsgId
            ? messageMap.get(event.targetMsgId) ||
              messageStore.get(event.targetMsgId) ||
              null
            : null;
        if (!target && event.targetMsgId) {
          const lookedUp = await chatwootClient.findMessageByZaloMsgId(conversationId, event.targetMsgId);
          if (lookedUp) {
            console.log("[zalo-reaction-lookup]", {
              zaloTarget: event.targetMsgId,
              cwId: lookedUp.cwId,
            });
            target = { conversationId, cwId: lookedUp.cwId, preview: lookedUp.preview };
          } else {
            console.log("[zalo-reaction-lookup]", { zaloTarget: event.targetMsgId, cwId: null });
          }
        }
        let actor = event.isSelf ? "You (via Zalo)" : (peerDisplayName || name || peerZaloId);
        if (!derivedIsSelf) {
          const profile = await zaloClient.fetchProfile(event.fromId);
          if (profile?.displayName) actor = profile.displayName;
        }
        console.log("[zalo-reaction-note]", {
          actorName: actor,
          isSelf: derivedIsSelf,
          snippet: target?.preview,
          chatwootMessageId: target?.cwId,
        });
        await chatwootClient.createReactionNote(conversationId, {
          actorName: actor,
          reactionType: reactionLabel,
          replyToId: target?.cwId || undefined,
          preview: target?.preview,
          targetZaloMsgId: event.targetMsgId,
        });
        return;
      }

      // Normalize Zalo system "actionlist" cards (e.g., friend request accepted) into short private notes.
      if (event.type === "text" && event.text && event.text.trim().startsWith("{")) {
        const systemNormalized = normalizeActionlistSystemMessage(event.text);
        if (systemNormalized) {
          console.log("[zalo-system-actionlist] parsed friend notification", {
            threadId: event.threadId,
            msgId: event.msgId,
            friendName: systemNormalized.friendName,
            langUsed: systemNormalized.langUsed,
            preview: (systemNormalized.finalText || systemNormalized.content).slice(0, 80),
          });
          const cwId = await chatwootClient.createSystemNote(conversationId, {
            content: systemNormalized.content,
            metadata: {
              source: "zalo_system_actionlist",
              zalo_action: "msginfo.actionlist",
              msgId: event.msgId,
              threadId: event.threadId,
              friendName: systemNormalized.friendName,
              langUsed: systemNormalized.langUsed,
            },
          });
          if (cwId) {
            messageMap.set(event.msgId, { conversationId, cwId, preview: systemNormalized.content.slice(0, 80) });
            messageStore.set(event.msgId, { conversationId, cwId, preview: systemNormalized.content.slice(0, 80) });
          }
          return;
        }
        const showProfile = normalizeShowProfileSystemMessage(event.text);
        if (showProfile) {
          console.log("[zalo-system-show-profile] parsed friend notification", {
            threadId: event.threadId,
            msgId: event.msgId,
            friendName: showProfile.friendName,
            preview: (showProfile.finalText || showProfile.content).slice(0, 80),
          });
          const cwId = await chatwootClient.createSystemNote(conversationId, {
            content: showProfile.content,
            metadata: {
              source: "zalo_system_show_profile",
              zalo_action: "show.profile",
              msgId: event.msgId,
              threadId: event.threadId,
              friendName: showProfile.friendName,
            },
          });
          if (cwId) {
            messageMap.set(event.msgId, { conversationId, cwId, preview: showProfile.content.slice(0, 80) });
            messageStore.set(event.msgId, { conversationId, cwId, preview: showProfile.content.slice(0, 80) });
          }
          return;
        }
        const calltime = normalizeCalltimeSystemMessage(event.text);
        if (calltime) {
          console.log("[zalo-system-calltime] parsed call notification", {
            threadId: event.threadId,
            msgId: event.msgId,
            durationSec: calltime.durationSec ?? null,
            isCaller: typeof calltime.isCaller === "boolean" ? calltime.isCaller : null,
            callType: calltime.callType ?? null,
            preview: (calltime.finalText || calltime.content).slice(0, 80),
          });
          const cwId = await chatwootClient.createSystemNote(conversationId, {
            content: calltime.content,
            metadata: {
              source: "zalo_system_calltime",
              zalo_action: "recommened.calltime",
              msgId: event.msgId,
              threadId: event.threadId,
              durationSec: calltime.durationSec ?? undefined,
              isCaller: typeof calltime.isCaller === "boolean" ? calltime.isCaller : undefined,
              callType: calltime.callType ?? undefined,
            },
          });
          if (cwId) {
            messageMap.set(event.msgId, { conversationId, cwId, preview: calltime.content.slice(0, 80) });
            messageStore.set(event.msgId, { conversationId, cwId, preview: calltime.content.slice(0, 80) });
          }
          return;
        }
        const misscall = normalizeMisscallSystemMessage(event.text);
        if (misscall) {
          console.log("[zalo-system-misscall] parsed missed call notification", {
            threadId: event.threadId,
            msgId: event.msgId,
            reason: typeof misscall.reason === "number" ? misscall.reason : null,
            isCaller: typeof misscall.isCaller === "boolean" ? misscall.isCaller : null,
            callType: misscall.callType ?? null,
            preview: (misscall.finalText || misscall.content).slice(0, 80),
          });
          const cwId = await chatwootClient.createSystemNote(conversationId, {
            content: misscall.content,
            metadata: {
              source: "zalo_system_misscall",
              zalo_action: "recommened.misscall",
              msgId: event.msgId,
              threadId: event.threadId,
              reason: typeof misscall.reason === "number" ? misscall.reason : undefined,
              isCaller: typeof misscall.isCaller === "boolean" ? misscall.isCaller : undefined,
              callType: misscall.callType ?? undefined,
            },
          });
          if (cwId) {
            messageMap.set(event.msgId, { conversationId, cwId, preview: misscall.content.slice(0, 80) });
            messageStore.set(event.msgId, { conversationId, cwId, preview: misscall.content.slice(0, 80) });
          }
          return;
        }
      }

      // Detect rich file payload encoded as text JSON from Zalo (e.g., PDFs)
      if (event.type === "text" && event.text && event.text.trim().startsWith("{")) {
        const rawText = event.text.trim();

        const recommendedUser = normalizeRecommendedUserMessage(rawText);
        if (recommendedUser) {
          const baseContent = groupPrefix ? applyGroupPrefix(recommendedUser.content) : recommendedUser.content;
          const content = derivedIsSelf ? `📱 [Sent from Zalo app]\n${baseContent}` : baseContent;
          console.log("[zalo-recommened-user-detected]", {
            msgId: event.msgId,
            threadId: event.threadId,
            isSelf: derivedIsSelf,
            hasPhone: !!recommendedUser.phone,
            hasQr: !!recommendedUser.qrCodeUrl,
            titlePreview: (recommendedUser.title || "").slice(0, 60) || null,
          });

          if (recommendedUser.qrCodeUrl) {
            const fileName = ensureFileName(undefined, recommendedUser.qrCodeUrl, `zalo-qr-${event.msgId}`, "jpg");
            const hint = inferContentTypeHint(fileName, "image/jpeg");
            const cwId = await chatwootClient.createIncomingMediaMessage({
              conversationId,
              content,
              mediaUrl: recommendedUser.qrCodeUrl,
              fileName,
              type: "image",
              contentTypeHint: hint,
              zaloMsgId: event.msgId,
              messageType: derivedIsSelf ? "outgoing" : "incoming",
              isPrivate: derivedIsSelf,
            });
            if (cwId) {
              messageMap.set(event.msgId, { conversationId, cwId, preview: baseContent.slice(0, 80) });
              messageStore.set(event.msgId, { conversationId, cwId, preview: baseContent.slice(0, 80) });
              if (derivedIsSelf) cache.add(event.msgId);
              return;
            }
          }

          if (derivedIsSelf) {
            const cwId = await chatwootClient.createAgentMessageFromNative(conversationId, {
              content,
              metadata: { source: "zalo_native", zalo_event: "recommened.user", msgId: event.msgId, threadId: event.threadId },
            });
            if (cwId) {
              messageMap.set(event.msgId, { conversationId, cwId, preview: baseContent.slice(0, 80) });
              messageStore.set(event.msgId, { conversationId, cwId, preview: baseContent.slice(0, 80) });
            }
            cache.add(event.msgId);
            return;
          }

          const cwId = await chatwootClient.createIncomingMessage(conversationId, {
            content: baseContent,
            metadata: { zalo_event: "recommened.user", msgId: event.msgId, threadId: event.threadId },
          });
          if (cwId) {
            messageMap.set(event.msgId, { conversationId, cwId, preview: baseContent.slice(0, 80) });
            messageStore.set(event.msgId, { conversationId, cwId, preview: baseContent.slice(0, 80) });
          }
          return;
        }

        const recommendedLink = normalizeRecommendedLinkMessage(rawText);
        if (recommendedLink) {
          const baseContent = groupPrefix ? applyGroupPrefix(recommendedLink.content) : recommendedLink.content;
          const content = derivedIsSelf ? `📱 [Sent from Zalo app]\n${baseContent}` : baseContent;
          console.log("[zalo-recommened-link-detected]", {
            msgId: event.msgId,
            threadId: event.threadId,
            isSelf: derivedIsSelf,
            hasTitle: !!recommendedLink.title,
            hasDescription: !!recommendedLink.description,
            hasHref: !!recommendedLink.href,
            titlePreview: (recommendedLink.title || "").slice(0, 60) || null,
          });

          if (derivedIsSelf) {
            const cwId = await chatwootClient.createAgentMessageFromNative(conversationId, {
              content,
              metadata: { source: "zalo_native", zalo_event: "recommened.link", msgId: event.msgId, threadId: event.threadId },
            });
            if (cwId) {
              messageMap.set(event.msgId, { conversationId, cwId, preview: baseContent.slice(0, 80) });
              messageStore.set(event.msgId, { conversationId, cwId, preview: baseContent.slice(0, 80) });
            }
            cache.add(event.msgId);
            return;
          }

          const cwId = await chatwootClient.createIncomingMessage(conversationId, {
            content: baseContent,
            metadata: { zalo_event: "recommened.link", msgId: event.msgId, threadId: event.threadId },
          });
          if (cwId) {
            messageMap.set(event.msgId, { conversationId, cwId, preview: baseContent.slice(0, 80) });
            messageStore.set(event.msgId, { conversationId, cwId, preview: baseContent.slice(0, 80) });
          }
          return;
        }

        try {
          const rich = JSON.parse(rawText) as any;
          const title = typeof rich?.title === "string" ? rich.title.trim() : "";
          const href = typeof rich?.href === "string" ? rich.href.trim() : "";
          let paramsExt: any = null;
          if (typeof rich?.params === "string" && rich.params.trim().startsWith("{")) {
            try {
              paramsExt = JSON.parse(rich.params);
            } catch {
              paramsExt = null;
            }
          } else if (typeof rich?.params === "object" && rich.params) {
            paramsExt = rich.params;
          }

          // Rich text bubble (action: "rtf") contains user text in `title` and formatting in params.styles.
          if (rich?.action === "rtf" && title) {
            const styles = paramsExt?.styles;
            const styled = applyRtfStylesToMarkdown(title, styles);
            const content = styled || title;
            const contentWithPrefix = groupPrefix ? applyGroupPrefix(content) : content;
            console.log("[zalo-rtf-detected]", {
              msgId: event.msgId,
              threadId: event.threadId,
              isSelf: derivedIsSelf,
              stylesCount: Array.isArray(styles) ? styles.length : 0,
              preview: contentWithPrefix.slice(0, 80),
            });
            if (derivedIsSelf) {
              const cwId = await chatwootClient.createAgentMessageFromNative(conversationId, {
                content: `📱 [Sent from Zalo app]\n${contentWithPrefix}`,
                metadata: { source: "zalo_native", zalo_event: "rtf", msgId: event.msgId, threadId: event.threadId },
              });
              if (cwId) {
                messageMap.set(event.msgId, { conversationId, cwId, preview: contentWithPrefix.slice(0, 80) });
                messageStore.set(event.msgId, { conversationId, cwId, preview: contentWithPrefix.slice(0, 80) });
              }
              return;
            }
            const cwId = await chatwootClient.createIncomingMessage(conversationId, {
              content: contentWithPrefix,
              metadata: {
                zalo_event: "rtf",
                msgId: event.msgId,
                threadId: event.threadId,
                rtf_styles: Array.isArray(styles) ? styles.length : 0,
              },
            });
            if (cwId) {
              messageMap.set(event.msgId, { conversationId, cwId, preview: contentWithPrefix.slice(0, 80) });
              messageStore.set(event.msgId, { conversationId, cwId, preview: contentWithPrefix.slice(0, 80) });
            }
            return;
          }

          const videoUrl = typeof href === "string" && href.trim() ? href.trim() : "";
          const hasVideoDims =
            typeof paramsExt?.video_width === "number" ||
            typeof paramsExt?.video_height === "number" ||
            typeof paramsExt?.video_original_width === "number" ||
            typeof paramsExt?.video_original_height === "number";
          const videoDurationMs =
            typeof paramsExt?.duration === "number"
              ? paramsExt.duration
              : typeof paramsExt?.duration === "string" && paramsExt.duration.trim()
                ? Number(paramsExt.duration)
                : null;
          const looksLikeVideoUrl =
            !!videoUrl &&
            (videoUrl.includes("video-stal-") ||
              videoUrl.includes("dlmd.me/") ||
              videoUrl.endsWith(".mp4") ||
              videoUrl.endsWith(".mov") ||
              videoUrl.endsWith(".webm") ||
              videoUrl.endsWith(".mkv"));
          const looksLikeVideoCard = looksLikeVideoUrl && (hasVideoDims || (videoDurationMs !== null && !Number.isNaN(videoDurationMs)));

          if (looksLikeVideoCard) {
            const seconds = Math.max(0, Math.round((Number(videoDurationMs) || 0) / 1000));
            const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
            const ss = String(seconds % 60).padStart(2, "0");
            const content = seconds ? `Video (${mm}:${ss})` : "Video";
            const fileName = ensureFileName(undefined, videoUrl, `video-${event.msgId}`, "mp4");
            const contentTypeHint = inferContentTypeHint(fileName, "video/mp4");

            console.log("[zalo-video-json-detected]", {
              msgId: event.msgId,
              threadId: event.threadId,
              isSelf: derivedIsSelf,
              seconds: seconds || null,
              hasVideoDims,
              conversationId,
            });

            const visibleContent = groupPrefix ? applyGroupPrefix(content) : content;
            const cwId = await chatwootClient.createIncomingMediaMessage({
              conversationId,
              content: visibleContent,
              mediaUrl: videoUrl,
              fileName,
              type: "file",
              contentTypeHint,
              zaloMsgId: event.msgId,
              messageType: derivedIsSelf ? "outgoing" : "incoming",
              isPrivate: derivedIsSelf,
            });
            if (cwId) {
              messageMap.set(event.msgId, { conversationId, cwId, preview: visibleContent.slice(0, 80) });
              messageStore.set(event.msgId, { conversationId, cwId, preview: visibleContent.slice(0, 80) });
              return;
            }

            const fbText = `${content}\n${videoUrl}`;
            const fbTextWithPrefix = groupPrefix ? applyGroupPrefix(fbText) : fbText;
            const fbId = await chatwootClient.createIncomingMessage(conversationId, {
              content: derivedIsSelf ? `📱 [Sent from Zalo app]\n${fbTextWithPrefix}` : fbTextWithPrefix,
              metadata: { zalo_event: "video_text_json", msgId: event.msgId, threadId: event.threadId },
            });
            if (fbId) messageMap.set(event.msgId, { conversationId, cwId: fbId, preview: content });
            if (fbId) messageStore.set(event.msgId, { conversationId, cwId: fbId, preview: content });
            return;
          }

          const voiceUrl =
            typeof paramsExt?.m4a === "string" && paramsExt.m4a.trim()
              ? paramsExt.m4a.trim().replace(/\\\//g, "/")
              : href;
          const durationMs =
            typeof paramsExt?.duration === "number"
              ? paramsExt.duration
              : typeof paramsExt?.duration === "string" && paramsExt.duration.trim()
                ? Number(paramsExt.duration)
                : null;
          const voiceLooksLike =
            !!voiceUrl &&
            (voiceUrl.includes("voice-aac-dl.") || voiceUrl.endsWith(".aac") || voiceUrl.endsWith(".m4a"));
          const looksLikeVoiceNote = voiceLooksLike && !!durationMs && !Number.isNaN(Number(durationMs));
          if (looksLikeVoiceNote) {
            const seconds = Math.max(0, Math.round(Number(durationMs) / 1000));
            const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
            const ss = String(seconds % 60).padStart(2, "0");
            const content = `Voice message (${mm}:${ss})`;
            const urlExt = (() => {
              try {
                const last = new URL(voiceUrl).pathname.split("/").pop() || "";
                const ext = last.split(".").pop()?.toLowerCase();
                return ext && ext !== last ? ext : undefined;
              } catch {
                return undefined;
              }
            })();
            const fileName = ensureFileName(undefined, voiceUrl, `voice-${event.msgId}`, urlExt || "aac");
            const contentTypeHint = inferContentTypeHint(fileName, "audio/aac");
            console.log("[zalo-voice-detected]", {
              msgId: event.msgId,
              threadId: event.threadId,
              isSelf: derivedIsSelf,
              seconds,
              urlExt: urlExt || null,
              conversationId,
            });
            const visibleContent = groupPrefix ? applyGroupPrefix(content) : content;
            const cwId = await chatwootClient.createIncomingMediaMessage({
              conversationId,
              content: visibleContent,
              mediaUrl: voiceUrl,
              fileName,
              type: "file",
              contentTypeHint,
              zaloMsgId: event.msgId,
              messageType: derivedIsSelf ? "outgoing" : "incoming",
              isPrivate: derivedIsSelf,
            });
            if (cwId) {
              messageMap.set(event.msgId, { conversationId, cwId, preview: visibleContent.slice(0, 80) });
              messageStore.set(event.msgId, { conversationId, cwId, preview: visibleContent.slice(0, 80) });
              return;
            }
            const fbText = `${content}\n${voiceUrl}`;
            const fbTextWithPrefix = groupPrefix ? applyGroupPrefix(fbText) : fbText;
            const fbId = await chatwootClient.createIncomingMessage(conversationId, {
              content: derivedIsSelf ? `📱 [Sent from Zalo app]\n${fbTextWithPrefix}` : fbTextWithPrefix,
              metadata: { zalo_event: "voice_note_text_json", msgId: event.msgId, threadId: event.threadId },
            });
            if (fbId) messageMap.set(event.msgId, { conversationId, cwId: fbId, preview: content });
            if (fbId) messageStore.set(event.msgId, { conversationId, cwId: fbId, preview: content });
            return;
          }

          const fileExt =
            typeof paramsExt?.fileExt === "string"
              ? paramsExt.fileExt.trim().toLowerCase()
              : typeof rich?.fileExt === "string"
                ? rich.fileExt.trim().toLowerCase()
                : "";
          const fType = paramsExt?.fType ?? rich?.fType;
          const looksLikeFile = !!title && !!href && (!!fileExt || (typeof fType === "number" && fType === 1));
          if (looksLikeFile) {
            const fileName = ensureFileName(title, href, "file", fileExt || "bin");
            const content = title || fileName;
            // If this is a self-echo from a Chatwoot outbound file, suppress creating a duplicate in Chatwoot.
            if (derivedIsSelf) {
              const echoKey = attachmentEchoKey(event.threadId, content);
              const recentKey = recentAttachmentKey(event.threadId, content);
              if (cache.has(event.msgId) || cache.has(echoKey) || cache.has(recentKey)) {
                console.log("[zalo-file-skip-echo]", { msgId: event.msgId, threadId: event.threadId, title: content });
                return;
              }
            }
            const contentTypeHint = inferContentTypeHint(fileName, "application/octet-stream");
            console.log("[zalo-file-detected]", {
              title: content,
              href,
              fileExt: fileExt || null,
              isSelf: derivedIsSelf,
              conversationId,
            });
            const cwId = await chatwootClient.createIncomingMediaMessage({
              conversationId,
              content,
              mediaUrl: href,
              fileName,
              type: "file",
              contentTypeHint,
              zaloMsgId: event.msgId,
              messageType: derivedIsSelf ? "outgoing" : "incoming",
              isPrivate: derivedIsSelf,
            });
            if (cwId) {
              messageMap.set(event.msgId, { conversationId, cwId, preview: content.slice(0, 80) || "File" });
              messageStore.set(event.msgId, { conversationId, cwId, preview: content.slice(0, 80) || "File" });
              return;
            }
            console.log("[zalo-file-fallback]", { title: content, href, conversationId, msgId: event.msgId });
            const fbText = `FILE: ${content}\n${href}`;
            const fbTextWithPrefix = groupPrefix ? applyGroupPrefix(fbText) : fbText;
            const fbId = await chatwootClient.createIncomingMessage(conversationId, {
              content: derivedIsSelf ? `📱 [Sent from Zalo app]\n${fbTextWithPrefix}` : fbTextWithPrefix,
              metadata: { zalo_event: "file_text_json", msgId: event.msgId, threadId: event.threadId },
            });
            if (fbId) messageMap.set(event.msgId, { conversationId, cwId: fbId, preview: `FILE: ${content}`.slice(0, 80) });
            if (fbId) messageStore.set(event.msgId, { conversationId, cwId: fbId, preview: `FILE: ${content}`.slice(0, 80) });
            return;
          }
        } catch (err: any) {
          console.warn("[zalo-file-error]", {
            error: err?.message || String(err),
            rawText: rawText.slice(0, 500),
            conversationId,
            zaloMsgId: event.msgId,
          });
        }
      }

      if (event.type === "text" && event.text && event.text.trim()) {
        const text = event.text.trim();
        // store last text per thread for possible image caption pairing.
        // Track sender side so peer images don't borrow self text and vice versa.
        captionBuffer.set(event.threadId, {
          text,
          exp: Date.now() + 30_000,
          used: false,
          isSelf: derivedIsSelf,
        });
      }

      if (!derivedIsSelf) {
        if (event.type === "image" || event.type === "gif" || event.type === "file" || event.type === "sticker") {
          if (event.mediaUrl) {
            const placeholder = mediaPlaceholder(event.type);
            const caption =
              (event as any).text?.trim() ||
              (event as any).message?.trim() ||
              (event as any).caption?.trim() ||
              null;
            let content = mediaContentWithRef(event.type, event.msgId, caption || null);
            if (groupPrefix) content = applyGroupPrefix(content);
            if (!caption && event.type === "image") {
              const buffered = captionBuffer.get(event.threadId);
              const isPlausibleCaption =
                buffered &&
                !buffered.used &&
                buffered.exp > Date.now() &&
                buffered.isSelf === derivedIsSelf &&
                buffered.text.length <= 300 &&
                !buffered.text.startsWith("/") &&
                !buffered.text.startsWith("http");
              if (isPlausibleCaption && buffered) {
                content = mediaContentWithRef(event.type, event.msgId, buffered.text);
                if (groupPrefix) content = applyGroupPrefix(content);
                buffered.used = true;
                console.log("[zalo-image-caption-borrowed]", { threadId: event.threadId, content });
              }
            }
            const fileName = ensureFileName(
              event.fileName,
              event.mediaUrl,
              mediaFallbackBase(event.type, placeholder, event.stickerId, event.msgId),
              mediaFallbackExt(event.type),
            );
            const hint = mediaContentTypeHint(event.type, fileName);
            const msgId = await chatwootClient.createIncomingMediaMessage({
              conversationId,
              content,
              mediaUrl: event.mediaUrl,
              fileName,
              type: mediaChatwootType(event.type),
              contentTypeHint: hint,
              zaloMsgId: event.msgId,
              messageType: "incoming",
              isPrivate: false,
            });
            if (!msgId) {
              let fallbackText = `FILE: ${event.mediaUrl || event.text || ""}`;
              if (event.type === "image" || event.type === "gif") {
                const imageText = event.text ? `\n${event.text}` : "";
                fallbackText = `IMAGE: ${event.mediaUrl}${imageText}`;
              }
              const fallbackWithPrefix = groupPrefix ? applyGroupPrefix(fallbackText) : fallbackText;
              const fbId = await chatwootClient.createIncomingMessage(conversationId, {
                content: fallbackWithPrefix,
                metadata: { zalo_event: event.type, msgId: event.msgId, threadId: event.threadId },
              });
              if (fbId) messageMap.set(event.msgId, { conversationId, cwId: fbId, preview: fallbackText.slice(0, 80) });
              if (fbId) messageStore.set(event.msgId, { conversationId, cwId: fbId, preview: fallbackText.slice(0, 80) });
            } else {
              const preview = mediaPreviewLabel(event.type);
              const storedPreview = content || event.text || `${preview} #${msgId}`;
              messageMap.set(event.msgId, { conversationId, cwId: msgId, preview: storedPreview, sender: "contact", quote: event.quote });
              messageStore.set(event.msgId, { conversationId, cwId: msgId, preview: storedPreview, sender: "contact", quote: event.quote });
            }
          } else {
            if (event.type === "sticker" && event.stickerId) {
              const url = await zaloClient.resolveStickerUrl(event.stickerId);
              if (url) {
                const fileName = ensureFileName(event.fileName, url, `sticker-${event.stickerId}`, "webp");
                const msgId = await chatwootClient.createIncomingMediaMessage({
                  conversationId,
                  content: "STICKER",
                  mediaUrl: url,
                  fileName,
                  type: "image",
                  contentTypeHint: "image/webp",
                  zaloMsgId: event.msgId,
                  messageType: "incoming",
                  isPrivate: false,
                });
                if (msgId) {
                  messageMap.set(event.msgId, { conversationId, cwId: msgId, preview: "Sticker", sender: "contact", quote: event.quote });
                  return;
                }
              }
              console.log("[zalo-sticker-error]", { stickerId: event.stickerId });
            }
            console.log("[zalo-event-no-media]", { type: event.type, msgId: event.msgId });
            const fallbackContent = event.text || `[${event.type.toUpperCase()}]`;
            const contentWithPrefix = groupPrefix ? applyGroupPrefix(fallbackContent) : fallbackContent;
            const msgId = await chatwootClient.createIncomingMessage(conversationId, {
              content: contentWithPrefix,
              metadata: { zalo_event: event.type, msgId: event.msgId, threadId: event.threadId },
            });
            if (msgId) messageMap.set(event.msgId, { conversationId, cwId: msgId, preview: event.text || event.type, sender: "contact", quote: event.quote });
            if (msgId) messageStore.set(event.msgId, { conversationId, cwId: msgId, preview: event.text || event.type, sender: "contact", quote: event.quote });
          }
        } else {
          const textContent = event.text || "Zalo message";
          const replyTarget = await resolveReplyTarget(conversationId, event.targetMsgId);
          const contentWithPrefix = groupPrefix ? applyGroupPrefix(textContent) : textContent;
          const content = `${replyContextPrefix(event, replyTarget)}${contentWithPrefix}`;
          const msgId = await chatwootClient.createIncomingMessage(conversationId, {
            content,
            metadata: { zalo_event: event.type, msgId: event.msgId, threadId: event.threadId },
            replyToId: replyTarget?.cwId,
            targetZaloMsgId: event.targetMsgId,
          });
          if (msgId) messageMap.set(event.msgId, { conversationId, cwId: msgId, preview: (event.text || "").slice(0, 80) || "message", sender: "contact", quote: event.quote });
          if (msgId) messageStore.set(event.msgId, { conversationId, cwId: msgId, preview: (event.text || "").slice(0, 80) || "message", sender: "contact", quote: event.quote });
        }
      } else {
        // self events from native app
        if (event.type === "image" || event.type === "gif" || event.type === "file" || event.type === "sticker") {
          const placeholder = mediaPlaceholder(event.type);
          // Skip self media echoes from Chatwoot outbound attachments.
          const echoKey = attachmentEchoKey(event.threadId, event.fileName || placeholder);
          const recentKey = event.fileName ? recentAttachmentKey(event.threadId, event.fileName) : null;
          if (cache.has(event.msgId) || cache.has(echoKey) || (recentKey && cache.has(recentKey))) {
            console.log("[zalo-media-skip-echo]", {
              type: event.type,
              msgId: event.msgId,
              threadId: event.threadId,
              fileName: event.fileName || null,
            });
            return;
          }
          const caption =
            (event as any).text?.trim() ||
            (event as any).message?.trim() ||
            (event as any).caption?.trim() ||
            null;
          let content = mediaContentWithRef(event.type, event.msgId, caption || null);
          if (!caption && event.type === "image") {
            const buffered = captionBuffer.get(event.threadId);
            const isPlausibleCaption =
              buffered &&
              !buffered.used &&
              buffered.exp > Date.now() &&
              buffered.isSelf === derivedIsSelf &&
              buffered.text.length <= 300 &&
              !buffered.text.startsWith("/") &&
              !buffered.text.startsWith("http");
            if (isPlausibleCaption && buffered) {
              content = mediaContentWithRef(event.type, event.msgId, buffered.text);
              buffered.used = true;
              console.log("[zalo-image-caption-borrowed]", { threadId: event.threadId, content });
            }
          }
          const fileName = ensureFileName(
            event.fileName,
            event.mediaUrl,
            mediaFallbackBase(event.type, placeholder, event.stickerId, event.msgId),
            mediaFallbackExt(event.type),
          );
          const resolvedUrl =
            event.mediaUrl ||
            (event.type === "sticker" && event.stickerId ? await zaloClient.resolveStickerUrl(event.stickerId) : null);
          if (resolvedUrl) {
            const hint = mediaContentTypeHint(event.type, fileName);
            const msgId = await chatwootClient.createIncomingMediaMessage({
              conversationId,
              content,
              mediaUrl: resolvedUrl,
              fileName,
              type: mediaChatwootType(event.type),
              contentTypeHint: hint,
              zaloMsgId: event.msgId,
              messageType: "outgoing",
              isPrivate: true,
            });
            if (msgId) {
              const preview = mediaPreviewLabel(event.type);
              const storedPreview = content || mediaRefLabel(event.type, event.msgId) || preview;
              messageMap.set(event.msgId, { conversationId, cwId: msgId, preview: storedPreview, sender: "self", quote: event.quote });
              messageStore.set(event.msgId, { conversationId, cwId: msgId, preview: storedPreview, sender: "self", quote: event.quote });
              return;
            }
          }
          console.log("[zalo-event-no-media-self]", { type: event.type, msgId: event.msgId });
          const fb = await chatwootClient.createIncomingMessage(conversationId, {
            content: `📱 [Sent from Zalo app]\n${content}`,
            metadata: { zalo_event: event.type, msgId: event.msgId, threadId: event.threadId },
          });
          if (fb) messageMap.set(event.msgId, { conversationId, cwId: fb, preview: placeholder, sender: "self", quote: event.quote });
          if (fb) messageStore.set(event.msgId, { conversationId, cwId: fb, preview: placeholder, sender: "self", quote: event.quote });
          return;
        }

        const alreadySeen =
          cache.has(event.msgId) ||
          (event.text
            ? cache.has(cwTextKey(event.threadId, event.text)) ||
              cache.has(attachmentEchoKey(event.threadId, event.text))
            : false);
        if (alreadySeen) return;

        const contentPrefix = "📱 [Sent from Zalo app]\n";
        const textPart =
          event.text ||
          (event.mediaUrl ? `${event.type.toUpperCase()}: ${event.mediaUrl}` : "Zalo native message");

        cache.addMany([event.msgId, event.text ? contentKey(event.threadId, event.text) : null]);

        const cwId = await chatwootClient.createAgentMessageFromNative(conversationId, {
          content: `${contentPrefix}${textPart}`,
          metadata: { source: "zalo_native", msgId: event.msgId, threadId: event.threadId },
        });
        if (cwId) {
          messageMap.set(event.msgId, {
            conversationId,
            cwId,
            preview: (event.text || "").slice(0, 80) || "message",
            sender: "self",
            quote: event.quote,
          });
          messageStore.set(event.msgId, {
            conversationId,
            cwId,
            preview: (event.text || "").slice(0, 80) || "message",
            sender: "self",
            quote: event.quote,
          });
        }
      }
    } catch (err) {
      console.error("[zalo-personal-bridge] failed to handle event", err);
    }
  });

  const app = createServer({
    chatwootClient,
    zaloClient,
    cache,
    inboxId: CHATWOOT_INBOX_ID,
    threadMap,
    messageMap,
    messageStore,
    mentionsConfigFile: ZALO_MENTIONS_CONFIG_FILE,
  });
  app.listen(PORT, () => {
    console.log(`[zalo-personal-bridge] listening on http://localhost:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error("[zalo-personal-bridge] fatal error", err);
  process.exit(1);
});
