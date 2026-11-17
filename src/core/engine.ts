import { coverageFromHashed, diceFromHashed, hashBigrams } from './dice';
import { normalize } from './normalize';
import type { MatchResult, Settings } from './types';

export interface HotEntry {
  /** 热榜标题原文，用于展示"匹配到哪条" */
  raw: string;
  /** 归一后的标题，匹配时只比这个 */
  norm: string;
  /** 老条目（超过 7 天）：没有新鲜度背书，需要更高分才算命中 */
  stale?: boolean;
  /** 预计算的 bigram 哈希（升序）：热榜条目会被反复比较，不能在每次匹配里重建 */
  hashes?: Uint32Array;
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
    const grams = hashBigrams(norm);
    out.push({ raw, norm, hashes: grams.hashes, gramTotal: grams.total });
  }
  return out;
}

/** 长度差太多时，dice/覆盖率不可能达到阈值，直接跳过省算力 */
const MIN_LEN_RATIO = 0.3;

/**
 * 倒排索引：bigram 哈希 → 条目下标。
 *
 * 题库从几百条涨到上万条后，逐条比对撑不住了（2 万条时一批 20 个标题要 260 ms，
 * 首页会明显发白）。索引只负责「挑出可能过线的条目」，最终算分仍然用完整的
 * bigram 序列，所以结论与线性扫描一致（测试里有等价性断言）。
 */
export interface HotIndex {
  /** bigram 哈希 → 共享该 bigram 的条目下标（升序） */
  postings: Map<number, number[]>;
}

/**
 * 索引不挂在数组上，用 WeakMap 存：数组本身还是普通数组，
 * 传入 matchTitle 时自动生效，池子被回收时索引一起回收。
 */
const INDEXES = new WeakMap<HotEntry[], HotIndex>();

export function buildIndex(entries: HotEntry[]): HotIndex {
  const postings = new Map<number, number[]>();
  for (let i = 0; i < entries.length; i += 1) {
    const hashes = entries[i].hashes;
    if (!hashes) continue;
    // 同一个 bigram 出现多次时只需要登记一次
    let prev = -1;
    for (let k = 0; k < hashes.length; k += 1) {
      const h = hashes[k];
      if (h === prev) continue;
      prev = h;
      const list = postings.get(h);
      if (list) list.push(i);
      else postings.set(h, [i]);
    }
  }
  return { postings };
}

/** 建索引并登记（返回同一个数组，方便链式使用） */
export function attachIndex(entries: HotEntry[]): HotEntry[] {
  INDEXES.set(entries, buildIndex(entries));
  return entries;
}

/**
 * 一次查表的预算：超过就退化成线性扫描。
 * 真实标题几乎不会触发（一条 20 字的标题只碰到几万个 posting 的零头），
 * 但「整条都是高频 bigram」的标题存在，留个保险比悄悄漏判强。
 */
const WORK_BUDGET = 30_000;

/** 新鲜 + 老条目合成一个带索引的池子，页面世界里只做这一次 */
export function preparePool(titles: string[], staleTitles: string[] = []): HotEntry[] {
  // 老条目单独标记：engine 会给它们抬高分数线
  const entries = [
    ...prepareHot(titles),
    ...prepareHot(staleTitles).map((entry) => ({ ...entry, stale: true })),
  ];
  return attachIndex(entries);
}

/**
 * 判定单个标题是否该屏蔽。三级策略，从严到宽：
 * 1. exact   —— 归一后完全相同，直接命中（score 1）
 * 2. contain —— 一方包含另一方，用长度比当分数（防"短标题吃掉长标题"）
 * 3. dice    —— bigram 相似度 ≥ 阈值
 * 白名单优先级最高；短标题只允许走 exact/contain，避免"三个字撞车"。
 *
 * 池子带索引时先挑候选再算分，没索引时退回线性扫描（两路结论一致）。
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

  // 查询侧的 bigram 只建一次，而不是每条热榜建一次
  const q = norm.length >= 2 ? hashBigrams(norm) : null;
  const qTotal = q ? q.total : 0;

  const index = INDEXES.get(hot);
  // 短标题（< minLen）只走 exact/contain，本来就不进索引；池子没索引时也走线性
  if (index && q && norm.length >= minLen) {
    const viaIndex = matchCandidates(norm, q.hashes, qTotal, hot, index, threshold, minLen);
    if (viaIndex) return viaIndex;
  }
  return matchLinear(norm, q ? q.hashes : null, qTotal, hot, threshold, minLen);
}

/**
 * 索引路径：返回 null 表示「这次不适用索引，交给线性扫描」（预算超了）。
 *
 * 剪枝依据：过线所需的共享量有严格下界——
 *   dice  ≥ T  ⇒ overlap ≥ T·(qTotal+eTotal)/2
 *   cover ≥ T  ⇒ overlap ≥ T·min(qTotal,eTotal)
 * 后者恒小于前者，所以 need = T·min(qTotal,eTotal) 同时覆盖两条路。
 * 用「查询侧 bigram 权重和」当 overlap 的上界，低于 need 的条目不可能过线。
 */
