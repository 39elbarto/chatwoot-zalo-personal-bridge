import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { ZaloMentionPayload } from "./zaloClient";

export type OutboundItemKind = "text" | "image" | "file";
export type OutboundItemState = "queued" | "sending" | "accepted" | "failed" | "unknown";
export type OutboundJobState = "queued" | "sending" | "complete" | "partial";
export type DeliveryFailureDisposition = "retryable" | "failed" | "unknown";

export type OutboundItemInput = {
  kind: OutboundItemKind;
  text?: string;
  url?: string;
  fileName?: string;
  quote?: Record<string, unknown> | null;
  mentions?: ZaloMentionPayload[];
};

export type OutboundJobInput = {
  conversationId: number;
  messageId: number;
  threadId: string;
  items: OutboundItemInput[];
};

export type OutboundQueueItem = OutboundItemInput & {
  index: number;
  state: OutboundItemState;
  attempts: number;
  zaloMessageId?: string;
  failureCategory?: string;
  retryPending?: boolean;
};

export type OutboundQueueHealthSummary = {
  queued: number;
  sending: number;
  accepted: number;
  failed: number;
  unknown: number;
  pending_count: number;
  terminal_issue_count: number;
  oldest_pending_seconds: number;
  issue_fingerprint: string;
};

export type OutboundQueueJob = {
  key: string;
  conversationId: number;
  messageId: number;
  threadId: string;
  items: OutboundQueueItem[];
  state: OutboundJobState;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  statusFeedback?: { state: "idle" | "pending" | "acknowledged"; retryGeneration: number };
};

type QueueFile = {
  version: 1;
  jobs: OutboundQueueJob[];
};

export type OutboundDeliveryResult = { zaloMessageId: string };
export type OutboundItemProcessor = (
  job: Readonly<OutboundQueueJob>,
  item: Readonly<OutboundQueueItem>,
) => Promise<OutboundDeliveryResult>;

export class OutboundDeliveryError extends Error {
  constructor(
    readonly category: string,
    readonly disposition: DeliveryFailureDisposition,
  ) {
    super(category);
    this.name = "OutboundDeliveryError";
  }
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 5_000];
const COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_COMPLETED_JOBS = 5_000;
const MAX_TOTAL_JOBS = 2_000;

