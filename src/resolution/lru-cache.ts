/**
 * 基于 JavaScript 插入顺序 Map 实现的简单 LRU 缓存。
 *
 * 供 ReferenceResolver 使用，用于限制各解析器缓存的大小——此前这些缓存
 * 无上限增长，在超过 2 万个文件的大型代码库上会导致内存溢出（OOM）。
 * 每个缓存的容量独立配置——各缓存类型的具体限制请参见 `index.ts`。
 *
 * 淘汰策略为标准 LRU：执行 `set` 时，若缓存已满，则淘汰最近最少使用的
 * 条目（即迭代顺序中的第一条）。通过 `get` 访问某条目后，该条目会被
 * 移至最近使用位置，从而使热键在淘汰轮次中得以保留。
 */
export class LRUCache<K, V> {
  private readonly max: number;
  private readonly store = new Map<K, V>();

  constructor(max: number) {
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`LRUCache max must be a positive finite number, got ${max}`);
    }
    this.max = Math.floor(max);
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) {
      // 通过 has() 区分"键不存在"与"存储了 undefined"。
      // 实际上不会存储 undefined，但保持防御性写法。
      return this.store.has(key) ? value : undefined;
    }
    // 通过重新插入来刷新访问时间。
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.max) {
      // 淘汰最旧的条目——即迭代顺序中的第一个键。
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(key, value);
  }

  clear(): void {
    this.store.clear();
  }
}