function matchCandidates(
  norm: string,
  qHashes: Uint32Array,
  qTotal: number,
  hot: HotEntry[],
  index: HotIndex,
  threshold: number,
  minLen: number,
): MatchResult | null {
  const ub = new Map<number, number>();
  let work = 0;

  // 查询侧哈希已升序，重复值合并成次数，省掉重复的 posting 遍历
  let prev = -1;
  let count = 0;
  for (let k = 0; k <= qHashes.length; k += 1) {
    const h = k < qHashes.length ? qHashes[k] : -1;
    if (h === prev) {
      count += 1;
      continue;
    }
    if (prev !== -1) {
      const list = index.postings.get(prev);
      if (list) {
        work += list.length;
        if (work > WORK_BUDGET) return null;
        for (let j = 0; j < list.length; j += 1) {
          const i = list[j];
          ub.set(i, (ub.get(i) ?? 0) + count);
        }
      }
    }
    prev = h;
    count = 1;
  }

  // 按条目原顺序遍历：分数相同时"先到者胜"，与线性扫描的 tie-break 保持一致
  const order = [...ub.keys()].sort((a, b) => a - b);
  let best: MatchResult = NO_HIT;

  for (const i of order) {
    const entry = hot[i];
    if (entry.norm === norm) return { hit: true, score: 1, zhihuTitle: entry.raw, reason: 'exact' };
  }

  for (const i of order) {
    const entry = hot[i];
    const entryHashes = entry.hashes;
    if (!entryHashes) continue;

    const entryThreshold = Math.min(0.98, threshold + (entry.stale ? 0.05 : 0));
    const eTotal = entry.gramTotal ?? entryHashes.length;

    // 必要条件：共享量上界必须够得着分数线
    if ((ub.get(i) ?? 0) < entryThreshold * Math.min(qTotal, eTotal)) continue;

    const shorterLen = Math.min(norm.length, entry.norm.length);
    const longerLen = Math.max(norm.length, entry.norm.length);
    if (shorterLen / longerLen < MIN_LEN_RATIO) continue;

    best = consider(norm, qHashes, qTotal, entry, entryHashes, eTotal, entryThreshold, minLen, best);
  }

  return best;
}

/** 线性扫描：题库小、或标题过短、或索引预算超支时使用 */
function matchLinear(
  norm: string,
  qHashes: Uint32Array | null,
  qTotal: number,
  hot: HotEntry[],
  threshold: number,
  minLen: number,
): MatchResult {
  let best: MatchResult = NO_HIT;

  for (const entry of hot) {
    // 老条目（>7 天）没有新鲜度背书，分数线抬高 0.05：
    // 池子变大后误伤几乎都来自这里——旧标题的常见词更容易和新视频撞上。
    const entryThreshold = Math.min(0.98, threshold + (entry.stale ? 0.05 : 0));

    if (entry.norm === norm) {
      return { hit: true, score: 1, zhihuTitle: entry.raw, reason: 'exact' };
    }

    if (!qHashes || norm.length < minLen) {
      // 短标题：只做 exact / contain，避免"三个字撞车"
      best = considerContain(norm, entry, entryThreshold, minLen, best);
      continue;
    }

    const entryHashes = entry.hashes;
    if (!entryHashes) continue;

    const shorterLen = Math.min(norm.length, entry.norm.length);
    const longerLen = Math.max(norm.length, entry.norm.length);
    // 长度差过大时相似度不可能过线，跳过两次交集计算
    if (shorterLen / longerLen < MIN_LEN_RATIO) {
      best = considerContain(norm, entry, entryThreshold, minLen, best);
      continue;
    }

    const eTotal = entry.gramTotal ?? entryHashes.length;
    best = considerContain(norm, entry, entryThreshold, minLen, best);
    best = considerScored(
      qHashes,
      qTotal,
      entry,
      entryHashes,
      eTotal,
      entryThreshold,
      best,
    );
  }

  return best;
}

/** 2. 强包含：一方是另一方的子串，用长度比当分数 */
function considerContain(
  norm: string,
  entry: HotEntry,
  entryThreshold: number,
  minLen: number,
  best: MatchResult,
): MatchResult {
  if (norm.length < 2 || entry.norm.length < 2) return best;
  const shorter = norm.length <= entry.norm.length ? norm : entry.norm;
  const longer = shorter === norm ? entry.norm : norm;
  if (!longer.includes(shorter)) return best;
  const ratio = shorter.length / longer.length;
  // 短片段要更严：低于 minLen 的子串必须几乎等价于整条标题才算命中
  const need = shorter.length < minLen ? Math.max(0.95, entryThreshold) : Math.max(0.55, entryThreshold);
  if (ratio >= need && ratio > best.score) {
    return { hit: true, score: round(ratio), zhihuTitle: entry.raw, reason: 'contain' };
  }
  return best;
}

/** 3. dice + 4. 覆盖率 */
function considerScored(
  qHashes: Uint32Array,
  qTotal: number,
  entry: HotEntry,
  entryHashes: Uint32Array,
  eTotal: number,
  entryThreshold: number,
  best: MatchResult,
): MatchResult {
  let next = best;
  const score = diceFromHashed(qHashes, qTotal, entryHashes, eTotal);
  if (score >= entryThreshold && score > next.score) {
    next = { hit: true, score: round(score), zhihuTitle: entry.raw, reason: 'dice' };
  }
  // 非对称覆盖率：专治"B 站标题是知乎原题删减版"这个高频场景
  const cover = coverageFromHashed(qHashes, qTotal, entryHashes, eTotal);
  if (cover >= entryThreshold && cover > next.score) {
    next = { hit: true, score: round(cover), zhihuTitle: entry.raw, reason: 'cover' };
  }
  return next;
}

/** 索引路径的单条目判定（含 contain，保持与线性路径同序） */
function consider(
  norm: string,
  qHashes: Uint32Array,
  qTotal: number,
  entry: HotEntry,
  entryHashes: Uint32Array,
  eTotal: number,
  entryThreshold: number,
  minLen: number,
  best: MatchResult,
): MatchResult {
  const withContain = considerContain(norm, entry, entryThreshold, minLen, best);
  return considerScored(qHashes, qTotal, entry, entryHashes, eTotal, entryThreshold, withContain);
}
