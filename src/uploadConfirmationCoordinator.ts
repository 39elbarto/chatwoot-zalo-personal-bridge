import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";

const DEADLINE_MS = 90_000;
const QUARANTINE_MS = 5 * 60_000;
const MAX_EVENTS = 64;
type UploadCallback = (data: any) => unknown;
type Scope = { closed: boolean; keys: Set<string>; early: Map<string, any>; matched: Set<string>; confirmed: Map<string, any>; pending: Map<string, UploadCallback[]>; observedRegistration: boolean; cancel?: () => void; cancelCooldown?: () => void };

/** Coordinates SDK 1.4.1's HTTP response and listener callback without treating HTTP success as confirmation. */
export function installUploadConfirmationCoordinator(api: any, deadlineMs = DEADLINE_MS): void {
  const root = path.resolve(path.dirname(require.resolve("@warriorteam/zalo-personal")), "../..");
  let manifest: { version?: string };
  try {
    manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    throw new Error("zalo_upload_coordinator_incompatible_sdk");
  }
  const sdkFiles = ["dist/apis/sendMessage.js", "dist/cjs/apis/sendMessage.cjs"];
  const hasExpectedSendPath = sdkFiles.every((file) =>
    readFileSync(path.join(root, file), "utf8").includes("await api.uploadAttachment(attachments, threadId, type)"));
  const hasExpectedCallbackPath = ["dist/apis", "dist/cjs/apis"].every((directory) => {
    const ext = directory.includes("/cjs/") ? "cjs" : "js";
    const listenerSource = readFileSync(path.join(root, directory, `listen.${ext}`), "utf8");
    const uploadSource = readFileSync(path.join(root, directory, `uploadAttachment.${ext}`), "utf8");
    return listenerSource.includes("this.ctx.uploadCallbacks.get(String(control.content.fileId))") &&
      listenerSource.includes('this.emit("upload_attachment", data)') && uploadSource.includes("ctx.uploadCallbacks.set(");
  });
  const listener = api?.listener;
  const callbacks: Map<string, UploadCallback> = listener?.ctx?.uploadCallbacks;
  if (manifest.version !== "1.4.1" || typeof api?.uploadAttachment !== "function" ||
      typeof api?.sendMessage !== "function" || !hasExpectedSendPath || !hasExpectedCallbackPath ||
      !callbacks || typeof callbacks.set !== "function" || typeof callbacks.get !== "function" ||
      typeof callbacks.delete !== "function" || typeof listener?.on !== "function") {
    throw new Error("zalo_upload_coordinator_incompatible_sdk");
  }
  const originalUpload = api.uploadAttachment.bind(api); // ubs:ignore - Binding a function does not create a promise.
  const set = callbacks.set.bind(callbacks);
  const remove = callbacks.delete.bind(callbacks);
  const storage = new AsyncLocalStorage<Scope>();
  const owners = new Map<string, Scope>();
  const retired = new Map<string, number>();
  let active: Scope | undefined;
  let quarantineUntil = 0;
  const prune = () => {
    const now = Date.now();
    for (const [key, expiry] of retired) if (expiry <= now) retired.delete(key);
  };
  const retire = (key: string) => {
    prune();
    if (retired.size >= MAX_EVENTS && !retired.has(key)) {
      quarantineUntil = Date.now() + QUARANTINE_MS;
      retired.clear();
    }
    retired.set(key, Date.now() + QUARANTINE_MS);
  };
  callbacks.set = function (key: string, callback: UploadCallback) {
    const scope = storage.getStore();
    if (!scope) return set(key, callback);
    if (scope.closed) return this;
    key = String(key);
    scope.observedRegistration = true;
    prune();
    scope.keys.add(key);
    owners.set(key, scope);
    const confirmed = scope.confirmed.get(key);
    if (confirmed) {
      queueMicrotask(() => { if (!scope.closed) void Promise.resolve(callback(confirmed)).catch(() => undefined); });
      return this;
    }
    const blocked = retired.has(key) || Date.now() < quarantineUntil;
    if (blocked) {
      console.warn("[zalo-upload] confirmation ID is temporarily unavailable");
      scope.cancelCooldown?.();
      return this;
    }
    const pending = scope.pending.get(key) || [];
    pending.push(callback);
    scope.pending.set(key, pending);
    const wrapped: UploadCallback = (data) => {
      if (scope.closed || blocked || scope.matched.has(key)) return;
      scope.matched.add(key);
      scope.confirmed.set(key, data);
      retire(key);
      console.log("[zalo-upload] callback matched");
      for (const waiting of scope.pending.get(key)?.splice(0) || []) {
        void Promise.resolve(waiting(data)).catch(() => undefined);
      }
    };
    set(key, wrapped);
    console.log("[zalo-upload] HTTP response resolved; callback registered");
    if (scope.early.has(key) && !blocked) {
      queueMicrotask(() => {
        if (!scope.closed && callbacks.get(key) === wrapped && scope.early.has(key)) {
          const early = scope.early.get(key);
          scope.early.delete(key);
          remove(key);
          wrapped(early);
        }
      });
    }
    return this;
  };
  listener.on("upload_attachment", (data: any) => {
    console.log("[zalo-upload] callback arrived");
    const key = typeof data?.fileId === "string" || typeof data?.fileId === "number" ? String(data.fileId) : "";
    prune();
    if (!key) return;
    if (!active || active.closed) { retire(key); return; }
    if (active.matched.has(key) || retired.has(key) || Date.now() < quarantineUntil) return;
    if (active.early.size >= MAX_EVENTS && !active.early.has(key)) {
      active.early.clear();
      quarantineUntil = Date.now() + QUARANTINE_MS;
      console.warn("[zalo-upload] confirmation buffer full; confirmations temporarily quarantined");
      return;
    }
    if (!active.early.has(key)) active.early.set(key, data);
  });
  const cancelActive = () => { active?.cancel?.(); };
  // Socket closure invalidates any buffered confirmation; sendMessage cannot continue after rejection.
  listener.on("disconnected", cancelActive);
  listener.on("closed", cancelActive);
  const cooldownError = () => new Error("zalo_upload_confirmation_cooldown");
  api.uploadAttachment = (...args: any[]) => {
    const sources = Array.isArray(args[0]) ? args[0] : [args[0]];
    const needsConfirmation = sources.some((source: any) => {
      const name = typeof source === "string" ? source : source?.filename;
      const extension = typeof name === "string" ? path.extname(name).toLowerCase() : "";
      return ![".jpg", ".jpeg", ".png", ".webp"].includes(extension);
    });
    if (needsConfirmation && Date.now() < quarantineUntil) {
      console.warn("[zalo-upload] file upload deferred during confirmation cooldown");
      return Promise.reject(cooldownError());
    }
    if (active) return Promise.reject(new Error("zalo_upload_already_in_progress"));
    const scope: Scope & { cancel?: () => void } = { closed: false, keys: new Set(), early: new Map(), matched: new Set(), confirmed: new Map(), pending: new Map(), observedRegistration: false };
    active = scope;
    console.log("[zalo-upload] HTTP upload started");
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        scope.closed = true;
        clearTimeout(timer);
        if (active === scope) active = undefined;
        for (const key of scope.keys) {
          if (owners.get(key) === scope) { remove(key); owners.delete(key); }
          retire(key);
        }
        for (const key of scope.early.keys()) retire(key);
        scope.early.clear();
        scope.pending.clear();
        scope.confirmed.clear();
        const message = error instanceof Error ? error.message : "";
        const localValidationFailure = error instanceof Error && error.name === "ZcaApiError" &&
          (/^(Missing sources|Missing threadId|Invalid source type|Missing filename|File not found|Exceed maximum file of |File extension |File .+ size exceed maximum size of )/.test(message));
        if (error && !scope.observedRegistration && !localValidationFailure) {
          quarantineUntil = Date.now() + QUARANTINE_MS;
          console.warn("[zalo-upload] unidentified interrupted upload; confirmations temporarily quarantined");
        }
        if (error) reject(error); else resolve(value);
      };
      const timeoutError = () => {
        const error = new Error("zalo_upload_callback_timeout");
        error.name = "ZaloUploadCallbackTimeoutError";
        return error;
      };
      scope.cancel = () => finish(timeoutError());
      scope.cancelCooldown = () => finish(cooldownError());
      const timer = setTimeout(() => { console.warn("[zalo-upload] confirmation timed out"); finish(timeoutError()); }, deadlineMs);
      storage.run(scope, () => {
        Promise.resolve().then(() => originalUpload(...args)).then(
          (value) => finish(undefined, value),
          (error) => finish(error),
        );
      });
    });
  };
}
