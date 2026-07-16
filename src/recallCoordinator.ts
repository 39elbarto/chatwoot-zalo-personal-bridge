export type RecallMapping = {
  conversationId: number;
  cwId: number;
};

export type RecallRequest = {
  targetMsgId: string;
  threadId: string;
};

type RecallCoordinatorOptions = {
  lookup: (zaloMsgId: string) => RecallMapping | undefined;
  deleteMessage: (conversationId: number, cwId: number) => Promise<void>;
  onDeleted?: (zaloMsgId: string) => void;
  now?: () => number;
  pendingTtlMs?: number;
  completedTtlMs?: number;
  logger?: Pick<Console, "log" | "warn">;
};

export class RecallCoordinator {
  private readonly pending = new Map<string, { threadId: string; expiresAt: number }>();
  private readonly completed = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly completedTtlMs: number;
  private readonly logger: Pick<Console, "log" | "warn">;

  constructor(private readonly opts: RecallCoordinatorOptions) {
    this.now = opts.now || Date.now;
    this.pendingTtlMs = opts.pendingTtlMs ?? 5 * 60 * 1000;
    this.completedTtlMs = opts.completedTtlMs ?? 60 * 60 * 1000;
    this.logger = opts.logger || console;
  }

  async recall(request: RecallRequest): Promise<"deleted" | "pending" | "duplicate" | "invalid" | "failed"> {
    this.prune();
    const targetMsgId = request.targetMsgId.trim();
    if (!targetMsgId) return "invalid";
    if (this.completed.has(targetMsgId) || this.inFlight.has(targetMsgId)) return "duplicate";

    const mapping = this.opts.lookup(targetMsgId);
    if (!mapping) {
      this.pending.set(targetMsgId, { threadId: request.threadId, expiresAt: this.now() + this.pendingTtlMs });
      this.logger.log("[zalo-recall-pending]", { targetMsgId, threadId: request.threadId });
      return "pending";
    }
    if (!Number.isInteger(mapping.conversationId) || mapping.conversationId <= 0 || !Number.isInteger(mapping.cwId) || mapping.cwId <= 0) {
      this.logger.warn("[zalo-recall-invalid-mapping]", { targetMsgId });
      return "invalid";
    }

    this.inFlight.add(targetMsgId);
    try {
      await this.opts.deleteMessage(mapping.conversationId, mapping.cwId);
      this.pending.delete(targetMsgId);
      this.completed.set(targetMsgId, this.now() + this.completedTtlMs);
      this.opts.onDeleted?.(targetMsgId);
      this.logger.log("[zalo-recall-deleted]", {
        targetMsgId,
        conversationId: mapping.conversationId,
        cwId: mapping.cwId,
      });
      return "deleted";
    } catch (err) {
      this.logger.warn("[zalo-recall-delete-failed]", {
        targetMsgId,
        conversationId: mapping.conversationId,
        cwId: mapping.cwId,
        error: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    } finally {
      this.inFlight.delete(targetMsgId);
    }
  }

  async mappingAvailable(zaloMsgId: string): Promise<void> {
    this.prune();
    const threadId = this.pending.get(zaloMsgId)?.threadId;
    if (typeof threadId !== "string") return;
    await this.recall({ targetMsgId: zaloMsgId, threadId });
  }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.pending) {
      if (value.expiresAt <= now) this.pending.delete(key);
    }
    for (const [key, expiresAt] of this.completed) {
      if (expiresAt <= now) this.completed.delete(key);
    }
  }
}

export class MappingAwareMap<V> extends Map<string, V> {
  constructor(private readonly onSet: (key: string) => void) {
    super();
  }

  override set(key: string, value: V): this {
    super.set(key, value);
    this.onSet(key);
    return this;
  }
}
