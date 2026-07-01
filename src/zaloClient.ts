import fs from "fs";
import path from "path";
import { Zalo, ThreadType, type Message, type Reaction, type Credentials, type API } from "@warriorteam/zalo-personal";

export type ZaloEventType = "text" | "image" | "file" | "sticker" | "reaction";

export interface ZaloEvent {
  threadId: string;
  msgId: string;
  fromId: string;
  isSelf: boolean;
  type: ZaloEventType;
  text?: string;
  mediaUrl?: string;
  fileName?: string;
  reactionType?: string;
  displayName?: string;
  avatarUrl?: string;
  threadDisplayName?: string;
  targetMsgId?: string;
  targetPreview?: string;
  quote?: Record<string, unknown>;
  stickerId?: string;
}

export type ZaloMentionPayload = {
  pos: number;
  uid: string;
  len: number;
};

export interface ZaloClient {
  connect(): Promise<void>;
  onEvent(handler: (event: ZaloEvent) => void): void;
  getSelfUid(): string | null;
  sendText(
    threadId: string,
    text: string,
    quote?: Record<string, unknown> | null,
    mentions?: ZaloMentionPayload[],
  ): Promise<string | null>;
  sendImage(threadId: string, imageUrl: string, fileName?: string): Promise<string | null>;
  sendImageBuffer(threadId: string, buffer: Buffer, fileName?: string): Promise<string | null>;
  sendFile(threadId: string, fileUrl: string, fileName?: string): Promise<string | null>;
  resolveStickerUrl(stickerId: string | number): Promise<string | null>;
  fetchProfile(uid: string): Promise<{ displayName?: string; avatarUrl?: string } | null>;
  fetchGroup(threadId: string): Promise<{ name?: string; avatarUrl?: string } | null>;
}

type ZaloClientConfig = {
  imei: string;
  userAgent: string;
  language?: string;
  cookieJson?: string;
  sessionFile?: string;
};

const MEDIA_FETCH_TIMEOUT_MS = 60_000;
const bridgeLogger = globalThis.console;

type StoredSession = {
  imei?: string;
  userAgent?: string;
  language?: string;
  cookie?: any;
  context?: {
    uid?: string;
    secretKey?: string | null;
    settings?: any;
    extraVer?: any;
    loginInfo?: any;
    apiType?: number;
    apiVersion?: number;
    selfUid?: string | null;
  };
};

type InternalContext = {
  API_TYPE: number;
  API_VERSION: number;
  options: Record<string, any>;
  imei?: string;
  cookie?: any;
  userAgent?: string;
  language?: string;
  secretKey?: string | null;
  uid?: string;
  settings?: any;
  extraVer?: any;
  loginInfo?: any;
  uploadCallbacks?: Map<string, unknown>;
};

function getZaloInternalModules() {
  const zaloEntrypoint = require.resolve("@warriorteam/zalo-personal");
  const zaloPackageDir = path.resolve(path.dirname(zaloEntrypoint), "..", "..");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const contextModule = require(path.join(zaloPackageDir, "dist/cjs/context.cjs"));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const apisModule = require(path.join(zaloPackageDir, "dist/cjs/apis.cjs"));
  return { contextModule, apisModule };
}

function parseCookie(raw: string | undefined): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error("Failed to parse ZALO_COOKIE_JSON: " + (err as Error).message);
  }
}

function normalizeCredentials(config: ZaloClientConfig, stored: StoredSession | null): Credentials {
  const cookie = stored?.cookie ?? parseCookie(config.cookieJson || "") ?? undefined;
  if (!cookie) {
    throw new Error("Zalo cookie not provided (ZALO_COOKIE_JSON or session file)");
  }

  const imei = stored?.imei || config.imei;
  const userAgent = stored?.userAgent || config.userAgent;
  const language = stored?.language || config.language || "vi";

  if (!imei || !userAgent) {
    throw new Error("ZALO_IMEI and ZALO_USER_AGENT must be provided");
  }

  return {
    imei,
    cookie,
    userAgent,
    language,
  };
}

export class ZaloPersonalClient implements ZaloClient {
  private api: API | null = null;
  private handlers: Array<(event: ZaloEvent) => void> = [];
  private profileCache = new Map<string, { displayName?: string; avatarUrl?: string; exp: number }>();
  private profileLogged = new Set<string>();
  private groupCache = new Map<string, { name?: string; avatarUrl?: string; exp: number }>();
  private selfUid: string | null = null;

  constructor(private config: ZaloClientConfig) {}

