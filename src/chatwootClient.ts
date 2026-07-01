import axios from "axios";
import FormData from "form-data";

type HttpResult<T = any> = { status: number; body: T; text: string };
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const bridgeLogger = globalThis.console;

function responseSnippet(payload: unknown): string {
  if (typeof payload === "string") return payload.slice(0, 200);
  return (JSON.stringify(payload) ?? String(payload)).slice(0, 200);
}

function responseObject(payload: unknown): Record<string, any> | null {
  if (!payload || typeof payload !== "object") return null;
  return payload as Record<string, any>;
}

function coerceList(payload: any): any[] {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

export class ChatwootRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: any,
  ) {
    super(message);
  }
}

export type ChatwootConfig = {
  baseUrl: string;
  apiToken: string;
  accountId: number;
  inboxId: number;
  inboxIdentifier: string;
  instanceKey?: string;
  contactIdentifierPrefix?: string;
  contactIdentifierLegacyPrefixes?: string[];
  conversationSourceIdPrefix?: string;
};

export type AttachmentPayload = { url: string; fileType: string; fileName?: string };

export class ChatwootClient {
  constructor(private cfg: ChatwootConfig) {}

  private log(msg: string, meta?: any) {
    if (meta !== undefined) {
      bridgeLogger.log(msg, meta);
    } else {
      bridgeLogger.log(msg);
    }
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      api_access_token: this.cfg.apiToken,
    } as Record<string, string>;
  }

  private url(path: string) {
    return `${this.cfg.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async request<T = any>(path: string, init: RequestInit, label: string): Promise<HttpResult<T>> {
    const res = await fetch(this.url(path), {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      bridgeLogger.error(`[zalo-personal-bridge] ${label} failed`, { status: res.status, body });
      throw new ChatwootRequestError(`${label} failed with ${res.status}`, res.status, body);
    }
    return { status: res.status, body, text };
  }

  private extractId(payload: any): number | null {
    if (!payload) return null;
    if (typeof payload.id === "number") return payload.id;
    if (payload.data?.id) return payload.data.id;
    if (Array.isArray(payload)) return payload.find((item) => typeof item?.id === "number")?.id ?? null;
    return null;
  }

  private normalizePrefix(raw: string | undefined, fallback: string) {
    const value = (raw && raw.trim()) || fallback;
    return value.endsWith(":") ? value : `${value}:`;
  }

  private instanceKey() {
    return (this.cfg.instanceKey && this.cfg.instanceKey.trim()) || this.normalizePrefix(this.cfg.contactIdentifierPrefix, "zalo").replace(/:$/, "");
  }

  private contactIdentifierPrefix() {
    return this.normalizePrefix(this.cfg.contactIdentifierPrefix, "zalo");
  }

  private legacyContactPrefixes() {
    if (Array.isArray(this.cfg.contactIdentifierLegacyPrefixes)) {
      return this.cfg.contactIdentifierLegacyPrefixes
        .map((p) => this.normalizePrefix(p, ""))
        .filter((p) => p && p !== this.contactIdentifierPrefix());
    }
    // Preserve previous behavior for the default instance only.
    if (this.contactIdentifierPrefix() === "zalo:") return ["zalo2:"];
    // For non-default instances (e.g., zalo3:), default to no legacy reuse to avoid cross-inbox collisions.
    return [];
  }

  private buildIdentifier(zaloUserId: string) {
    return `${this.contactIdentifierPrefix()}${zaloUserId}`;
  }

  private async findContactByIdentifiers(identifiers: string[]): Promise<any | null> {
    for (const id of identifiers) {
      const found = await this.findContact(id);
      if (found) return found;
    }
    return null;
  }

  private async searchContactAny(zaloUserId: string): Promise<any | null> {
    const identifiers = [this.buildIdentifier(zaloUserId), ...this.legacyContactPrefixes().map((p) => `${p}${zaloUserId}`)];
    const direct = await this.findContactByIdentifiers(identifiers);
    if (direct) return direct;

    for (const id of identifiers) {
      try {
        const res = await fetch(
          this.url(`/api/v1/accounts/${this.cfg.accountId}/contacts/search?q=${encodeURIComponent(id)}`),
          { headers: this.headers(), signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS) },
        );
        if (!res.ok) continue;
        const text = await res.text();
        let body: any;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        const payload = body?.payload ?? body?.data ?? body;
        const list = coerceList(payload);
        const match = list.find((c: any) => c?.identifier === id);
        if (match) return match;
      } catch (err) {
        bridgeLogger.warn("[zalo-personal-bridge] contact search failed", err);
      }
    }
    return null;
  }

  async findContact(identifier: string): Promise<any | null> {
    try {
      // search endpoint is more reliable for identifier lookup
      const res = await fetch(
        this.url(`/api/v1/accounts/${this.cfg.accountId}/contacts/search?q=${encodeURIComponent(identifier)}`),
        { headers: this.headers(), signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS) },
      );
      if (!res.ok) return null;
      const text = await res.text();
      let body: any;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      const list = body?.payload ?? body?.data ?? body;
      const arr = coerceList(list);
      const match = arr.find((c: any) => c?.identifier === identifier);
      return match ?? null;
    } catch (err) {
      bridgeLogger.warn("[zalo-personal-bridge] contact lookup failed", err);
      return null;
    }
  }

  async patchContactAvatar(contactId: number, avatarUrl: string) {
    try {
      await this.request(
        `/api/v1/accounts/${this.cfg.accountId}/contacts/${contactId}`,
        {
          method: "PUT",
          headers: this.headers(),
          body: JSON.stringify({ avatar_url: avatarUrl }),
        },
        "patchContactAvatar",
      );
      bridgeLogger.log("[zalo-personal-bridge] contact avatar updated", { contactId, avatarUrl });
    } catch (err) {
      bridgeLogger.warn("[zalo-personal-bridge] contact avatar update failed", err);
    }
  }

  async createContact(params: { zaloUserId: string; threadId?: string; name?: string; avatarUrl?: string }) {
    const identifier = this.buildIdentifier(params.zaloUserId);
    const instance = this.instanceKey();
    const autoNameKey = `${instance}_auto_name`;
    const lastSeenNameKey = `${instance}_last_seen_name`;
    const payload: any = {
      name: params.name || `Zalo ${params.zaloUserId.slice(-4)}`,
      identifier,
      custom_attributes: {
        ...(instance === "zalo"
          ? {
              zalo_uid: params.zaloUserId,
              zalo2_uid: params.zaloUserId,
              zalo_thread_id: params.threadId,
              zalo2_thread_id: params.threadId,
            }
          : {
              [`${instance}_uid`]: params.zaloUserId,
              [`${instance}_thread_id`]: params.threadId,
              zalo_instance: instance,
            }),
        ...(params.name
          ? {
              [autoNameKey]: params.name,
              [lastSeenNameKey]: params.name,
            }
          : {}),
        ...(params.avatarUrl ? { zalo_avatar_url: params.avatarUrl } : {}),
      },
      avatar_url: params.avatarUrl,
    };

    const res = await fetch(this.url(`/api/v1/accounts/${this.cfg.accountId}/contacts`), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    });
    if (res.status === 422) {
      bridgeLogger.warn("[zalo-personal-bridge] createContact 422", await res.text());
      return null;
    }
    const txt = await res.text();
    let parsed: any;
    try {
      parsed = txt ? JSON.parse(txt) : null;
    } catch {
      parsed = txt;
    }
    return this.extractId(parsed?.payload ?? parsed);
  }

  async updateContact(contactId: number, payload: any) {
    return this.request(`/api/v1/accounts/${this.cfg.accountId}/contacts/${contactId}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(payload),
    }, "updateContact");
  }

  async getContact(contactId: number) {
    return this.request(`/api/v1/accounts/${this.cfg.accountId}/contacts/${contactId}`, {
      headers: this.headers(),
    }, "getContact");
  }

  private pickConversationFromList(list: any[], inboxId: number, sourceId?: string | null) {
    if (!Array.isArray(list)) return null;
    const byInbox = list.filter((c) => c?.inbox_id === inboxId);
    if (sourceId) {
      const match = byInbox.find((c: any) => {
        const lastSource = c?.last_non_activity_message?.source_id;
        const messages = Array.isArray(c?.messages) ? c.messages : [];
        const anyMsg = messages.find((m: any) => m?.source_id === sourceId);
        return lastSource === sourceId || !!anyMsg;
      });
      if (match) return match;
    }
    return byInbox[0] || null;
  }

  private async findConversationBySourceId(contactId: number, sourceId: string | null, initialList?: any[]) {
    if (!sourceId) return null;
    const list =
      initialList ??
      (
        await this.request(
          `/api/v1/accounts/${this.cfg.accountId}/contacts/${contactId}/conversations`,
          { headers: this.headers() },
          "listConversations",
        )
      ).body?.payload;
    const found = this.pickConversationFromList(list || [], this.cfg.inboxId, sourceId);
    if (found) return found;
    // if initial list was stale, fetch once more
    if (initialList) {
      const refreshed = (
        await this.request(
          `/api/v1/accounts/${this.cfg.accountId}/contacts/${contactId}/conversations`,
          { headers: this.headers() },
          "listConversations",
        )
      ).body?.payload;
      return this.pickConversationFromList(refreshed || [], this.cfg.inboxId, sourceId);
    }
    // final attempt: fetch once if no initial list and nothing found
    const refreshed = (
      await this.request(
        `/api/v1/accounts/${this.cfg.accountId}/contacts/${contactId}/conversations`,
        { headers: this.headers() },
        "listConversations",
      )
    ).body?.payload;
    return this.pickConversationFromList(refreshed || [], this.cfg.inboxId, sourceId);
  }

  async ensureContactAndConversation(
    zaloUserId: string,
    opts: {
      threadId?: string;
      name?: string;
      avatarUrl?: string;
      skipAvatar?: boolean;
      isSelf?: boolean;
      isGroup?: boolean;
      groupName?: string;
    } = {},
  ) {
    const identifier = this.buildIdentifier(zaloUserId);
    const instance = this.instanceKey();
    const sourcePrefix = this.normalizePrefix(this.cfg.conversationSourceIdPrefix, "");
    const baseSourceId = opts.threadId || identifier;
    const sourceId = sourcePrefix ? `${sourcePrefix}${baseSourceId}` : baseSourceId;
    const identifiers = [identifier, ...this.legacyContactPrefixes().map((p) => `${p}${zaloUserId}`)];
    let contact = await this.findContactByIdentifiers(identifiers);
    let contactId: number | null = contact?.id ?? null;

    if (!contactId) {
      contactId = await this.createContact({
        zaloUserId,
        threadId: opts.threadId,
        name: opts.name,
        avatarUrl: opts.avatarUrl,
      });
      if (!contactId) {
        contact = await this.searchContactAny(zaloUserId);
        contactId = contact?.id ?? null;
        if (contactId) {
          bridgeLogger.log("[zalo-personal-bridge] reuse existing contact after 422/search", {
            contactId,
            identifier,
          });
        }
      }
    }
    if (!contactId) throw new Error("contactId missing after ensure contact");

    // Fetch fresh contact for avatar/name checks
    if (!contact) {
      try {
        const currentRes = await this.getContact(contactId);
        contact = currentRes.body?.payload ?? currentRes.body ?? contact;
      } catch (err) {
        bridgeLogger.warn("[zalo-personal-bridge] getContact failed", err);
      }
    }
    // Update stored threadId/attrs if changed
    try {
      const current = contact || (await this.getContact(contactId)).body?.payload;
      const custom = current?.custom_attributes || {};
      const threadKey = instance === "zalo" ? "zalo2_thread_id" : `${instance}_thread_id`;
      const uidKey = instance === "zalo" ? "zalo2_uid" : `${instance}_uid`;
      const groupIdKey = `${instance}_group_id`;
      const groupNameKey = `${instance}_group_name`;
      const autoNameKey = `${instance}_auto_name`;
      const lastSeenNameKey = `${instance}_last_seen_name`;
      const needsThreadUpdate = opts.threadId && custom?.[threadKey] !== opts.threadId;
      const incomingName = !opts.isSelf && opts.name ? String(opts.name) : null;
      const currentName = typeof current?.name === "string" ? current.name : null;
      const storedAutoName = typeof custom?.[autoNameKey] === "string" ? custom[autoNameKey] : null;
      const storedLastSeenName = typeof custom?.[lastSeenNameKey] === "string" ? custom[lastSeenNameKey] : null;
      const hadManualRename =
        !!incomingName &&
        !!currentName &&
        currentName !== incomingName &&
        // If currentName diverged from what we last auto-managed, treat it as manual.
        // If we have no storedAutoName yet, fall back to lastSeenName.
        currentName !== (storedAutoName || storedLastSeenName || currentName);
      const needsNameUpdate = !!incomingName && !hadManualRename && currentName !== incomingName;
      const hasAvatar = !!current?.thumbnail || !!current?.avatar_url;
      const needsAvatarUpdate =
        !opts.isSelf && !opts.skipAvatar && opts.avatarUrl && (!hasAvatar || current?.avatar_url !== opts.avatarUrl);
      const needsGroupMetaUpdate =
        opts.isGroup &&
        opts.threadId &&
        (custom?.[groupIdKey] !== opts.threadId || (opts.groupName && custom?.[groupNameKey] !== opts.groupName));
      const needsLastSeenNameUpdate =
        !!incomingName && storedLastSeenName !== incomingName && (!hadManualRename || storedLastSeenName !== incomingName);

      if (hadManualRename && incomingName) {
        bridgeLogger.log("[contact-name-skip-manual]", {
          contactId,
          currentName: currentName || null,
          incomingName: incomingName || null,
          storedAutoName: storedAutoName || null,
          storedLastSeenName: storedLastSeenName || null,
        });
      }

      if (needsThreadUpdate || needsNameUpdate || needsAvatarUpdate || needsGroupMetaUpdate || needsLastSeenNameUpdate) {
        await this.updateContact(contactId, {
          name: needsNameUpdate ? opts.name : current?.name,
          avatar_url: needsAvatarUpdate ? opts.avatarUrl : current?.avatar_url,
          custom_attributes: {
            ...custom,
            ...(instance === "zalo"
              ? {
                  zalo_uid: zaloUserId,
                  zalo2_uid: zaloUserId,
                  zalo_thread_id: opts.threadId,
                  zalo2_thread_id: opts.threadId,
                }
              : {
                  [uidKey]: zaloUserId,
                  [threadKey]: opts.threadId,
                  zalo_instance: instance,
                  ...(needsGroupMetaUpdate ? { [groupIdKey]: opts.threadId, [groupNameKey]: opts.groupName || opts.name } : {}),
                }),
            ...(incomingName ? { [lastSeenNameKey]: incomingName } : {}),
            ...(needsNameUpdate && incomingName ? { [autoNameKey]: incomingName } : {}),
          },
        });
      }
      if (needsAvatarUpdate && opts.avatarUrl) {
        await this.patchContactAvatar(contactId, opts.avatarUrl);
      }
    } catch (err) {
      bridgeLogger.warn("[zalo-personal-bridge] contact update skipped", err);
    }

    // contact_inbox
    try {
      const inboxes = await this.request(
        `/api/v1/accounts/${this.cfg.accountId}/contacts/${contactId}/contactable_inboxes`,
        { headers: this.headers() },
        "contactableInboxes",
      );
      const items = inboxes.body?.payload ?? inboxes.body;
      const hasInbox = Array.isArray(items) && items.some((ci: any) => ci?.inbox?.id === this.cfg.inboxId);
      if (!hasInbox) {
        try {
          await this.request(
            `/api/v1/accounts/${this.cfg.accountId}/contacts/${contactId}/contact_inboxes`,
            {
              method: "POST",
              headers: this.headers(),
              body: JSON.stringify({ inbox_id: this.cfg.inboxId, source_id: sourceId }),
            },
            "createContactInbox",
          );
        } catch (err) {
          const isUnique =
            err instanceof ChatwootRequestError &&
            err.status === 422 &&
            typeof err.body?.error === "string" &&
            err.body?.error.toLowerCase().includes("source_id should be unique");
          if (!isUnique) throw err;
          bridgeLogger.warn("[zalo-personal-bridge] contact inbox 422 (source_id unique), continuing");
        }
      }
    } catch (err) {
      bridgeLogger.warn("[zalo-personal-bridge] contact inbox ensure failed", err);
    }

    // conversation
    let conversationId: number | null = null;
    let conversationsPayload: any[] | undefined;
    try {
      const convs = await this.request(
        `/api/v1/accounts/${this.cfg.accountId}/contacts/${contactId}/conversations`,
        { headers: this.headers() },
        "listConversations",
      );
      const items = convs.body?.payload ?? convs.body;
      conversationsPayload = Array.isArray(items) ? items : [];
      const match = this.pickConversationFromList(conversationsPayload, this.cfg.inboxId, sourceId);
      conversationId = match?.id ?? null;
    } catch (err) {
      bridgeLogger.warn("[zalo-personal-bridge] list conversations failed", err);
    }

    if (!conversationId) {
      try {
        const created = await this.request(
          `/api/v1/accounts/${this.cfg.accountId}/conversations`,
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({
              inbox_id: this.cfg.inboxId,
              contact_id: contactId,
              source_id: sourceId,
              additional_attributes: { channel: "zalo_personal", identifier },
            }),
          },
          "createConversation",
        );
        conversationId =
          created.body?.payload?.id ||
          created.body?.id ||
          created.body?.payload?.conversation?.id ||
          this.extractId(created.body);
      } catch (err) {
        const isUnique =
          err instanceof ChatwootRequestError &&
          err.status === 422 &&
          typeof err.body?.error === "string" &&
          err.body?.error.toLowerCase().includes("source_id should be unique");
        if (isUnique) {
          bridgeLogger.warn(
            "[zalo-personal-bridge] createConversation got 422 (source_id unique), trying to reuse existing conversation...",
          );
          const existing = await this.findConversationBySourceId(contactId, sourceId, conversationsPayload);
          if (existing?.id) {
            bridgeLogger.log("[zalo-personal-bridge] reused conversation after 422", { conversationId: existing.id, sourceId });
            conversationId = existing.id;
          }
        } else {
          bridgeLogger.warn("[zalo-personal-bridge] createConversation failed", err);
        }
      }
    }

    if (!conversationId && conversationsPayload) {
      const fallback = this.pickConversationFromList(conversationsPayload, this.cfg.inboxId, null);
      if (fallback?.id) {
        bridgeLogger.log("[zalo-personal-bridge] fallback to existing conversation", { conversationId: fallback.id });
        conversationId = fallback.id;
      }
    }

    if (!conversationId) {
      const altSource = sourceId ? `${sourceId}-dup` : undefined;
      try {
        const created = await this.request(
          `/api/v1/accounts/${this.cfg.accountId}/conversations`,
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({
              inbox_id: this.cfg.inboxId,
              contact_id: contactId,
              source_id: altSource,
              additional_attributes: { channel: "zalo_personal", identifier, dup_from: sourceId },
            }),
          },
          "createConversation",
        );
        conversationId =
          created.body?.payload?.id ||
          created.body?.id ||
          created.body?.payload?.conversation?.id ||
          this.extractId(created.body);
        bridgeLogger.log("[zalo-personal-bridge] created conversation with dup source_id", {
          conversationId,
          sourceId: altSource,
        });
      } catch (err) {
        bridgeLogger.warn("[zalo-personal-bridge] createConversation fallback failed", err);
      }
    }

    if (!conversationId && !conversationsPayload) {
      try {
        const convs = await this.request(
          `/api/v1/accounts/${this.cfg.accountId}/contacts/${contactId}/conversations`,
          { headers: this.headers() },
          "listConversations",
        );
        const items = convs.body?.payload ?? convs.body;
        const fallback = this.pickConversationFromList(Array.isArray(items) ? items : [], this.cfg.inboxId, null);
        if (fallback?.id) {
          bridgeLogger.log("[zalo-personal-bridge] late fallback to existing conversation", { conversationId: fallback.id });
          conversationId = fallback.id;
        }
      } catch (err) {
        bridgeLogger.warn("[zalo-personal-bridge] late list conversations failed", err);
      }
    }

    if (!conversationId) throw new Error("conversationId missing after ensure");
    // avatar update via account API if needed
    if (!opts.isSelf) {
      const thumb = contact?.thumbnail || contact?.avatar_url;
      bridgeLogger.log("[contact-avatar-check]", {
        contactId,
        identifier,
        hasThumbnail: !!thumb,
        avatarUrlPresent: !!opts.avatarUrl,
        avatarUrl: opts.avatarUrl || null,
      });
      if (!thumb && opts.avatarUrl) {
        try {
          await this.request(
            `/api/v1/accounts/${this.cfg.accountId}/contacts/${contactId}`,
            {
              method: "PATCH",
              headers: this.headers(),
              body: JSON.stringify({ avatar_url: opts.avatarUrl }),
            },
            "patchContactAvatar",
          );
          bridgeLogger.log("[contact-avatar-updated]", { contactId, identifier, avatarUrl: opts.avatarUrl });
        } catch (err: any) {
          bridgeLogger.warn("[contact-avatar-error]", {
            contactId,
            identifier,
            avatarUrl: opts.avatarUrl,
            status: err?.status,
            body: err?.body,
          });
        }
      } else {
        bridgeLogger.log("[contact-avatar-skip]", {
          contactId,
          identifier,
          reason: thumb ? "has_thumbnail" : "no_avatar_url",
        });
      }
    }

    return { contactId, conversationId, sourceId };
  }

  async createIncomingMessage(
    conversationId: number,
    payload: {
      content: string;
      attachments?: AttachmentPayload[];
      metadata?: Record<string, unknown>;
      replyToId?: number | null;
      targetZaloMsgId?: string;
    },
  ): Promise<number | null> {
    const attachments =
      payload.attachments?.map((a) => ({
        url: a.url,
        file_type: a.fileType,
        file_name: a.fileName,
      })) || [];

    const res = await this.request(
      `/api/v1/accounts/${this.cfg.accountId}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          content: payload.content,
          message_type: "incoming",
          private: false,
          status: "sent",
          content_type: "text",
          attachments,
          additional_attributes: {
            ...(payload.metadata || {}),
            ...(payload.targetZaloMsgId ? { target_zalo_msg_id: payload.targetZaloMsgId } : {}),
          },
          ...(payload.replyToId ? { reply_to: payload.replyToId, content_attributes: { in_reply_to: payload.replyToId } } : {}),
        }),
      },
      "createIncomingMessage",
    );
    const body: any = res.body?.payload ?? res.body;
    return body?.id ?? body?.message_id ?? null;
  }

  async createIncomingMediaMessage(params: {
    conversationId: number;
    content?: string;
    mediaUrl: string;
    fileName: string;
    type: "image" | "file";
    contentTypeHint?: string;
    zaloMsgId?: string;
    messageType?: "incoming" | "outgoing";
    isPrivate?: boolean;
  }): Promise<number | null> {
    const { conversationId, mediaUrl, fileName } = params;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await axios.get<ArrayBuffer>(mediaUrl, {
        responseType: "arraybuffer",
        signal: controller.signal as any,
      });
      const buffer = Buffer.from(response.data);
      const contentType =
        params.contentTypeHint ||
        (typeof response.headers["content-type"] === "string" ? (response.headers["content-type"] as string) : undefined);
      const form = new FormData();
      const messageType = params.messageType || "incoming";
      const isPrivate = params.isPrivate ?? false;
      form.append("content", params.content || params.type.toUpperCase());
      form.append("message_type", messageType);
      form.append("private", isPrivate ? "true" : "false");
      if (params.zaloMsgId) {
        // Rails multipart supports nested keys like additional_attributes[msgId]
        form.append("additional_attributes[msgId]", params.zaloMsgId);
        form.append("additional_attributes[zalo_msg_id]", params.zaloMsgId);
      }
      form.append("attachments[]", buffer, { filename: fileName, contentType });

      const url = this.url(`/api/v1/accounts/${this.cfg.accountId}/conversations/${conversationId}/messages`);
      this.log("[createIncomingMedia] POST", {
        url,
        hasFile: !!buffer,
        content: params.content,
        message_type: messageType,
        private: isPrivate,
        filename: fileName,
        contentType,
        zaloMsgId: params.zaloMsgId,
      });
      const res = await axios.post(url, form, {
        headers: { api_access_token: this.cfg.apiToken, ...form.getHeaders() },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      const responseBody = res.data;
      const snippet = responseSnippet(responseBody);
      const dataObj = responseObject(responseBody);
      this.log("[createIncomingMedia] response", {
        status: res.status,
        body: snippet,
        url,
        content_type: dataObj?.content_type,
        attachment_file_type: dataObj?.attachments?.[0]?.file_type,
      });
      if (res.status !== 200 && res.status !== 201) {
        bridgeLogger.warn("[zalo-media-error]", {
          status: res.status,
          body: snippet,
          url,
          conversationId,
          mediaUrl,
          type: params.type,
          zaloMsgId: params.zaloMsgId,
        });
        return null;
      }
      const payloadBody: any = (res.data as any)?.payload ?? res.data;
      return payloadBody?.id ?? payloadBody?.message_id ?? null;
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      bridgeLogger.warn("[zalo-media-error]", {
        status,
        body: data,
        url: err?.config?.url,
        conversationId,
        mediaUrl,
        type: params.type,
        zaloMsgId: params.zaloMsgId,
      });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async createAgentMessageFromNative(
    conversationId: number,
    payload: { content: string; metadata?: Record<string, unknown> },
  ): Promise<number | null> {
    const res = await this.request(
      `/api/v1/accounts/${this.cfg.accountId}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          content: payload.content,
          message_type: "outgoing",
          private: true,
          status: "sent",
          content_type: "text",
          additional_attributes: { source: "zalo_native", ...(payload.metadata || {}) },
        }),
      },
      "createAgentMessageFromNative",
    );
    const body: any = res.body?.payload ?? res.body;
    return body?.id ?? body?.message_id ?? null;
  }

  async createSystemNote(
    conversationId: number,
    payload: { content: string; metadata?: Record<string, unknown> },
  ): Promise<number | null> {
    const res = await this.request(
      `/api/v1/accounts/${this.cfg.accountId}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          content: payload.content,
          message_type: "outgoing",
          private: true,
          status: "sent",
          content_type: "text",
          additional_attributes: { source: "zalo_system", ...(payload.metadata || {}) },
        }),
      },
      "createSystemNote",
    );
    const body: any = res.body?.payload ?? res.body;
    return body?.id ?? body?.message_id ?? null;
  }

  async createReactionNote(
    conversationId: number,
    payload: {
      actorName?: string;
      reactionType?: string;
      replyToId?: number | null;
      preview?: string;
      targetZaloMsgId?: string;
      contentOverride?: string;
    },
  ): Promise<void> {
    const reactionEmojiMap: Record<string, string> = {
      "/-strong": "👍",
      "/-heart": "❤️",
      ":>": "😂",
      ":o": "😮",
      ":-h": "😡",
      ":-((": "😭",
    };
    const reactionLabel = reactionEmojiMap[payload.reactionType || ""] || payload.reactionType || "reaction";
    const actor = payload.actorName || "Contact";
    const target = payload.preview ? `"${payload.preview}"` : undefined;
    const content =
      payload.contentOverride ||
      (target
        ? `${actor} reacted with ${reactionLabel} to: ${target}`
        : payload.targetZaloMsgId
          ? `${actor} reacted with ${reactionLabel} to an earlier message`
          : `${actor} reacted with ${reactionLabel}`);
    const body = {
      content,
      message_type: "outgoing",
      private: true,
      status: "sent",
      content_type: "text",
      additional_attributes: {
        source: "zalo_reaction",
        reaction: payload.reactionType,
        target_zalo_msg_id: payload.targetZaloMsgId,
      },
      ...(payload.replyToId ? { reply_to: payload.replyToId, content_attributes: { in_reply_to: payload.replyToId } } : {}),
    };
    try {
      await this.request(
        `/api/v1/accounts/${this.cfg.accountId}/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
        },
        "createReactionNote",
      );
    } catch (err) {
      bridgeLogger.warn("[zalo-personal-bridge] reaction note failed", err);
    }
  }

  async getConversation(conversationId: number) {
    return this.request(
      `/api/v1/accounts/${this.cfg.accountId}/conversations/${conversationId}`,
      { headers: this.headers() },
      "getConversation",
    );
  }

  async listConversationMessages(conversationId: number, perPage = 50): Promise<any[]> {
    try {
      const res = await this.request(
        `/api/v1/accounts/${this.cfg.accountId}/conversations/${conversationId}/messages?per_page=${perPage}&include_private=true`,
        { headers: this.headers() },
        "listConversationMessages",
      );
      const body: any = res.body?.payload ?? res.body?.data ?? res.body;
      if (Array.isArray(body)) return body;
      if (Array.isArray(body?.messages)) return body.messages;
      return [];
    } catch (err) {
      bridgeLogger.warn("[zalo-personal-bridge] listConversationMessages failed", err);
      return [];
    }
  }

  async findMessageByZaloMsgId(
    conversationId: number,
    zaloMsgId: string,
  ): Promise<{ cwId: number; preview: string } | null> {
    const perPage = 50;
    // Include private messages and page further so reactions to older/self notes
    // can still be resolved to a target message.
    const maxPages = 20;
    for (let page = 1; page <= maxPages; page++) {
      const messages = await this.listConversationMessagesPaged(conversationId, perPage, page);
      const found = messages.find((m: any) => {
        const attrs = m?.additional_attributes || m?.additionalAttributes || {};
        const contentAttrs = m?.content_attributes || m?.contentAttributes || {};
        return (
          String(attrs?.msgId || attrs?.zalo_msg_id || attrs?.target_zalo_msg_id || "") === String(zaloMsgId) ||
          String(contentAttrs?.msgId || contentAttrs?.zalo_msg_id || "") === String(zaloMsgId)
        );
      });
      if (!found) {
        if (messages.length < perPage) break; // no more pages
        continue;
      }
      const cwId = typeof found.id === "number" ? found.id : found.message_id;
      if (!cwId) return null;
      const content = typeof found.content === "string" ? found.content : "";
      if (content.trim()) {
        return { cwId, preview: content.slice(0, 80) };
      }
      const att = Array.isArray(found.attachments) ? found.attachments[0] : null;
      const ft = (att?.file_type || "").toString().toLowerCase();
      let preview = "message";
      if (ft.includes("image")) {
        preview = "IMAGE";
      } else if (att) {
        preview = "FILE";
      }
      return { cwId, preview };
    }
    return null;
  }

  private async listConversationMessagesPaged(conversationId: number, perPage: number, page: number): Promise<any[]> {
    try {
      const res = await this.request(
        `/api/v1/accounts/${this.cfg.accountId}/conversations/${conversationId}/messages?per_page=${perPage}&page=${page}&include_private=true`,
        { headers: this.headers() },
        "listConversationMessagesPaged",
      );
      const body: any = res.body?.payload ?? res.body?.data ?? res.body;
      if (Array.isArray(body)) return body;
      if (Array.isArray(body?.messages)) return body.messages;
      return [];
    } catch {
      return [];
    }
  }

  private async publicUpdateContact(contactIdentifier: string, body: any) {
    await this.request(
      `/public/api/v1/inboxes/${this.cfg.inboxIdentifier}/contacts/${encodeURIComponent(contactIdentifier)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      "publicUpdateContact",
    );
  }
}
