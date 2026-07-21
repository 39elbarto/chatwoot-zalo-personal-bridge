import express from "express";
import { ChatwootClient, type AttachmentPayload } from "./chatwootClient";
import { ZaloClient } from "./zaloClient";
import { OutgoingCache } from "./outgoingCache";
import { contentKey } from "./messageKeys";
import type { MessageMapStore } from "./messageMapStore";
import { ZaloMentionResolver } from "./zaloMentions";
import type { RuntimeStatus } from "./runtimeStatus";

export type ServerDeps = {
  chatwootClient: ChatwootClient;
  zaloClient: ZaloClient;
  cache: OutgoingCache;
  inboxId: number;
  threadMap: Map<number, string>;
  messageMap: Map<string, { conversationId: number; cwId: number; preview: string; sender?: "self" | "contact"; quote?: Record<string, unknown> }>;
  messageStore?: MessageMapStore;
  mentionsConfigFile?: string;
  runtimeStatus: RuntimeStatus;
  threadIdPrefixes?: readonly string[];
  routePrefixes?: readonly string[];
};

type ChatwootWebhookPayload = {
  event?: string;
  message?: any;
  conversation?: any;
  contact?: any;
  contact_inbox?: any;
};

const schema = {
  validate(value: unknown): { value?: ChatwootWebhookPayload; error?: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "invalid_payload" };
    }
    return { value: value as ChatwootWebhookPayload };
  },
};

function normalizeTemplateTextForZalo(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\\\n/g, "\n")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/(?<!\*)\*(?!\s)(.*?)(?<!\s)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_(?!\s)(.*?)(?<!\s)_(?!_)/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const threadIdSources = [
  "threadMap",
  "contactCustomAttribute",
  "conversationCustomAttribute",
  "sourceId",
  "contactIdentifier",
] as const;

export type ThreadIdSource = (typeof threadIdSources)[number];
export type ThreadIdCandidate = { raw: string | number | null | undefined; source: ThreadIdSource };
export type ResolvedThreadId = { threadId: string; source: ThreadIdSource };

function normalizedPrefixes(prefixes: readonly string[]): string[] {
  return [...new Set(prefixes.map((prefix) => prefix.trim()).filter((prefix) => /^[a-z][a-z0-9_-]*:$/.test(prefix)))]
    .sort((left, right) => right.length - left.length);
}

export function normalizeThreadId(
  raw?: string | number | null,
  prefixes: readonly string[] = ["zalo:"],
): string | null {
  if (raw === null || raw === undefined) return null;
  let candidate = String(raw).trim();
  const matchedPrefix = normalizedPrefixes(prefixes).find((prefix) => candidate.startsWith(prefix));
  if (matchedPrefix) candidate = candidate.slice(matchedPrefix.length);
  candidate = candidate.replace(/^:+/, "");
  candidate = candidate.replace(/-dup$/, "");
  return /^(?:[1-9][0-9]*|group:[1-9][0-9]*)$/.test(candidate) ? candidate : null;
}

export function resolveThreadId(
  candidates: readonly ThreadIdCandidate[],
  prefixes: readonly string[] = ["zalo:"],
): ResolvedThreadId | null {
  for (const candidate of candidates) {
    const threadId = normalizeThreadId(candidate.raw, prefixes);
    if (threadId) return { threadId, source: candidate.source };
  }
  return null;
}

export function normalizeRoutePrefixes(prefixes: readonly string[]): string[] {
  return [...new Set(prefixes.map((prefix) => prefix.trim()).filter(Boolean).map((prefix) => {
    const withSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
    return withSlash.replace(/\/+$/, "");
  }))].filter((prefix) => /^\/[a-z0-9][a-z0-9/_-]*$/i.test(prefix) && !prefix.includes(".."));
}

function attachmentEchoKey(threadId: string, text: string) {
  return `cwatt:${contentKey(threadId, text)}`;
}

function cwTextKey(threadId: string, text: string) {
  return `cwtext:${contentKey(threadId, text)}`;
}