  async connect(): Promise<void> {
    if (this.api) return;
    const stored = await this.loadSession();
    const credentials = normalizeCredentials(this.config, stored);

    const zalo = new Zalo({ selfListen: true, logging: false });
    this.api = (await this.tryRestoreFromSavedContext(zalo, stored, credentials)) || (await zalo.login(credentials));

    this.api.listener.on("message", (message) => this.handleMessage(message));
    this.api.listener.on("reaction", (reaction) => this.handleReaction(reaction));
    this.api.listener.start();

    await this.persistSession(credentials);
  }

  onEvent(handler: (event: ZaloEvent) => void): void {
    this.handlers.push(handler);
  }

  getSelfUid(): string | null {
    return this.selfUid;
  }

  async sendText(
    threadId: string,
    text: string,
    quote?: Record<string, unknown> | null,
    mentions?: ZaloMentionPayload[],
  ): Promise<string | null> {
    if (!this.api) throw new Error("Zalo client not connected");
    const isGroup = threadId.startsWith("group:");
    const actualThreadId = isGroup ? threadId.slice("group:".length) : threadId;
    const validMentions = isGroup && Array.isArray(mentions) && mentions.length ? mentions : undefined;
    const message: any = quote || validMentions ? { msg: text, quote: quote || undefined, mentions: validMentions } : text;
    const result = await this.api.sendMessage(message, actualThreadId, isGroup ? ThreadType.Group : ThreadType.User);
    const msgId = result?.message?.msgId ?? null;
    return msgId ? String(msgId) : null;
  }

