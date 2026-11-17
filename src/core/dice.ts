/**
 * 字符 bigram Dice 相似度。
 *
 * 为什么不用 Levenshtein：中文短标题上一个字的改动（"的"→""、语序微调）
 * 会让编辑距离显得很大，而 bigram 对"局部改写"更宽容，对"整体无关"仍然敏感。
 * 搬运视频的典型改动是加前缀后缀、换说法，正是 bigram 的强项。
 *
 * 性能与内存：题库上万条后，每条都存一份 Map<string, number> 要吃掉几十 MB，
 * 所以条目侧改用「排序后的 32 位哈希数组」——多集交集用双指针求，
 * 20k 条题库的堆占用从 ~55 MB 降到几 MB，算分也更快（没有哈希表查找）。
 * 下面的 Map 版实现保留给测试与工具做对照，运行时不走它。
 */
export type GramMap = Map<string, number>;

/** 32 位 FNV-1a：同一个 bigram 永远得到同一个数 */
export function gramHash(g: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < g.length; i += 1) {
    h ^= g.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface HashedGrams {
  /** 升序排列的 bigram 哈希，保留重复（重复表示同一个 bigram 出现多次） */
  hashes: Uint32Array;
  /** bigram 总数（含重复），等于长度 - 1 */
  total: number;
}

/** 归一标题 → 排序哈希序列；空串得到空表 */
export function hashBigrams(s: string): HashedGrams {
  if (!s) return { hashes: new Uint32Array(0), total: 0 };
  if (s.length < 2) return { hashes: Uint32Array.from([gramHash(s)]), total: 1 };
  const out = new Uint32Array(s.length - 1);
  for (let i = 0; i < s.length - 1; i += 1) out[i] = gramHash(s.slice(i, i + 2));
  out.sort();
  return { hashes: out, total: out.length };
}

/** 两个升序序列的多集交集大小（= 共享的 bigram 个数，含重复计次） */
export function sortedOverlap(a: Uint32Array, b: Uint32Array): number {
  let i = 0;
  let j = 0;
  let overlap = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x === y) {
      overlap += 1;
      i += 1;
      j += 1;
    } else if (x < y) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return overlap;
}

export function diceFromHashed(a: Uint32Array, aTotal: number, b: Uint32Array, bTotal: number): number {
  if (aTotal === 0 || bTotal === 0) return 0;
  return (2 * sortedOverlap(a, b)) / (aTotal + bTotal);
}

export function coverageFromHashed(a: Uint32Array, aTotal: number, b: Uint32Array, bTotal: number): number {
  const denominator = Math.min(aTotal, bTotal);
  if (denominator === 0) return 0;
  return sortedOverlap(a, b) / denominator;
}

// ---------------------------------------------------------------------------
// 下面是 Map 版实现：语义与上面完全一致，保留给测试与调参工具做对照。
// ---------------------------------------------------------------------------

export function bigramMap(s: string): GramMap {
  const map: GramMap = new Map();
  if (s.length < 2) {
    if (s.length === 1) map.set(s, 1);
    return map;
  }
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    map.set(g, (map.get(g) ?? 0) + 1);
  }
  return map;
}

/** 表里 bigram 的总数（含重复），等于 len-1（长度≥2 时） */
export function gramTotal(map: GramMap): number {
  let total = 0;
  for (const n of map.values()) total += n;
  return total;
}

export function diceFromMaps(a: GramMap, aTotal: number, b: GramMap, bTotal: number): number {
  if (aTotal === 0 || bTotal === 0) return 0;
  let overlap = 0;
  // 遍历小的一侧，减少查找次数
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [g, n] of small) {
    const m = big.get(g);
    if (m) overlap += Math.min(n, m);
  }
  return (2 * overlap) / (aTotal + bTotal);
}

export function coverageFromMaps(a: GramMap, aTotal: number, b: GramMap, bTotal: number): number {
  const denominator = Math.min(aTotal, bTotal);
  if (denominator === 0) return 0;
  let overlap = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [g, n] of small) {
    const m = big.get(g);
    if (m) overlap += Math.min(n, m);
  }
  return overlap / denominator;
}

/** 返回 0~1；a === b 且非空时为 1 */
export function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const left = bigramMap(a);
  const right = bigramMap(b);
  return diceFromMaps(left, gramTotal(left), right, gramTotal(right));
}

/**
 * 非对称覆盖率：短标题的 bigram 有多大比例出现在长标题里。
 *
 * 为什么需要它：B 站搬运标题通常比知乎原题短（去掉了后半句、解释性从句），
 * 这时对称 Dice 会被长度差拖到 0.6 附近而漏判，覆盖率却能给到 0.9。
 * 反向（B 站标题比知乎长）同样成立，取 min 分母天然对称处理。
 */
export function bigramCoverage(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const left = bigramMap(a);
  const right = bigramMap(b);
  return coverageFromMaps(left, gramTotal(left), right, gramTotal(right));
}
