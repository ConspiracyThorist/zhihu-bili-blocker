/**
 * UP 库：一份 mid 黑名单，配合题库使用。
 *
 * 题库解决「这个问题被搬了」，UP 库解决「这个人一直在搬」。
 * 自动化发现走 GitHub Actions（周更 ups.json），用户手动拉黑的存本地。
 */

export type UpSource = 'auto' | 'manual';

export interface UpEntry {
  /** B 站用户 id */
  mid: number;
  name: string;
  /** 自动发现时：命中的视频数 */
  hits?: number;
  /** 自动发现时：出现过的视频数 */
  total?: number;
  /** 命中率 = hits / total */
  rate?: number;
  source: UpSource;
  /** 手动添加的时间 */
  addedAt?: number;
}

export interface UpsFile {
  generatedAt: string;
  /** 发现任务用的命中阈值 */
  threshold: number;
  entries: UpEntry[];
}

export const UP_MIN_HITS = 2;
export const UP_MIN_RATE = 0.3;

/** 自动发现的双门槛：至少命中 2 条，且命中率不低于 30% */
export function qualifies(hits: number, total: number): boolean {
  return hits >= UP_MIN_HITS && total > 0 && hits / total >= UP_MIN_RATE;
}

/** 解析远端 ups.json，脏数据一律丢弃而不是报错 */
export function parseUpsFile(text: string): UpEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = (json as UpsFile | null)?.entries;
  if (!Array.isArray(entries)) return [];

  const out: UpEntry[] = [];
  for (const raw of entries) {
    const mid = Number((raw as UpEntry)?.mid);
    if (!Number.isFinite(mid) || mid <= 0) continue;
    const name = String((raw as UpEntry)?.name ?? '').slice(0, 60);
    out.push({ mid, name, source: 'auto' });
  }
  return out;
}

/** 合并远端与本地：本地手动条目优先，远端整批替换 auto 条目 */
export function mergeUps(current: UpEntry[], remote: UpEntry[]): UpEntry[] {
  const manual = current.filter((e) => e.source === 'manual');
  const byMid = new Map<number, UpEntry>();
  for (const entry of manual) byMid.set(entry.mid, entry);
  for (const entry of remote) {
    if (!byMid.has(entry.mid)) byMid.set(entry.mid, entry);
  }
  return [...byMid.values()];
}
