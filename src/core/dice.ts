/**
 * 字符 bigram Dice 相似度。
 *
 * 为什么不用 Levenshtein：中文短标题上一个字的改动（"的"→""、语序微调）
 * 会让编辑距离显得很大，而 bigram 对"局部改写"更宽容，对"整体无关"仍然敏感。
 * 搬运视频的典型改动是加前缀后缀、换说法，正是 bigram 的强项。
 */
function bigrams(s: string): Map<string, number> {
  const map = new Map<string, number>();
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

/** 返回 0~1；a === b 且非空时为 1 */
export function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of left) {
    total += n;
    const m = right.get(g);
    if (m) overlap += Math.min(n, m);
  }
  for (const n of right.values()) total += n;
  if (total === 0) return 0;
  return (2 * overlap) / total;
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
  const left = bigrams(a);
  const right = bigrams(b);
  let overlap = 0;
  let totalA = 0;
  let totalB = 0;
  for (const [g, n] of left) {
    totalA += n;
    const m = right.get(g);
    if (m) overlap += Math.min(n, m);
  }
  for (const n of right.values()) totalB += n;
  const denominator = Math.min(totalA, totalB);
  if (denominator === 0) return 0;
  return overlap / denominator;
}