  async sendImage(threadId: string, imageUrl: string, fileName?: string): Promise<string | null> {
    if (!this.api) throw new Error("Zalo client not connected");
    const isGroup = threadId.startsWith("group:");
    const actualThreadId = isGroup ? threadId.slice("group:".length) : threadId;
    const derivedName = fileName || this.deriveFilename(imageUrl, undefined, "jpg");
    try {
      const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) });
      if (resp.ok) {
        const arr = await resp.arrayBuffer();
        const buf = Buffer.from(arr);
        const msgId = await this.sendImageBuffer(threadId, buf, derivedName);
        if (msgId) return msgId;
      }
      bridgeLogger.warn("[zalo-send-attachment-error]", {
        type: "image",
        filename: derivedName,
        url: imageUrl,
        status: resp.status,
        message: "download_failed",
      });
    } catch (err) {
      bridgeLogger.warn("[zalo-send-attachment-error]", {
        type: "image",
        filename: derivedName,
        url: imageUrl,
        message: (err as Error).message,
      });
    }
    // fallback to URL-based attachment (proper schema), if buffer path failed
    try {
      const attachment: any = {
        url: imageUrl,
        filename: derivedName,
      };
      const result = await this.api.sendMessage(
        { msg: derivedName || "", attachments: attachment },
        actualThreadId,
        isGroup ? ThreadType.Group : ThreadType.User,
      );
      const attachmentId = result?.attachment?.[0]?.msgId ?? null;
      return attachmentId ? String(attachmentId) : null;
    } catch (err) {
      bridgeLogger.warn("[zalo-send-attachment-error]", {
        type: "image",
        filename: derivedName,
        url: imageUrl,
        message: (err as Error).message,
      });
      return null;
    }
  }

  private inferImageDimensions(buffer: Buffer): { width: number; height: number } | null {
    if (buffer.length < 24) return null;
    // PNG: width/height at bytes 16-23, big-endian.
    const isPng =
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47;
    if (isPng && buffer.length >= 24) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (width && height) return { width, height };
    }
    // JPEG: scan for SOF0/SOF2.
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
    if (isJpeg) {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buffer[i + 1];
        // SOF0 (0xC0), SOF2 (0xC2)
        if (marker === 0xc0 || marker === 0xc2) {
          const height = buffer.readUInt16BE(i + 5);
          const width = buffer.readUInt16BE(i + 7);
          if (width && height) return { width, height };
          return null;
        }
        const size = buffer.readUInt16BE(i + 2);
        if (size < 2) break;
        i += 2 + size;
      }
    }
    return null;
  }

  async sendImageBuffer(threadId: string, buffer: Buffer, fileName?: string): Promise<string | null> {
    if (!this.api) throw new Error("Zalo client not connected");
    const isGroup = threadId.startsWith("group:");
    const actualThreadId = isGroup ? threadId.slice("group:".length) : threadId;
    const dims = this.inferImageDimensions(buffer);
    const attachment: any = {
      data: buffer,
      filename: fileName || "image.jpg",
      metadata: {
        totalSize: buffer.length,
        ...(dims ? { width: dims.width, height: dims.height } : {}),
      },
    };
    const result = await this.api.sendMessage(
      { msg: "", attachments: attachment },
      actualThreadId,
      isGroup ? ThreadType.Group : ThreadType.User,
    );
    const attachmentId = result?.attachment?.[0]?.msgId ?? null;
    return attachmentId ? String(attachmentId) : null;
  }

  async sendFile(threadId: string, fileUrl: string, fileName?: string): Promise<string | null> {
    if (!this.api) throw new Error("Zalo client not connected");
    const isGroup = threadId.startsWith("group:");
    const actualThreadId = isGroup ? threadId.slice("group:".length) : threadId;
    const derivedName = fileName || this.deriveFilename(fileUrl, undefined, "bin");
    try {
      const resp = await fetch(fileUrl, { signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS) });
      if (resp.ok) {
        const arr = await resp.arrayBuffer();
        const buf = Buffer.from(arr);
        try {
          const attachment: any = {
            data: buf,
            filename: derivedName,
            metadata: {
              totalSize: buf.length,
            },
          };
          const result = await this.api.sendMessage(
            { msg: "", attachments: attachment },
            actualThreadId,
            isGroup ? ThreadType.Group : ThreadType.User,
          );
          const attachmentId = result?.attachment?.[0]?.msgId ?? null;
          return attachmentId ? String(attachmentId) : null;
        } catch (err) {
          bridgeLogger.warn("[zalo-send-attachment-error]", {
            type: "file",
            filename: derivedName,
            url: fileUrl,
            message: (err as Error).message,
          });
        }
      }
      bridgeLogger.warn("[zalo-send-attachment-error]", {
        type: "file",
        filename: derivedName,
        url: fileUrl,
        status: resp.status,
        message: "download_failed",
      });
    } catch (err) {
      bridgeLogger.warn("[zalo-send-attachment-error]", {
        type: "file",
        filename: derivedName,
        url: fileUrl,
        message: (err as Error).message,
      });
    }
    // fallback to URL-based attachment (proper schema)
    try {
      const attachment: any = {
        url: fileUrl,
        filename: derivedName,
      };
      const result = await this.api.sendMessage(
        { msg: "", attachments: attachment },
        actualThreadId,
        isGroup ? ThreadType.Group : ThreadType.User,
      );
      const attachmentId = result?.attachment?.[0]?.msgId ?? null;
      return attachmentId ? String(attachmentId) : null;
    } catch (err) {
      bridgeLogger.warn("[zalo-send-attachment-error]", {
        type: "file",
        filename: derivedName,
        url: fileUrl,
        message: (err as Error).message,
      });
      return null;
    }
  }

  private emit(event: ZaloEvent) {
    bridgeLogger.log("[zalo-event]", JSON.stringify(event));
    this.handlers.forEach((h) => h(event));
  }

  async resolveStickerUrl(stickerId: string | number): Promise<string | null> {
    if (!this.api) return null;
    try {
      const details = await (this.api as any).getStickersDetail?.(stickerId);
      const first = details?.[0];
      const url = first?.stickerUrl || first?.stickerWebpUrl || first?.stickerSpriteUrl;
      if (url) {
        bridgeLogger.log("[zalo-sticker-url-resolved]", { stickerId, url });
        return url;
      }
    } catch (err) {
      bridgeLogger.warn("[zalo-sticker-error]", err);
    }
    return null;
  }

  private handleMessage(message: Message) {
    const data: any = (message as any).data ?? {};
    const content = data.content;
    const msgType: string = data.msgType || "";
    const msgId = String(data.msgId || data.cliMsgId || "");
    const fromId = String(data.uidFrom || data.userId || "");
    const rawIsSelf = !!(message as any).isSelf;
    if (rawIsSelf && fromId) this.selfUid = fromId;
    const isSelf = rawIsSelf || (!!this.selfUid && fromId === this.selfUid);
    const displayName: string | undefined = data.dName || data.displayName || data.name;
    // For groups, prefer explicit thread/group name fields only.
    // Do NOT fall back to sender display name here, otherwise group name becomes unstable per message.
    const threadDisplayName: string | undefined =
      (message as any).threadName || data.threadName || data.thread_name || data.groupName || data.group_name || undefined;
    const avatarUrl: string | undefined = data.avatar || data.avatarUrl;
    const quote: any = data.quote || undefined;
    const targetMsgId =
      quote?.globalMsgId ??
      quote?.msgId ??
      quote?.cliMsgId ??
      quote?.qmsgId ??
      quote?.qmsgCliId ??
      undefined;
    let targetPreview: string | undefined;
    if (typeof quote?.msg === "string") {
      targetPreview = quote.msg;
    } else if (typeof quote?.content === "string") {
      targetPreview = quote.content;
    } else if (quote?.attach) {
      targetPreview = "Photo";
    }
    const base = {
      threadId: String(message.threadId),
      msgId,
      fromId,
      isSelf,
    };

    let type: ZaloEventType = "text";
    let text: string | undefined;
    let mediaUrl: string | undefined;
    let fileName: string | undefined;
    let stickerId: string | undefined;

    const contentObj = typeof content === "string" ? null : content || {};
    const quotePayload =
      data.msgId && data.uidFrom
        ? {
            content,
            msgType,
            propertyExt: data.propertyExt,
            uidFrom: data.uidFrom,
            msgId: data.msgId,
            cliMsgId: data.cliMsgId || data.msgId,
            ts: data.ts || Date.now(),
            ttl: data.ttl || 0,
          }
        : undefined;

    switch (msgType) {
      case "chat.photo":
      case "photo":
        type = "image";
        mediaUrl = contentObj?.href || data.href;
        text =
          typeof content === "string"
            ? content
            : contentObj?.msg ||
              contentObj?.caption ||
              contentObj?.description ||
              contentObj?.text ||
              contentObj?.title ||
              data.msg ||
              data.caption ||
              data.description ||
              data.text ||
              data.title ||
              undefined;
        if (!text && contentObj?.params) {
          try {
            const params = typeof contentObj.params === "string" ? JSON.parse(contentObj.params) : contentObj.params;
            text = params?.caption || params?.msg || params?.text || params?.title || text;
          } catch {
            // ignore
          }
        }
        fileName = contentObj?.fileName || this.deriveFilename(mediaUrl, msgId, "jpg");
        if (!text) {
          try {
            const parsed =
              typeof content === "string" && content.trim().startsWith("{") ? JSON.parse(content) : null;
            text = parsed?.msg || parsed?.caption || parsed?.description || parsed?.text || text;
          } catch {
            // ignore
          }
        }
        if (!text) {
          bridgeLogger.log("[zalo-photo-raw]", {
            msgId,
            keys: Object.keys(data || {}),
            contentKeys: Object.keys(contentObj || {}),
            paramsKeys:
              contentObj?.params && typeof contentObj.params === "object"
                ? Object.keys(contentObj.params)
                : undefined,
          });
        }
        break;
      case "chat.file":
      case "file":
        type = "file";
        mediaUrl = contentObj?.href || data.href;
        fileName = contentObj?.fileName || contentObj?.title || this.deriveFilename(mediaUrl, msgId, "bin");
        text =
          typeof content === "string"
            ? content
            : contentObj?.description ||
              contentObj?.msg ||
              contentObj?.caption ||
              contentObj?.text ||
              contentObj?.title ||
              undefined;
        break;
    case "chat.sticker":
    case "sticker":
      type = "sticker";
      mediaUrl = contentObj?.href || data.href || contentObj?.stickerUrl;
      stickerId = contentObj?.stickerId || contentObj?.sticker || contentObj?.id || msgId;
      fileName = contentObj?.stickerId ? `sticker-${contentObj.stickerId}.webp` : this.deriveFilename(mediaUrl, msgId, "webp");
      bridgeLogger.log("[zalo-sticker-raw]", JSON.stringify(contentObj || content, null, 2));
      break;
      default:
        type = "text";
        text = typeof content === "string" ? content : contentObj?.msg || contentObj?.text || JSON.stringify(content);
        break;
    }

    const event: ZaloEvent = {
      ...base,
      type,
      text,
      mediaUrl,
      fileName,
      displayName,
      avatarUrl,
      threadDisplayName,
      targetMsgId: targetMsgId ? String(targetMsgId) : undefined,
      targetPreview,
      quote: quotePayload,
      stickerId,
    };
    this.emit(event);
  }

  private deriveFilename(url?: string, msgId?: string, fallbackExt?: string) {
    const ext = fallbackExt || "bin";
    const fallbackName = msgId ? `${msgId}.${ext}` : `file.${ext}`;
    if (!url) return fallbackName;
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split("/");
      const last = parts.pop() || "";
      if (last && last.includes(".")) return last;
      return msgId ? `${msgId}.${ext}` : last || fallbackName;
    } catch {
      return fallbackName;
    }
  }

  private handleReaction(reaction: Reaction) {
    const data: any = (reaction as any).data ?? {};
    const content: any = data.content || {};
    const msgId = String(data.msgId || content?.rMsg?.[0]?.gMsgID || content?.rMsg?.[0]?.cMsgID || "");
    const targetMsgId = content?.rMsg?.[0]?.gMsgID || content?.rMsg?.[0]?.cMsgID || msgId;
    const fromId = String(data.uidFrom || "");
    const rawIsSelf = !!(reaction as any).isSelf;
    if (rawIsSelf && fromId) this.selfUid = fromId;
    const isSelf = rawIsSelf || (!!this.selfUid && fromId === this.selfUid);

    const event: ZaloEvent = {
      threadId: String((reaction as any).threadId || ""),
      msgId,
      fromId,
      isSelf,
      type: "reaction",
      reactionType: content?.rIcon || content?.rType,
      targetMsgId: targetMsgId ? String(targetMsgId) : undefined,
    };
    this.emit(event);
  }

  private async loadSession(): Promise<StoredSession | null> {
    if (!this.config.sessionFile) return null;
    try {
      const fullPath = path.resolve(this.config.sessionFile);
      const raw = await fs.promises.readFile(fullPath, "utf8");
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  }

  private async tryRestoreFromSavedContext(
    zalo: Zalo,
    stored: StoredSession | null,
    credentials: Credentials,
  ): Promise<API | null> {
    const saved = stored?.context;
    if (!saved?.secretKey || !saved?.loginInfo?.zpw_service_map_v3 || !saved?.loginInfo?.zpw_ws) {
      return null;
    }

    try {
      const { contextModule, apisModule } = getZaloInternalModules();
      const ctx = contextModule.createContext(
        saved.apiType ?? (zalo as any).options?.apiType,
        saved.apiVersion ?? (zalo as any).options?.apiVersion,
      ) as InternalContext;
      Object.assign(ctx.options, (zalo as any).options);
      ctx.imei = credentials.imei;
      ctx.userAgent = credentials.userAgent;
      ctx.language = credentials.language || "vi";
      ctx.cookie = (zalo as any).parseCookies(credentials.cookie);
      ctx.uid = saved.uid;
      ctx.secretKey = saved.secretKey;
      ctx.settings = saved.settings;
      ctx.extraVer = saved.extraVer;
      ctx.loginInfo = saved.loginInfo;

      const api = new apisModule.API(ctx, saved.loginInfo.zpw_service_map_v3, saved.loginInfo.zpw_ws) as API;
      await (api as any).fetchAccountInfo?.();
      if (saved.selfUid) this.selfUid = saved.selfUid;
      bridgeLogger.log("[zalo-personal-bridge] restored API from saved session context");
      return api;
    } catch (err) {
      bridgeLogger.warn("[zalo-personal-bridge] failed to restore saved context", (err as Error).message);
      return null;
    }
  }

  async fetchProfile(uid: string): Promise<{ displayName?: string; avatarUrl?: string } | null> {
    if (!this.api || !uid) return null;
    const cached = this.profileCache.get(uid);
    if (cached && cached.exp > Date.now()) {
      bridgeLogger.log("[zalo-profile-cache-hit]", { uid });
      return { displayName: cached.displayName, avatarUrl: cached.avatarUrl };
    }
    try {
      bridgeLogger.log("[zalo-profile-fetch]", { uid });
      const info = await (this.api as any).getUserInfo?.(uid);
      if (!info) return null;
      if (!this.profileLogged.has(uid)) {
        this.profileLogged.add(uid);
        try {
          const raw = info as any;
          bridgeLogger.log("[zalo-profile-raw]", {
            uid,
            rawKeys: Object.keys(raw || {}),
            avatarCandidates: {
              avatar: raw?.avatar,
              avatarUrl: raw?.avatarUrl,
              avatar_url: raw?.avatar_url,
              userAvatar: raw?.userAvatar,
              thumbnail: raw?.thumbnail,
              thumb: raw?.thumb,
              picture: raw?.picture,
            },
            displayNameCandidates: {
              displayName: raw?.displayName,
              name: raw?.name,
              fullname: raw?.fullname,
              userName: raw?.userName,
            },
          });
        } catch {
          // ignore
        }
      }
      const raw: any =
        (info as any)?.changed_profiles?.[uid] ||
        (info as any)?.changed_profiles?.[String(uid)] ||
        (info as any)?.unchanged_profiles?.[uid] ||
        (info as any)?.unchanged_profiles?.[String(uid)] ||
        (info as any)?.profiles?.[uid] ||
        (info as any);
      const displayName =
        raw?.displayName ||
        raw?.name ||
        raw?.fullname ||
        raw?.userName ||
        raw?.zaloName ||
        undefined;
      const avatarUrl =
        raw?.avatarUrl ||
        raw?.avatar ||
        raw?.avatar_url ||
        raw?.userAvatar ||
        raw?.thumbnail ||
        raw?.thumb ||
        raw?.picture ||
        raw?.changed_profiles?.[uid]?.avatar ||
        undefined;
      this.profileCache.set(uid, { displayName, avatarUrl, exp: Date.now() + 30 * 60 * 1000 });
      return { displayName, avatarUrl };
    } catch (err) {
      bridgeLogger.warn("[zalo-profile-error]", { uid, message: (err as Error)?.message });
      return null;
    }
  }

  private async persistSession(credentials: Credentials) {
    if (!this.config.sessionFile || !this.api) return;
    try {
      const cookieJar = this.api.getCookie();
      const serialized = cookieJar.toJSON();
      if (!serialized) return;
      const serializedCookies = Array.isArray((serialized as any).cookies)
        ? (serialized as any).cookies
        : serialized;
      const ctx = (this.api as any).getContext?.() as InternalContext | undefined;
      const payload: StoredSession = {
        imei: credentials.imei,
        userAgent: credentials.userAgent,
        language: credentials.language,
        cookie: serializedCookies,
        context: ctx
          ? {
              uid: ctx.uid,
              secretKey: ctx.secretKey,
              settings: ctx.settings,
              extraVer: ctx.extraVer,
              loginInfo: ctx.loginInfo,
              apiType: ctx.API_TYPE,
              apiVersion: ctx.API_VERSION,
              selfUid: this.selfUid,
            }
          : undefined,
      };
      await fs.promises.mkdir(path.dirname(this.config.sessionFile), { recursive: true });
      await fs.promises.writeFile(this.config.sessionFile, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      bridgeLogger.warn("[zalo-personal-bridge] failed to persist session", err);
    }
  }

  async fetchGroup(threadId: string): Promise<{ name?: string; avatarUrl?: string } | null> {
    if (!this.api || !threadId) return null;
    const cached = this.groupCache.get(threadId);
    if (cached && cached.exp > Date.now()) return { name: cached.name, avatarUrl: cached.avatarUrl };
    try {
      const raw = await (this.api as any).getGroupInfo?.(threadId);
      const pickFrom = (obj: any) => {
        if (!obj || typeof obj !== "object") return null;
        const name =
          obj.name || obj.groupName || obj.group_name || obj.title || obj.displayName || obj.dName || obj.gName;
        const avatarUrl =
          obj.avatar || obj.avatarUrl || obj.avatar_url || obj.picture || obj.thumb || obj.thumbnail || obj.groupAvatar;
        const groupName = typeof name === "string" ? name : undefined;
        const groupAvatarUrl = typeof avatarUrl === "string" ? avatarUrl : undefined;
        return { name: groupName, avatarUrl: groupAvatarUrl };
      };
      let info: any = null;
      if (Array.isArray(raw)) {
        info = raw[0];
      } else if (raw?.data && typeof raw.data === "object") {
        info = raw.data[threadId] || raw.data?.gridInfoMap?.[threadId] || raw.data?.grid_info_map?.[threadId] || raw.data;
      } else if (raw && typeof raw === "object") {
        info = raw[threadId] || raw?.gridInfoMap?.[threadId] || raw?.grid_info_map?.[threadId] || raw?.data?.[threadId] || raw;
      }
      const picked = pickFrom(info) || pickFrom(info?.group) || pickFrom(info?.info);
      if (picked?.name || picked?.avatarUrl) {
        this.groupCache.set(threadId, { ...picked, exp: Date.now() + 30 * 60_000 });
        bridgeLogger.log("[zalo-group-info]", { threadId, name: picked.name || null, hasAvatar: !!picked.avatarUrl });
        return picked;
      }
      this.groupCache.set(threadId, { name: undefined, avatarUrl: undefined, exp: Date.now() + 10 * 60_000 });
      return null;
    } catch (err) {
      bridgeLogger.warn("[zalo-group-info-error]", { threadId, message: (err as Error).message });
      return null;
    }
  }
}
