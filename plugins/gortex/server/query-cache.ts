export class QueryCache {
  private entries = new Map<string, { expires: number; value: Promise<unknown> }>();
  private limit: number;
  constructor(limit = 64) { this.limit = limit; }
  get<T>(key: string, ttl: number, fetch: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > Date.now()) return existing.value as Promise<T>;
    const entry = { expires: Number.POSITIVE_INFINITY, value: Promise.resolve().then(fetch) };
    entry.value.then(() => { entry.expires = Date.now() + ttl; }, () => {});
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    entry.value.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    return entry.value;
  }
  clear(): void { this.entries.clear(); }
}
