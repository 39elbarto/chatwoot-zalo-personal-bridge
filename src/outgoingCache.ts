export class OutgoingCache {
  private store = new Map<string, number>();

  constructor(private ttlMs = 5 * 60 * 1000) {}

  add(key: string) {
    this.purge();
    this.store.set(key, Date.now() + this.ttlMs);
  }

  addWithTtl(key: string, ttlMs: number) {
    this.purge();
    this.store.set(key, Date.now() + ttlMs);
  }

  addMany(keys: Array<string | null | undefined>) {
    keys.filter((k): k is string => !!k).forEach((k) => this.add(k));
  }

  has(key: string | null | undefined): boolean {
    if (!key) return false;
    this.purge();
    const exp = this.store.get(key);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  private purge() {
    const now = Date.now();
    for (const [key, exp] of this.store.entries()) {
      if (exp < now) {
        this.store.delete(key);
      }
    }
  }
}
