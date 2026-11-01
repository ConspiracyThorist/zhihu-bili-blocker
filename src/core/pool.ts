/**
 * 题库池：本地累积、按归一标题去重、按新鲜度淘汰。
 *
 * 设计依据（2026-11-01 体检数据）：
 * - 77 条题库里只有 15.6% 能在 B 站搜到同题视频，72.7% 完全搜不到
 * - 常青问题（日报）命中率 17.0%，高于时事热点（热榜）13.3%
 * 所以：池子要小（800 上限）、按时间淘汰（30 天）、来源要覆盖常青问题。
 */
import { normalize } from './normalize';

export type PoolOrigin = 'hot' | 'daily' | 'remote';

export interface PoolEntry {
  title: string;
  /** 首次进入池子的时间；远端条目为同步时间 */
  firstSeen: number;
  /** 最近一次在来源里出现的时间；远端条目为同步时间 */
  lastSeen: number;
  origin: PoolOrigin;
}

export interface MergeOptions {
  maxAgeDays?: number;
  maxEntries?: number;
}

const DAY = 24 * 60 * 60 * 1000;

/** 合并：按归一标题去重，老条目只更新 lastSeen，不覆盖 firstSeen */
export function mergePool(
  current: PoolEntry[],
  incoming: { title: string; origin: PoolOrigin }[],
  now: number,
): PoolEntry[] {
  const byKey = new Map<string, PoolEntry>();
  for (const entry of current) {
    const key = normalize(entry.title);
    if (key) byKey.set(key, entry);
  }

  for (const item of incoming) {
    const key = normalize(item.title);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.lastSeen = Math.max(existing.lastSeen, now);
    } else {
      byKey.set(key, { title: item.title, firstSeen: now, lastSeen: now, origin: item.origin });
    }
  }

  return [...byKey.values()];
}

/** 淘汰：先按龄期，再按总量（最旧的先走） */
export function prunePool(entries: PoolEntry[], now: number, opts: MergeOptions = {}): PoolEntry[] {
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const maxEntries = opts.maxEntries ?? 800;
  const cutoff = now - maxAgeDays * DAY;

  const alive = entries.filter((e) => e.lastSeen >= cutoff);
  if (alive.length <= maxEntries) return alive;

  return [...alive].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, maxEntries);
}

/** 远端条目整批替换：同步成功时用（删掉的条目要真的消失） */
export function replaceOrigin(entries: PoolEntry[], origin: PoolOrigin, incoming: string[], now: number): PoolEntry[] {
  const kept = entries.filter((e) => e.origin !== origin);
  const added: PoolEntry[] = incoming.map((title) => ({
    title,
    firstSeen: now,
    lastSeen: now,
    origin,
  }));
  return mergePool(kept, added, now);
}

/** 按新鲜度切两段：stale 条目在匹配时需要更高的分数 */
export function splitByFreshness(
  entries: PoolEntry[],
  now: number,
  staleDays = 7,
): { fresh: PoolEntry[]; stale: PoolEntry[] } {
  const cutoff = now - staleDays * DAY;
  const fresh: PoolEntry[] = [];
  const stale: PoolEntry[] = [];
  for (const entry of entries) {
    if (entry.lastSeen >= cutoff) fresh.push(entry);
    else stale.push(entry);
  }
  return { fresh, stale };
}

/** 解析远端种子文件：一行一条，忽略 # 注释，压掉超长行 */
export function parseSeed(text: string, maxLines = 5000, maxLength = 120): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const title = line.trim();
    if (!title || title.startsWith('#')) continue;
    if (title.length > maxLength) continue;
    // 明显不是标题的行（HTML / URL）直接丢弃，防止远端文件被污染
    if (/[<>]/.test(title) || /^https?:\/\//i.test(title)) continue;
    const key = normalize(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
    if (out.length >= maxLines) break;
  }
  return out;
}
