export type ListenerRecoveryTrigger = "disconnected" | "error";

export type ListenerDisconnectDetails = {
  trigger: ListenerRecoveryTrigger;
  code: number | null;
  reason: string | null;
};

type TimerHandle = unknown;

export type ListenerRecoveryTimer = {
  setTimeout(callback: () => void, timeoutMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

export type ListenerRecoveryLogger = {
  info(message: string, details: Record<string, unknown>): void;
  warn(message: string, details: Record<string, unknown>): void;
  error(message: string, details: Record<string, unknown>): void;
};

const DEFAULT_RECOVERY_TIMEOUT_MS = 90_000;
const MIN_RECOVERY_TIMEOUT_MS = 10_000;
const MAX_RECOVERY_TIMEOUT_MS = 15 * 60_000;
const MAX_REASON_LENGTH = 160;

const defaultTimer: ListenerRecoveryTimer = {
  setTimeout(callback, timeoutMs) {
    const handle = setTimeout(callback, timeoutMs);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

function normalizeCode(code: unknown): number | null {
  return typeof code === "number" && Number.isInteger(code) && code >= 0 ? code : null;
}

export function sanitizeDisconnectReason(reason: unknown): string | null {
  let value: string;
  if (typeof reason === "string") value = reason;
  else if (Buffer.isBuffer(reason)) value = reason.toString("utf8");
  else if (reason instanceof Uint8Array) value = Buffer.from(reason).toString("utf8");
  else return null;

  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, "[redacted-url]")
    .trim();
  return sanitized ? sanitized.slice(0, MAX_REASON_LENGTH) : null;
}

export function resolveListenerRecoveryTimeout(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_RECOVERY_TIMEOUT_MS;
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < MIN_RECOVERY_TIMEOUT_MS ||
    value > MAX_RECOVERY_TIMEOUT_MS
  ) {
    throw new Error("ZALO_LISTENER_RECOVERY_TIMEOUT_MS must be an integer between 10000 and 900000");
  }
  return value;
}

export class ListenerRecoveryWatchdog {
  private timerHandle: TimerHandle | null = null;
  private terminalActionStarted = false;
  private firstFailure: ListenerDisconnectDetails | null = null;

  constructor(
    private readonly options: {
      timeoutMs: number;
      onTimeout: (details: ListenerDisconnectDetails) => void;
      logger?: ListenerRecoveryLogger;
      timer?: ListenerRecoveryTimer;
    },
  ) {}

  unavailable(
    trigger: ListenerRecoveryTrigger,
    code: unknown = undefined,
    reason: unknown = undefined,
  ): void {
    const details: ListenerDisconnectDetails = {
      trigger,
      code: normalizeCode(code),
      reason: sanitizeDisconnectReason(reason),
    };
    if (this.terminalActionStarted) return;
    if (this.timerHandle !== null) {
      if (this.firstFailure?.trigger === "error" && trigger === "disconnected") {
        this.firstFailure = details;
      }
      return;
    }

    this.firstFailure = details;
    this.options.logger?.warn("[zalo-listener] unavailable; recovery watchdog started", {
      ...details,
      timeoutMs: this.options.timeoutMs,
    });

    const timer = this.options.timer || defaultTimer;
    this.timerHandle = timer.setTimeout(() => {
      this.timerHandle = null;
      if (this.terminalActionStarted || !this.firstFailure) return;
      this.terminalActionStarted = true;
      this.options.logger?.error("[zalo-listener] recovery timeout; requesting supervisor restart", {
        ...this.firstFailure,
        timeoutMs: this.options.timeoutMs,
      });
      this.options.onTimeout(this.firstFailure);
    }, this.options.timeoutMs);
  }

  connected(): void {
    if (this.terminalActionStarted) return;
    const recoveredFailure = this.firstFailure;
    if (this.timerHandle !== null) {
      (this.options.timer || defaultTimer).clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    this.firstFailure = null;
    if (recoveredFailure) {
      this.options.logger?.info("[zalo-listener] connection recovered", {
        trigger: recoveredFailure.trigger,
        code: recoveredFailure.code,
      });
    }
  }
}