function messageKey(input: Pick<OutboundJobInput, "conversationId" | "messageId">): string {
  return `cw:${input.conversationId}:${input.messageId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateJob(value: unknown): value is OutboundQueueJob {
  if (!isRecord(value)) return false;
  if (
    typeof value.key !== "string" ||
    typeof value.conversationId !== "number" ||
    !Number.isSafeInteger(value.conversationId) ||
    value.conversationId <= 0 ||
    typeof value.messageId !== "number" ||
    !Number.isSafeInteger(value.messageId) ||
    value.messageId <= 0 ||
    value.key !== messageKey({ conversationId: value.conversationId, messageId: value.messageId }) ||
    typeof value.threadId !== "string" ||
    value.threadId.length === 0 ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    !["queued", "sending", "complete", "partial"].includes(String(value.state)) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    (value.completedAt !== undefined && (typeof value.completedAt !== "number" || !Number.isFinite(value.completedAt))) ||
    (value.statusFeedback !== undefined && (!isRecord(value.statusFeedback) || (!["idle", "pending", "acknowledged"].includes(String(value.statusFeedback.state)) || !Number.isSafeInteger(value.statusFeedback.retryGeneration) || Number(value.statusFeedback.retryGeneration) < 0)))
  ) {
    return false;
  }
  return value.items.every((item, index) => {
    if (!isRecord(item)) return false;
    const kind = String(item.kind);
    const state = String(item.state);
    const accepted = state === "accepted";
    const payloadRequired = state === "queued" || state === "sending" || state === "unknown";
    return (
      item.index === index &&
      ["text", "image", "file"].includes(kind) &&
      ["queued", "sending", "accepted", "failed", "unknown"].includes(state) &&
      typeof item.attempts === "number" &&
      Number.isSafeInteger(item.attempts) &&
      item.attempts >= 0 &&
      (item.failureCategory === undefined || typeof item.failureCategory === "string") &&
      (item.retryPending === undefined || typeof item.retryPending === "boolean") &&
      (item.zaloMessageId === undefined || typeof item.zaloMessageId === "string") &&
      (kind === "text"
        ? (!payloadRequired || typeof item.text === "string") && (item.text === undefined || typeof item.text === "string")
        : (!payloadRequired || typeof item.url === "string") && (item.url === undefined || typeof item.url === "string")) &&
      (!accepted || (typeof item.zaloMessageId === "string" && item.zaloMessageId.length > 0 && item.attempts > 0))
    );
  });
}

export class OutboundDeliveryQueue {
  private jobs: OutboundQueueJob[] = [];
  private readonly filePath: string;
  private processor: OutboundItemProcessor | null = null;
  private terminalHandler: ((job: Readonly<OutboundQueueJob>) => Promise<void>) | null = null;
  private readonly reporting = new Set<string>();
  private readonly reportAgain = new Set<string>();
  private started = false;
  private halted = false;
  private worker: Promise<void> | null = null;
  private mutationTail: Promise<void> | null = null;
  private idleWaiters: Array<() => void> = [];
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly onStorageError?: () => void;

  constructor(options: {
    filePath?: string;
    logger?: Pick<Console, "log" | "warn" | "error">;
    maxAttempts?: number;
    retryDelaysMs?: readonly number[];
    onStorageError?: () => void;
  } = {}) {
    this.filePath = options.filePath || path.resolve(process.cwd(), "data", "outbound-queue", "queue.json");
    this.logger = options.logger || console;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.onStorageError = options.onStorageError;
  }

  private readonly logger: Pick<Console, "log" | "warn" | "error">;

  async load(): Promise<void> {
    let parsed: QueueFile;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as QueueFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.jobs = [];
        return;
      }
      throw new Error("outbound_queue_read_failed");
    }

    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs) || !parsed.jobs.every(validateJob)) {
      throw new Error("outbound_queue_schema_invalid");
    }

    try {
      await fs.chmod(path.dirname(this.filePath), 0o700);
      await fs.chmod(this.filePath, 0o600);
    } catch {
      throw new Error("outbound_queue_permissions_failed");
    }

    this.jobs = parsed.jobs;
    let recovered = false;
    const now = Date.now();
    for (const job of this.jobs) {
      let jobRecovered = false;
      for (const item of job.items) {
        if (item.state === "sending") {
          item.state = "unknown";
          item.failureCategory = "interrupted_during_send";
          item.retryPending = false;
          jobRecovered = true;
        } else if (item.state === "queued" && item.retryPending === true) {
          item.state = "unknown";
          item.failureCategory = item.failureCategory === "native_retry_pending"
            ? "native_retry_interrupted" : "zalo_api_timeout_retry_interrupted";
          item.retryPending = false;
          jobRecovered = true;
        }
      }
      if (jobRecovered) {
        this.refreshJobState(job, now);
        recovered = true;
      }
    }
    if (recovered) {
      await this.persist();
      this.logger.warn("[outbound-queue] recovered ambiguous provider outcomes", {
        jobs: this.jobs.filter((job) => job.items.some((item) =>
          item.failureCategory === "interrupted_during_send" || item.failureCategory === "zalo_api_timeout_retry_interrupted" || item.failureCategory === "native_retry_interrupted",
        )).length,
      });
    }
    for (const job of this.jobs) this.notifyTerminal(job);
  }

  setTerminalHandler(handler: (job: Readonly<OutboundQueueJob>) => Promise<void>): void {
    this.terminalHandler = handler;
    for (const job of this.jobs) this.notifyTerminal(job);
  }

  private notifyTerminal(job: OutboundQueueJob): void {
    if (job.state !== "partial" || job.statusFeedback?.state !== "pending" || !this.terminalHandler || this.reporting.has(job.key)) return;
    this.reporting.add(job.key);
    const snapshot = structuredClone(job);
    Promise.resolve().then(() => this.terminalHandler!(snapshot)).then(async () => {
      await this.withMutation(async () => {
        if (job.statusFeedback?.state !== "pending" || job.statusFeedback.retryGeneration !== snapshot.statusFeedback?.retryGeneration) return;
        job.statusFeedback.state = "acknowledged";
        try {
          await this.persist();
        } catch (error) {
          job.statusFeedback.state = "pending";
          this.onStorageError?.();
          throw error;
        }
      });
    }).catch(() => {
      this.logger.warn("[outbound-queue] status feedback failed", { category: "chatwoot_status_write_failed" });
    }).finally(() => {
      this.reporting.delete(job.key);
      if (this.reportAgain.delete(job.key)) this.notifyTerminal(job);
    });
  }

  setProcessor(processor: OutboundItemProcessor): void {
    this.processor = processor;
    this.kick();
  }

  start(): void {
    this.started = true;
    this.kick();
  }

  pause(): void {
    this.started = false;
  }

  async enqueue(input: OutboundJobInput): Promise<{ duplicate: boolean; key: string }> {
    return this.withMutation(async () => {
      if (this.halted) throw new OutboundDeliveryError("outbound_queue_unavailable", "retryable");
      const key = messageKey(input);
      const existing = this.jobs.find((job) => job.key === key);
      if (existing) {
        this.notifyTerminal(existing);
        return { duplicate: true, key };
      }

      const now = Date.now();
      this.pruneCompleted(now);
      if (this.jobs.length >= MAX_TOTAL_JOBS) throw new OutboundDeliveryError("outbound_queue_full", "retryable");
      const job: OutboundQueueJob = {
        key,
        conversationId: input.conversationId,
        messageId: input.messageId,
        threadId: input.threadId,
        items: input.items.map((item, index) => ({ ...item, index, state: "queued", attempts: 0 })),
        state: "queued",
        createdAt: now,
        updatedAt: now,
        statusFeedback: { state: "idle", retryGeneration: 0 },
      };
      this.jobs.push(job);
      try {
        await this.persist();
      } catch (error) {
        this.halted = true;
        this.onStorageError?.();
        throw error;
      }
      this.logger.log("[outbound-queue] enqueued", { key, itemCount: job.items.length });
      this.kick();
      return { duplicate: false, key };
    });
  }

  async retryState(conversationId: number, messageId: number): Promise<{ generation: number; state: "pending" | "acknowledged" } | null> {
    return this.withMutation(async () => {
      const job = this.jobs.find((candidate) => candidate.key === messageKey({conversationId, messageId}));
      if (job?.state !== "partial" || !job.statusFeedback || job.statusFeedback.state === "idle") return null;
      return {generation: job.statusFeedback.retryGeneration, state: job.statusFeedback.state};
    });
  }

  async reassertPendingRetry(conversationId: number, messageId: number, generation: number): Promise<void> {
    const job = await this.withMutation(async () => {
      const current = this.jobs.find((candidate) => candidate.key === messageKey({conversationId, messageId}));
      if (!current || current.state !== "partial" || !current.statusFeedback || current.statusFeedback.state === "idle" ||
          current.statusFeedback.retryGeneration !== generation) return null;
      current.statusFeedback.retryGeneration++;
      current.statusFeedback.state = "pending";
      current.updatedAt = Date.now();
      try { await this.persist(); } catch (error) {
        this.halted = true;
        this.onStorageError?.();
        throw error;
      }
      return current;
    });
    if (!job) return;
    if (this.reporting.has(job.key)) this.reportAgain.add(job.key);
    else this.notifyTerminal(job);
  }

  async applyNativeRetry(conversationId: number, messageId: number, expectedGeneration: number): Promise<"retry" | "reassert" | "ignored"> {
    const result = await this.withMutation(async () => {
      const job = this.jobs.find((candidate) => candidate.key === messageKey({conversationId, messageId}));
      if (!job || job.state !== "partial" || job.statusFeedback?.state !== "acknowledged" ||
          job.statusFeedback.retryGeneration !== expectedGeneration) return { result: "ignored" as const, job: null };
      const safeCategories = new Set(["zalo_upload_callback_timeout", "zalo_upload_confirmation_cooldown", "attachment_head_failed", "attachment_head_status", "attachment_url_missing"]);
      const failures = job.items.filter((item) => item.state === "failed");
      const unsafe = job.items.some((item) => item.state === "unknown") || failures.length === 0 ||
        failures.some((item) => !safeCategories.has(item.failureCategory || "") ||
          (item.kind === "text" ? typeof item.text !== "string" : typeof item.url !== "string"));
      job.statusFeedback.retryGeneration++;
      if (unsafe) {
        job.statusFeedback.state = "pending";
      } else {
        for (const item of failures) {
          item.state = "queued";
          item.attempts = 0;
          item.retryPending = true;
          item.failureCategory = "native_retry_pending";
        }
        job.state = "queued";
        job.completedAt = undefined;
        job.statusFeedback.state = "idle";
      }
      job.updatedAt = Date.now();
      try {
        await this.persist();
      } catch (error) {
        this.halted = true;
        this.onStorageError?.();
        throw error;
      }
      return { result: unsafe ? "reassert" as const : "retry" as const, job };
    });
    if (result.job && result.result === "reassert") this.notifyTerminal(result.job);
    if (result.result === "retry") this.kick();
    return result.result;
  }

  async waitForIdle(timeoutMs = 10_000): Promise<void> {
    if (!this.hasQueuedWork() && !this.worker) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== done);
        reject(new Error("outbound_queue_idle_timeout"));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.idleWaiters.push(done);
      this.kick();
    });
  }

  snapshot(): OutboundQueueJob[] {
    return this.jobs.map((job) => structuredClone(job));
  }

  healthSummary(now = Date.now()): OutboundQueueHealthSummary {
    const summary: OutboundQueueHealthSummary = {
      queued: 0,
      sending: 0,
      accepted: 0,
      failed: 0,
      unknown: 0,
      pending_count: 0,
      terminal_issue_count: 0,
      oldest_pending_seconds: 0,
      issue_fingerprint: "",
    };
    const issueSignatures: string[] = [];
    let oldestPendingAt = now;

    for (const job of this.jobs) {
      for (const item of job.items) {
        summary[item.state] += 1;
        if (item.state === "queued" || item.state === "sending") {
          summary.pending_count += 1;
          oldestPendingAt = Math.min(oldestPendingAt, job.updatedAt);
        } else if (item.state === "failed" || item.state === "unknown") {
          summary.terminal_issue_count += 1;
          issueSignatures.push(`${job.key}:${item.index}:${item.state}:${item.failureCategory || ""}`);
        }
      }
    }

    if (summary.pending_count > 0) {
      summary.oldest_pending_seconds = Math.max(0, Math.floor((now - oldestPendingAt) / 1000));
    }
    summary.issue_fingerprint = createHash("sha256")
      .update(issueSignatures.sort().join("\n"))
      .digest("hex");
    return summary;
  }

  private kick(): void {
    if (!this.started || this.halted || !this.processor || this.worker || !this.hasQueuedWork()) return;
    this.worker = this.drain().finally(() => {
      this.worker = null;
      if (!this.hasQueuedWork()) {
        for (const waiter of this.idleWaiters.splice(0)) waiter();
      } else {
        this.kick();
      }
    });
  }

  private async drain(): Promise<void> {
    while (this.started && !this.halted && this.processor) {
      const next = await this.withMutation(async () => {
        for (const job of this.jobs) {
          const item = job.items.find((candidate) => candidate.state === "queued");
          if (item) return { job, item };
        }
        return null;
      });
      if (!next) return;
      await this.processItem(next.job, next.item, this.processor);
    }
  }

  private async processItem(job: OutboundQueueJob, item: OutboundQueueItem, processor: OutboundItemProcessor): Promise<void> {
    while (this.started && item.state === "queued" && item.attempts < this.maxAttempts) {
      item.state = "sending";
      item.attempts += 1;
      item.retryPending = false;
      job.state = "sending";
      job.updatedAt = Date.now();
      try {
        await this.withMutation(() => this.persist());
      } catch {
        this.halted = true;
        this.onStorageError?.();
        this.logger.error?.("[outbound-queue] state persistence failed before send", { key: job.key, item: item.index });
        return;
      }

      let result: OutboundDeliveryResult;
      try {
        result = await processor(job, item);
      } catch (error) {
        const failure = this.classifyFailure(error);
        item.failureCategory = failure.category;
        const timeoutRetryCategories = ["zalo_api_fetch_timeout", "zalo_upload_callback_timeout"];
        const retryTimeoutOnce = failure.category === "zalo_upload_callback_timeout" && failure.disposition === "retryable" && item.attempts === 1;
        const retryByPolicy = !timeoutRetryCategories.includes(failure.category) &&
          failure.disposition === "retryable" && item.attempts < this.maxAttempts;
        if (retryTimeoutOnce || retryByPolicy) {
          item.state = "queued";
          item.retryPending = retryTimeoutOnce;
          if (retryTimeoutOnce) {
            item.failureCategory = failure.category === "zalo_upload_callback_timeout"
              ? "zalo_upload_callback_timeout_retry_pending"
              : "zalo_api_timeout_retry_pending";
          }
          job.state = "queued";
          job.updatedAt = Date.now();
          try {
            await this.withMutation(() => this.persist());
          } catch {
            this.halted = true;
            this.onStorageError?.();
            this.logger.error?.("[outbound-queue] retry state persistence failed", { key: job.key, item: item.index });
            return;
          }
          const fallbackDelay = this.retryDelaysMs[this.retryDelaysMs.length - 1] || 0;
          const delayMs = retryTimeoutOnce ? 5_000 : (this.retryDelaysMs[item.attempts - 1] ?? fallbackDelay);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        item.state = failure.category === "zalo_api_fetch_timeout" || failure.disposition === "unknown" ? "unknown" : "failed";
        item.retryPending = false;
        this.refreshJobState(job);
        try {
          await this.withMutation(() => this.persist());
        } catch {
          this.halted = true;
          this.onStorageError?.();
          this.logger.error?.("[outbound-queue] failure state persistence failed", { key: job.key, item: item.index });
          return;
        }
        this.notifyTerminal(job);
        this.logger.warn("[outbound-queue] item not accepted", {
          key: job.key,
          item: item.index,
          itemCount: job.items.length,
          attempt: item.attempts,
          outcome: item.state,
          category: failure.category,
        });
        return;
      }

      item.state = "accepted";
      item.zaloMessageId = result.zaloMessageId;
      item.failureCategory = undefined;
      item.text = undefined;
      item.url = undefined;
      item.fileName = undefined;
      item.quote = undefined;
      item.mentions = undefined;
      this.refreshJobState(job);
      try {
        await this.withMutation(() => this.persist());
      } catch {
        this.halted = true;
        this.onStorageError?.();
        this.logger.error("[outbound-queue] accepted outcome persistence failed", { key: job.key, item: item.index });
        return;
      }
      this.notifyTerminal(job);
      this.logger.log("[outbound-queue] item accepted", {
        key: job.key,
        item: item.index,
        itemCount: job.items.length,
        attempt: item.attempts,
      });
      return;
    }
  }

  private classifyFailure(error: unknown): { category: string; disposition: DeliveryFailureDisposition } {
    if (error instanceof OutboundDeliveryError) {
      return { category: error.category, disposition: error.disposition };
    }
    return { category: "provider_outcome_unknown", disposition: "unknown" };
  }

  private refreshJobState(job: OutboundQueueJob, now = Date.now()): void {
    job.updatedAt = now;
    if (job.items.every((item) => item.state === "accepted")) {
      job.state = "complete";
      job.completedAt = job.completedAt || now;
    } else if (job.items.some((item) => item.state === "sending")) {
      job.state = "sending";
      job.completedAt = undefined;
    } else if (job.items.some((item) => item.state === "queued")) {
      job.state = "queued";
      job.completedAt = undefined;
    } else if (job.items.some((item) => item.state === "failed" || item.state === "unknown")) {
      job.state = "partial";
      job.completedAt = job.completedAt || now;
      if (job.statusFeedback?.state === "idle") job.statusFeedback.state = "pending";
    } else {
      job.state = "queued";
      job.completedAt = undefined;
    }
  }

  private hasQueuedWork(): boolean {
    return this.jobs.some((job) => job.items.some((item) => item.state === "queued"));
  }

  private pruneCompleted(now: number): void {
    this.jobs = this.jobs.filter((job) => {
      if (job.state !== "complete" || !job.completedAt) return true;
      return now - job.completedAt <= COMPLETED_RETENTION_MS;
    });
    const completed = this.jobs.filter((job) => job.state === "complete");
    const excess = completed.length - MAX_COMPLETED_JOBS;
    if (excess > 0) {
      const remove = new Set(completed.sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0)).slice(0, excess));
      this.jobs = this.jobs.filter((job) => !remove.has(job));
    }
  }

  private async persist(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ version: 1, jobs: this.jobs } satisfies QueueFile);
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, this.filePath);
      const directoryHandle = await fs.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail
      ? this.mutationTail.then(operation, operation)
      : operation();
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
