import express from "express";
import { ChatwootClient, type AttachmentPayload } from "./chatwootClient";
import { isZaloApiFetchTimeout, isZaloUploadCallbackTimeout, isZaloUploadConfirmationCooldown, ZaloClient } from "./zaloClient";
import { OutgoingCache } from "./outgoingCache";
import { contentKey } from "./messageKeys";
import type { MessageMapStore } from "./messageMapStore";
import { ZaloMentionResolver } from "./zaloMentions";
import type { RuntimeStatus } from "./runtimeStatus";
import { OutboundDeliveryError, OutboundDeliveryQueue, type OutboundQueueJob, type OutboundQueueItem } from "./outboundDeliveryQueue";

export type ServerDeps = {
  chatwootClient: ChatwootClient;
  zaloClient: ZaloClient;
  cache: OutgoingCache;
  inboxId: number;
  threadMap: Map<number, string>;
  messageMap: Map<string, { conversationId: number; cwId: number; preview: string; sender?: "self" | "contact"; quote?: Record<string, unknown> }>;
  messageStore?: MessageMapStore;
  outboundQueue: OutboundDeliveryQueue;
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
  outboundQueue,
  mentionsConfigFile,
  runtimeStatus,
  threadIdPrefixes = ["zalo:"],
  routePrefixes = [],
}: ServerDeps) {
  const app = express();
  const mentionResolver = new ZaloMentionResolver(mentionsConfigFile || "./data/zalo-mentions.json");
  app.use(express.json({ limit: "20mb" }));

  outboundQueue.setTerminalHandler(async (job) => {
    const attachmentIssue = job.items.some((item) => item.kind !== "text" && (item.state === "failed" || item.state === "unknown"));
    const unknown = job.items.some((item) => item.state === "unknown");
    const failed = job.items.some((item) => item.state === "failed");
    const accepted = job.items.some((item) => item.state === "accepted");
    const subject = attachmentIssue ? "Attachment sending" : "Message sending";
    const outcome = unknown && failed ? "failed, and another outcome is unknown" : unknown ? "has an unknown outcome" : "failed";
    const cooldown = job.items.some((item) => item.failureCategory === "zalo_upload_confirmation_cooldown");
    const detail = cooldown && !unknown
      ? `${accepted ? "Some content was accepted by Zalo. " : ""}Attachment upload is temporarily paused and was not sent. Retry after five minutes.`
      : `${accepted ? "Some content was accepted by Zalo. " : ""}${subject} ${outcome}.`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await chatwootClient.markOutboundFailed(job.conversationId, job.messageId, detail);
        return;
      } catch {
        if (attempt === 2) throw new Error("chatwoot_status_write_failed");
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  });

  outboundQueue.setProcessor(async (job: Readonly<OutboundQueueJob>, item: Readonly<OutboundQueueItem>) => {
    if (item.kind === "text") {
      const text = item.text || "";
      let zaloMessageId: string | null;
      try {
        zaloMessageId = await zaloClient.sendText(job.threadId, text, item.quote, item.mentions);
      } catch (error) {
        runtimeStatus.setError("zalo_text_send_failed");
        if (isZaloApiFetchTimeout(error)) {
          throw new OutboundDeliveryError("zalo_api_fetch_timeout", "unknown");
        }
        throw new OutboundDeliveryError("zalo_text_outcome_unknown", "unknown");
      }
      if (!zaloMessageId) {
        runtimeStatus.setError("zalo_text_send_failed");
        throw new OutboundDeliveryError("zalo_text_outcome_unknown", "unknown");
      }
      runtimeStatus.markOutboundZaloSend();
      cache.addMany([zaloMessageId, cwTextKey(job.threadId, text)]);
      const entry = {
        conversationId: job.conversationId,
        cwId: job.messageId,
        preview: text.slice(0, 80),
        sender: "self",
      } as const;
      messageMap.set(zaloMessageId, entry);
      messageStore?.set(zaloMessageId, entry);
      return { zaloMessageId };
    }

    if (!item.url) {
      runtimeStatus.setError("attachment_fetch_failed");
      throw new OutboundDeliveryError("attachment_url_missing", "failed");
    }
    const url = item.url;
    let head: Response;
    try {
      head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    } catch {
      runtimeStatus.setError("attachment_fetch_failed");
      throw new OutboundDeliveryError("attachment_head_failed", "retryable");
    }
    if (!head.ok) {
      runtimeStatus.setError("attachment_fetch_failed");
      const retryable = head.status === 408 || head.status === 429 || head.status >= 500;
      throw new OutboundDeliveryError("attachment_head_status", retryable ? "retryable" : "failed");
    }
    let filename = item.fileName || undefined;
    if (!filename) {
      try {
        const last = new URL(url).pathname.split("/").pop() || "";
        filename = last ? decodeURIComponent(last) : undefined;
      } catch {
        filename = undefined;
      }
    }
    filename = sanitizeAttachmentFileName(filename);
    if (filename) {
      cache.add(attachmentEchoKey(job.threadId, filename));
      cache.addWithTtl(recentAttachmentKey(job.threadId, filename), 60_000);
    }

    let zaloMessageId: string | null;
    try {
      zaloMessageId = item.kind === "image"
        ? await zaloClient.sendImage(job.threadId, url, filename)
        : await zaloClient.sendDocument(job.threadId, url, filename);
    } catch (error) {
      runtimeStatus.setError(item.kind === "image" ? "zalo_image_send_failed" : "zalo_file_send_failed");
      if (isZaloApiFetchTimeout(error)) {
        throw new OutboundDeliveryError("zalo_api_fetch_timeout", "unknown");
      }
      if (isZaloUploadCallbackTimeout(error)) {
        throw new OutboundDeliveryError("zalo_upload_callback_timeout", "retryable");
      }
      if (isZaloUploadConfirmationCooldown(error)) {
        throw new OutboundDeliveryError("zalo_upload_confirmation_cooldown", item.kind === "file" ? "failed" : "unknown");
      }
      throw new OutboundDeliveryError("zalo_attachment_outcome_unknown", "unknown");
    }
    if (!zaloMessageId) {
      runtimeStatus.setError(item.kind === "image" ? "zalo_image_send_failed" : "zalo_file_send_failed");
      throw new OutboundDeliveryError("zalo_attachment_outcome_unknown", "unknown");
    }

    runtimeStatus.markOutboundZaloSend();
    cache.addMany([zaloMessageId, filename ? attachmentEchoKey(job.threadId, filename) : null]);
    const entry = {
      conversationId: job.conversationId,
      cwId: job.messageId,
      preview: item.kind === "image" ? "Image" : "File",
      sender: "self",
    } as const;
    messageMap.set(zaloMessageId, entry);
    messageStore?.set(zaloMessageId, entry);
    return { zaloMessageId };
  });

  const healthHandler = (_req: express.Request, res: express.Response) => {
    const health = runtimeStatus.health();
    return res.status(health.ok ? 200 : 503).json({ ...health, outbound_queue: outboundQueue.healthSummary() });
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
      if (eventName === "message_updated") {
        const messageId = Number(msg?.id);
        const targetConversation = Number(conversationId);
        if (!Number.isSafeInteger(messageId) || messageId <= 0 || messageId >= Number.MAX_SAFE_INTEGER ||
            !Number.isSafeInteger(targetConversation) || targetConversation <= 0 ||
            (inboxIdFromPayload && Number(inboxIdFromPayload) !== inboxId)) {
          return res.json({success: true, skipped: "retry_identity"});
        }
        const retryState = await outboundQueue.retryState(targetConversation, messageId);
        if (!retryState) return res.json({success: true, skipped: "retry_not_eligible"});
        let current: Record<string, any> | null;
        try {
          current = await chatwootClient.getMessageForRetry(targetConversation, messageId);
        } catch {
          return res.status(503).json({success: false, error: "retry_read_failed"});
        }
        if (!current || current.id !== messageId || current.conversation_id !== targetConversation ||
            current.inbox_id !== inboxId || ![1, "outgoing"].includes(current.message_type) ||
            current.private !== false || current.deleted === true || current.content_attributes?.deleted === true ||
            current.status !== "sent") return res.json({success: true, skipped: "retry_not_confirmed"});
        try {
          if (retryState.state === "pending") {
            await outboundQueue.reassertPendingRetry(targetConversation, messageId, retryState.generation);
            return res.json({success: true, retry: "reassert"});
          }
          const result = await outboundQueue.applyNativeRetry(targetConversation, messageId, retryState.generation);
          return res.json({success: true, retry: result});
        } catch {
          runtimeStatus.setError("outbound_queue_failed");
          return res.status(503).json({success: false, error: "retry_queue_unavailable"});
        }
      }
      if (eventName && eventName !== "message_created") {
        return res.json({ success: true, skipped: "unsupported_event" });
      }

      console.log("[chatwoot-callback] incoming", {
        event: raw?.event,
        messageType,
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
      const normalizedConversationId = Number(conversationId);
      const cwMessageId = Number(msg?.id);
      if (!Number.isSafeInteger(normalizedConversationId) || normalizedConversationId <= 0 || !Number.isSafeInteger(cwMessageId) || cwMessageId <= 0) {
        console.warn("[chatwoot-callback] outbound identity missing", { category: "missing_message_identity" });
        return res.status(422).json({ success: false, error: "missing_message_identity" });
      }

      const trimmedContent = typeof content === "string" ? content.trim() : "";
      const textForZalo = messageType === "template" ? normalizeTemplateTextForZalo(trimmedContent) : trimmedContent;
      const mentionResult = textForZalo ? mentionResolver.resolve(threadId, textForZalo) : null;
      const finalTextForZalo = mentionResult?.text || textForZalo;
      const mentionsForZalo = mentionResult?.mentions || [];
      const hasText = !!finalTextForZalo;
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
      const queueItems = [] as Array<{ kind: "text" | "image" | "file"; text?: string; url?: string; fileName?: string; quote?: Record<string, unknown> | null; mentions?: typeof mentionsForZalo }>;
      if (hasText) {
        queueItems.push({ kind: "text", text: finalTextForZalo, quote: nativeQuote, mentions: mentionsForZalo });
      }
      for (const attachment of attachments) {
        queueItems.push({
          kind: attachment.fileType === "image" ? "image" : "file",
          url: attachment.url,
          fileName: sanitizeAttachmentFileName(attachment.fileName),
        });
      }
      if (!queueItems.length) return res.json({ success: true, skipped: "empty_message" });

      console.log("[chatwoot-callback] enqueue outbound message", {
        threadSource,
        itemCount: queueItems.length,
        normalized: (messageType === "template" && textForZalo !== trimmedContent) || finalTextForZalo !== textForZalo,
        nativeQuote: !!nativeQuote,
        syntheticQuote: !!nativeQuote && !replyTarget?.quote,
        mentionCount: mentionsForZalo.length,
      });
      let enqueueResult: { duplicate: boolean; key: string };
      try {
        enqueueResult = await outboundQueue.enqueue({
          conversationId: normalizedConversationId,
          messageId: cwMessageId,
          threadId,
          items: queueItems,
        });
      } catch (error) {
        const category = error instanceof OutboundDeliveryError ? error.category : "outbound_queue_write_failed";
        runtimeStatus.setError("outbound_queue_failed");
        console.warn("[chatwoot-callback] outbound enqueue failed", { category });
        return res.status(503).json({ success: false, error: "outbound_queue_unavailable" });
      }
      if (enqueueResult.duplicate) {
        return res.json({ success: true, queued: false, duplicate: true });
      }
      return res.json({ success: true, queued: true });
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
