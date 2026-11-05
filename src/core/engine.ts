import { coverageFromMaps, diceFromMaps, bigramMap, gramTotal, type GramMap } from './dice';
import { normalize } from './normalize';
import type { MatchResult, Settings } from './types';

export interface HotEntry {
  /** 热榜标题原文，用于展示"匹配到哪条" */
  raw: string;
  /** 归一后的标题，匹配时只比这个 */
  norm: string;
  /** 老条目（超过 7 天）：没有新鲜度背书，需要更高分才算命中 */
  stale?: boolean;
  /** 预计算的 bigram 表：热榜条目会被反复比较，不能在每次匹配里重建 */
  grams?: GramMap;
  /** 预计算的 bigram 总数 */
  gramTotal?: number;
}

export const NO_HIT: MatchResult = { hit: false, score: 0, zhihuTitle: '', reason: 'none' };

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** 热榜标题列表在进入匹配前先做一次归一 + 去重 + bigram 预计算 */
export function prepareHot(titles: string[]): HotEntry[] {
  const seen = new Set<string>();
  const out: HotEntry[] = [];
  for (const raw of titles) {
    if (typeof raw !== 'string') continue;
    const norm = normalize(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const grams = bigramMap(norm);
    out.push({ raw, norm, grams, gramTotal: gramTotal(grams) });
  }
  return out;
}

/** 长度差太多时，dice/覆盖率不可能达到阈值，直接跳过省算力 */
const MIN_LEN_RATIO = 0.3;

/**
 * 判定单个标题是否该屏蔽。三级策略，从严到宽：
 * 1. exact   —— 归一后完全相同，直接命中（score 1）
 * 2. contain —— 一方包含另一方，用长度比当分数（防"短标题吃掉长标题"）
 * 3. dice    —— bigram 相似度 ≥ 阈值
 * 白名单优先级最高；短标题只允许走 exact/contain，避免"三个字撞车"。
 */
export function matchTitle(biliTitle: string, hot: HotEntry[], settings: Settings): MatchResult {
  if (!settings.enabled || hot.length === 0) return NO_HIT;

  const norm = normalize(biliTitle);
  if (!norm) return NO_HIT;

  for (const raw of settings.whitelist) {
    const nw = normalize(raw);
    if (!nw) continue;
    if (norm === nw || norm.includes(nw) || nw.includes(norm)) return NO_HIT;
  }

  const threshold = clamp(settings.threshold, 0.5, 0.98);
  const minLen = Math.max(2, settings.minLen);
  let best: MatchResult = NO_HIT;

  // 查询侧的 bigram 只建一次，而不是每条热榜建一次
  const qGrams = norm.length >= 2 ? bigramMap(norm) : null;
  const qTotal = qGrams ? gramTotal(qGrams) : 0;

  for (const entry of hot) {
    // 老条目（>7 天）没有新鲜度背书，分数线抬高 0.05：
    // 池子变大后误伤几乎都来自这里——旧标题的常见词更容易和新视频撞上。
    const entryThreshold = Math.min(0.98, threshold + (entry.stale ? 0.05 : 0));

    if (entry.norm === norm) {
      return { hit: true, score: 1, zhihuTitle: entry.raw, reason: 'exact' };
    }

    // 2. 强包含
    if (norm.length >= 2 && entry.norm.length >= 2) {
      const shorter = norm.length <= entry.norm.length ? norm : entry.norm;
      const longer = shorter === norm ? entry.norm : norm;
      if (longer.includes(shorter)) {
        const ratio = shorter.length / longer.length;
        // 短片段要更严：低于 minLen 的子串必须几乎等价于整条标题才算命中
        const need = shorter.length < minLen ? Math.max(0.95, entryThreshold) : Math.max(0.55, entryThreshold);
        if (ratio >= need && ratio > best.score) {
          best = { hit: true, score: round(ratio), zhihuTitle: entry.raw, reason: 'contain' };
        }
      }
    }

    if (!qGrams || norm.length < minLen) continue;

    const entryGrams = entry.grams;
    if (!entryGrams) continue;

    // 长度差过大时相似度不可能过线，跳过两次 bigram 比对
    const longer = Math.max(norm.length, entry.norm.length);
    const shorterLen = Math.min(norm.length, entry.norm.length);
    if (shorterLen / longer < MIN_LEN_RATIO) continue;

    const eTotal = entry.gramTotal ?? gramTotal(entryGrams);

    // 3. 相似度（短标题不参与，避免误伤）
    const score = diceFromMaps(qGrams, qTotal, entryGrams, eTotal);
    if (score >= entryThreshold && score > best.score) {
      best = { hit: true, score: round(score), zhihuTitle: entry.raw, reason: 'dice' };
    }
    // 4. 非对称覆盖率：专治"B 站标题是知乎原题删减版"这个高频场景
    const cover = coverageFromMaps(qGrams, qTotal, entryGrams, eTotal);
    if (cover >= entryThreshold && cover > best.score) {
      best = { hit: true, score: round(cover), zhihuTitle: entry.raw, reason: 'cover' };
    }
  }

  return best;
}
