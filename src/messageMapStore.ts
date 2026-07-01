import { promises as fs } from "fs";
import path from "path";

export type MessageMapEntry = {
  conversationId: number;
  cwId: number;
  preview: string;
  sender?: "self" | "contact";
  quote?: Record<string, unknown>;
  ts: number;
};

export class MessageMapStore {
  private map = new Map<string, MessageMapEntry>();
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly filePath: string;
  private readonly maxAgeMs: number;

  constructor(opts: { filePath?: string; maxAgeMs?: number } = {}) {
    this.filePath = opts.filePath || path.resolve(process.cwd(), "data", "message-map.json");
    this.maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, MessageMapEntry>;
      const now = Date.now();
      for (const [zaloMsgId, entry] of Object.entries(parsed || {})) {
        if (!entry || typeof entry.cwId !== "number" || typeof entry.ts !== "number") continue;
        if (now - entry.ts > this.maxAgeMs) continue;
        this.map.set(zaloMsgId, entry);
      }
      if (this.map.size) {
        console.log("[zalo-personal-bridge] messageMapStore loaded", { count: this.map.size });
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.warn("[zalo-personal-bridge] messageMapStore load failed", err?.message || err);
      }
    }
  }

  get(zaloMsgId: string): MessageMapEntry | undefined {
    return this.map.get(zaloMsgId);
  }

  findByChatwootId(cwId: number): MessageMapEntry | undefined {
    for (const entry of this.map.values()) {
      if (entry.cwId === cwId) return entry;
    }
    return undefined;
  }

  findZaloIdByChatwootId(cwId: number): string | undefined {
    for (const [zaloMsgId, entry] of this.map.entries()) {
      if (entry.cwId === cwId) return zaloMsgId;
    }
    return undefined;
  }

  set(zaloMsgId: string, entry: Omit<MessageMapEntry, "ts">): void {
    this.map.set(zaloMsgId, { ...entry, ts: Date.now() });
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 3000);
  }

  private async save(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      const obj: Record<string, MessageMapEntry> = {};
      for (const [k, v] of this.map.entries()) obj[k] = v;
      await fs.writeFile(this.filePath, JSON.stringify(obj), "utf8");
    } catch (err: any) {
      console.warn("[zalo-personal-bridge] messageMapStore save failed", err?.message || err);
    }
  }
}
