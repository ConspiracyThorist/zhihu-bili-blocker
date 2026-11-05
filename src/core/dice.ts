/**
 * 字符 bigram Dice 相似度。
 *
 * 为什么不用 Levenshtein：中文短标题上一个字的改动（"的"→""、语序微调）
 * 会让编辑距离显得很大，而 bigram 对"局部改写"更宽容，对"整体无关"仍然敏感。
 * 搬运视频的典型改动是加前缀后缀、换说法，正是 bigram 的强项。
 *
 * 性能注意：hot 条目要参与成千上万次比较，bigram 必须预先算好。
 * 所以这里把「建表」和「算分」拆开，匹配时只建一次查询侧的表。
 */
export type GramMap = Map<string, number>;

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