function recentAttachmentKey(threadId: string, fileName: string) {
  return `cwatt_recent:${threadId}:${fileName}`;
}

function parseAttrs(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function defaultQuotePropertyExt() {
  return {
    color: 0,
    size: 0,
    type: 0,
    subType: 0,
    ext: '{"shouldParseLinkOrContact":0}',
  };
}

function buildSyntheticQuote(
  threadId: string,
  target: { preview: string; sender?: "self" | "contact"; ts?: number; quote?: Record<string, unknown> } | null,
  targetZaloMsgId?: string | null,
  selfUid?: string | null,
) {
  if (!target || !targetZaloMsgId) return null;
  const preview = (target.preview || "message").trim() || "message";
  let ownerId = threadId;
  if (target.sender === "self" && selfUid) {
    ownerId = selfUid;
  } else if (threadId.startsWith("group:")) {
    ownerId = "";
  }
  return {
    content: preview,
    msgType: "webchat",
    propertyExt: defaultQuotePropertyExt(),
    uidFrom: ownerId,
    msgId: targetZaloMsgId,
    cliMsgId: targetZaloMsgId,
    ts: target.ts || Date.now(),
    ttl: 0,
  };
}

function attachmentType(attachment: any): "image" | "file" {
  const ft = (attachment?.file_type || attachment?.content_type || attachment?.mime_type || "")
    .toString()
    .toLowerCase();
  if (ft.includes("image")) return "image";
  const url = attachment?.data_url || attachment?.file_url || attachment?.url || "";
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    if (ext && ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
  } catch {
    // ignore
  }
  return "file";
}

export function sanitizeAttachmentFileName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const leaf = value.replace(/\\/g, "/").split("/").pop() || "";
  const safe = leaf
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 180);
  return safe || undefined;
}

export function createServer({
  chatwootClient,
  zaloClient,
  cache,
  inboxId,
  threadMap,
  messageMap,
  messageStore,
  mentionsConfigFile,
  runtimeStatus,
  threadIdPrefixes = ["zalo:"],
  routePrefixes = [],
}: ServerDeps) {
  const app = express();
  const mentionResolver = new ZaloMentionResolver(mentionsConfigFile || "./data/zalo-mentions.json");
  const sendDocument = zaloClient.sendDocument.bind(zaloClient);
  app.use(express.json({ limit: "20mb" }));

  const healthHandler = (_req: express.Request, res: express.Response) => {
    const health = runtimeStatus.health();
    return res.status(health.ok ? 200 : 503).json(health);
  };
  const normalizedRoutePrefixes = normalizeRoutePrefixes(routePrefixes);
  for (const path of ["/health", ...normalizedRoutePrefixes.map((prefix) => `${prefix}/health`)]) {
    app.get(path, healthHandler);
  }

  const requireReady: express.RequestHandler = (_req, res, next) => {
    if (!runtimeStatus.isReady()) return res.status(503).json({ success: false, error: "not_ready" });
    next();
  };

  const validateWebhookBody: express.RequestHandler = (req, res, next) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.json({ success: true, skipped: "invalid_payload" });
    }
    next();
  };

  const callbackHandler = async (req: express.Request, res: express.Response) => {
    if (!runtimeStatus.isReady()) return res.status(503).json({ success: false, error: "not_ready" });
    console.log("[chatwoot-callback] accepted", { route: req.path });
    try {
      const validation = schema.validate(req.body);
      if (validation.error || !validation.value) {
        return res.json({ success: true, skipped: "invalid_payload" });
      }
      const raw = validation.value as any;
      const msg = raw?.message || raw?.data?.message || raw?.payload?.message || raw;
      const conversation = raw?.conversation || msg?.conversation;
      const contact = raw?.contact || msg?.contact;
      const contact_inbox = raw?.contact_inbox || msg?.contact_inbox;

      const rawType =
        msg?.message_type ??
        raw?.message_type ??
        raw?.data?.message_type ??
        raw?.payload?.message_type ??
        msg?.content_attributes?.message_type;
      const messageType =
        typeof rawType === "string"
          ? rawType
          : rawType === 0
            ? "incoming"
            : rawType === 1
              ? "outgoing"
              : rawType === 3
                ? "template"
              : undefined;

      const inboxIdFromPayload = msg?.inbox_id || conversation?.inbox_id || contact_inbox?.inbox_id || raw?.inbox_id;
      const conversationId = msg?.conversation_id || conversation?.id;

      const eventName = typeof raw?.event === "string" ? raw.event : "";
      if (eventName && eventName !== "message_created") {
        return res.json({ success: true, skipped: "unsupported_event" });
      }

      console.log("[chatwoot-callback] incoming", {
        event: raw?.event,
        messageType,
        inboxId: inboxIdFromPayload,
        conversationId,
        private: msg?.private,
        source: msg?.additional_attributes?.source,
      });

      if (inboxIdFromPayload && inboxIdFromPayload !== inboxId) {
        return res.json({ success: true, skipped: "other_inbox" });
      }
      if (raw?.event !== "message_created" || !msg) return res.json({ success: true, skipped: "event" });

      if (!messageType) return res.json({ success: true, skipped: "no_type" });

      const isForwardableTemplate = messageType === "template" && !msg?.private;
      if (messageType !== "outgoing" && !isForwardableTemplate) {
        return res.json({ success: true, skipped: "not_outgoing" });
      }

      if (msg?.private || msg?.additional_attributes?.source === "zalo_native") {
        return res.json({ success: true, skipped: "native_or_private" });
      }

      const rawSource =
        conversation?.contact_inbox?.source_id ||
        msg?.sender?.source_id ||
        contact_inbox?.source_id ||
        contact?.source_id;
      const contactIdentifier =
        contact?.identifier || conversation?.contact?.identifier || msg?.sender?.identifier || null;

      const threadIdCandidates: ThreadIdCandidate[] = [
        { raw: conversationId ? threadMap.get(conversationId) : null, source: "threadMap" },
        { raw: raw?.contact?.custom_attributes?.zalo2_thread_id, source: "contactCustomAttribute" },
        {
          raw: conversation?.contact?.custom_attributes?.zalo2_thread_id,
          source: "conversationCustomAttribute",
        },
        { raw: rawSource, source: "sourceId" },
        { raw: contactIdentifier, source: "contactIdentifier" },
      ];
      let resolvedThread = resolveThreadId(threadIdCandidates, threadIdPrefixes);

      if (!resolvedThread && conversationId) {
        try {
          const conv = await chatwootClient.getConversation(conversationId);
          const data = conv.body?.payload ?? conv.body;
          resolvedThread = resolveThreadId(
            [
              {
                raw: data?.contact?.custom_attributes?.zalo2_thread_id,
                source: "conversationCustomAttribute",
              },
              { raw: data?.contact_inbox?.source_id, source: "sourceId" },
            ],
            threadIdPrefixes,
          );
        } catch (err) {
          runtimeStatus.setError("conversation_lookup_failed");
          console.warn("[zalo-personal-bridge] failed to fetch conversation", {
            category: "conversation_lookup_failed",
          });
        }
      }

      if (!resolvedThread) {
        console.warn("[chatwoot-callback] invalid thread id, responding OK to avoid retry", {
          validation: "rejected",
          category: "invalid_thread_id",
        });
        return res.json({ success: true, skipped: "invalid_thread_id" });
      }
      const { threadId, source: threadSource } = resolvedThread;

      const content: string | undefined = typeof msg.content === "string" ? msg.content : msg?.content?.text;
      const attachments: AttachmentPayload[] =
        (msg.attachments || []).map((att: any) => ({
          url: att.data_url || att.file_url || att.url,
          fileType: attachmentType(att),
          fileName: att.file_name || att.filename || att.name,
        })) || [];
      const cwMessageId: number | null = typeof msg?.id === "number" ? msg.id : null;

      const dedupeKey = `cw:${conversationId || "unknown"}:${msg?.id || ""}`;
      if (cache.has(dedupeKey)) {
        console.log("[chatwoot-callback] skip duplicate", { dedupeKey });
        return res.json({ success: true, skipped: "duplicate" });
      }
      // Pre-add dedupe key to avoid retries causing duplicates if Zalo send is slow.
      cache.add(dedupeKey);

      // Always respond quickly to Chatwoot to avoid 502/retries and "Failed to send" UI.
      res.json({ success: true, queued: true });

      const trimmedContent = typeof content === "string" ? content.trim() : "";
      const textForZalo = messageType === "template" ? normalizeTemplateTextForZalo(trimmedContent) : trimmedContent;
      const mentionResult = textForZalo ? mentionResolver.resolve(threadId, textForZalo) : null;
      const finalTextForZalo = mentionResult?.text || textForZalo;
      const mentionsForZalo = mentionResult?.mentions || [];
      const hasText = !!finalTextForZalo;
      const tasks: Array<Promise<void>> = [];
      const contentAttrs = parseAttrs(msg?.content_attributes || msg?.contentAttributes);
      const replyToId = Number(contentAttrs?.in_reply_to || contentAttrs?.reply_to || msg?.reply_to || 0) || null;
      const replyTarget =
        replyToId
          ? [...messageMap.values()].find((entry) => entry.cwId === replyToId) || messageStore?.findByChatwootId(replyToId) || null
          : null;
      const replyTargetZaloMsgId =
        replyToId && replyTarget
          ? [...messageMap.entries()].find(([, entry]) => entry.cwId === replyToId)?.[0] ||
            messageStore?.findZaloIdByChatwootId(replyToId) ||
            null
          : null;
      const nativeQuote = replyTarget?.quote || buildSyntheticQuote(threadId, replyTarget, replyTargetZaloMsgId, zaloClient.getSelfUid());

      if (hasText) {
        tasks.push(
          (async () => {
            try {
              const isGroup = threadId.startsWith("group:");
              console.log("[chatwoot-callback] forward to Zalo", {
                conversationId,
                threadSource,
                threadIdValidation: "accepted",
                isGroup,
                messageId: msg?.id,
                normalized: (messageType === "template" && textForZalo !== trimmedContent) || finalTextForZalo !== textForZalo,
                replyToId,
                nativeQuote: !!nativeQuote,
                syntheticQuote: !!nativeQuote && !replyTarget?.quote,
                mentionCount: mentionsForZalo.length,
              });
              const msgId = await zaloClient.sendText(threadId, finalTextForZalo, nativeQuote, mentionsForZalo);
              if (msgId) runtimeStatus.markOutboundZaloSend();
              else runtimeStatus.setError("zalo_text_send_failed");
              cache.addMany([msgId, cwTextKey(threadId, finalTextForZalo)]);
              if (msgId && cwMessageId) {
                const entry = {
                  conversationId: conversationId || 0,
                  cwId: cwMessageId,
                  preview: finalTextForZalo.slice(0, 80),
                  sender: "self",
                } as const;
                messageMap.set(String(msgId), entry);
                messageStore?.set(String(msgId), entry);
              }
            } catch (err) {
              runtimeStatus.setError("zalo_text_send_failed");
              console.warn("[chatwoot-callback] text forward failed", {
                threadSource,
                isGroup: threadId.startsWith("group:"),
                category: "text_forward_failed",
              });
            }
          })(),
        );
      }

      for (const att of attachments) {
        if (!att.url) continue;
        tasks.push(
          (async () => {
            console.log("[chatwoot-callback] attachment forward", {
              threadSource,
              type: att.fileType,
            });
            let contentLength: number | null = null;
            let contentType: string | null = null;
            try {
              const head = await fetch(att.url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
              if (!head.ok) {
                runtimeStatus.setError("attachment_fetch_failed");
                console.warn("[zalo-send-image-url-bad]", { category: "attachment_head_status", status: head.status });
                return;
              }
              const len = head.headers.get("content-length");
              if (len && !Number.isNaN(Number(len))) contentLength = Number(len);
              contentType = head.headers.get("content-type");
            } catch (err) {
              runtimeStatus.setError("attachment_fetch_failed");
              console.warn("[zalo-send-image-url-bad]", { category: "attachment_head_failed" });
              return;
            }
            let filename = att.fileName || undefined;
            if (!filename) {
              try {
                const last = new URL(att.url).pathname.split("/").pop() || "";
                filename = last ? decodeURIComponent(last) : undefined;
              } catch {
                filename = undefined;
              }
            }
            filename = sanitizeAttachmentFileName(filename);
            console.log("[zalo-send-attachment]", {
              type: att.fileType,
              size: contentLength,
              via: "buffer",
              contentType,
            });
            if (filename) {
              cache.add(attachmentEchoKey(threadId, filename));
              cache.addWithTtl(recentAttachmentKey(threadId, filename), 60_000);
            }

            if (att.fileType === "image") {
              const msgId = await zaloClient.sendImage(threadId, att.url, filename);
              if (msgId) {
                runtimeStatus.markOutboundZaloSend();
                cache.addMany([msgId, filename ? attachmentEchoKey(threadId, filename) : null]);
                if (cwMessageId) {
                  const entry = {
                    conversationId: conversationId || 0,
                    cwId: cwMessageId,
                    preview: "Image",
                    sender: "self",
                  } as const;
                  messageMap.set(String(msgId), entry);
                  messageStore?.set(String(msgId), entry);
                }
              } else if (!hasText) {
                const fbText = `Image: ${att.url}`;
                console.warn("[zalo-send-attachment-error]", { type: "image", category: "fallback_to_text" });
                const fbMsgId = await zaloClient.sendText(threadId, fbText);
                if (fbMsgId) runtimeStatus.markOutboundZaloSend();
                else runtimeStatus.setError("zalo_fallback_send_failed");
                cache.addMany([fbMsgId, contentKey(threadId, fbText)]);
              } else {
                runtimeStatus.setError("zalo_image_send_failed");
              }
            } else {
              const msgId = await sendDocument(threadId, att.url, filename);
              if (msgId) {
                runtimeStatus.markOutboundZaloSend();
                cache.addMany([msgId, filename ? attachmentEchoKey(threadId, filename) : null]);
                if (cwMessageId) {
                  const entry = {
                    conversationId: conversationId || 0,
                    cwId: cwMessageId,
                    preview: "File",
                    sender: "self",
                  } as const;
                  messageMap.set(String(msgId), entry);
                  messageStore?.set(String(msgId), entry);
                }
              } else if (!hasText) {
                const title = filename || "File";
                const fbText = `Shared file: ${title}\n${att.url}`;
                console.warn("[zalo-send-attachment-error]", { type: "file", category: "fallback_to_text" });
                const fbMsgId = await zaloClient.sendText(threadId, fbText);
                if (fbMsgId) runtimeStatus.markOutboundZaloSend();
                else runtimeStatus.setError("zalo_fallback_send_failed");
                cache.addMany([fbMsgId, contentKey(threadId, fbText)]);
              } else {
                runtimeStatus.setError("zalo_file_send_failed");
              }
            }
          })(),
        );
      }

      Promise.allSettled(tasks).catch(() => {});
      return;
    } catch (err) {
      runtimeStatus.setError("callback_processing_failed");
      console.error("[chatwoot-callback] error", { category: "callback_processing_failed" });
      return res.json({ success: false, error: "callback_processing_failed" });
    }
  };

  const callbackPaths = [
    "/callback",
    "/webhooks/chatwoot",
    ...normalizedRoutePrefixes.map((prefix) => `${prefix}/callback`),
  ];
  for (const path of callbackPaths) {
    app.post(path, requireReady, validateWebhookBody, callbackHandler);
  }

  return app;
}
