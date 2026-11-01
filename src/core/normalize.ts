/**
 * 文本归一：把"知乎标题"和"B 站视频标题"拉到同一个可比的形态。
 *
 * 归一顺序有讲究：
 * 1. 全角转半角 —— 「ＨＥＬＬＯ」与「hello」应视为相同
 * 2. 小写
 * 3. 去 emoji
 * 4. 去标点与符号 —— 中文标点、书名号「【】」都在 \p{P} 里，一并清掉
 * 5. 去模板词 —— 「知乎」「如何看待」这类词几乎每个搬运标题都有，
 *    留着会给所有标题贡献虚高的相似度（这是最常见的误伤来源）
 */
const TEMPLATE_WORDS = [
  '是一种什么样的体验',
  '是一种怎样的体验',
  '是一种什么体验',
  '是怎样的一种体验',
  '是一种什么感受',
  '如何看待',
  '怎样看待',
  '怎么看待',
  '如何评价',
  '怎么评价',
  '是怎样的体验',
  '是什么体验',
  '是什么意思',
  '有哪些',
  '为什么',
  '是什么',
  '高赞回答',
  '高赞',
  '神回复',
  '热榜',
  '搬运',
  '知乎',
  '问题',
].sort((a, b) => b.length - a.length);

const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
const PUNCT_RE = /[\p{P}\p{S}\s]/gu;

/** 全角 → 半角；全角空格 → 普通空格 */
function toHalfWidth(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code === 0x3000) {
      out += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - 0xfee0);
    } else {
      out += ch;
    }
  }
  return out;
}

export function normalize(input: string): string {
  if (!input) return '';
  let s = toHalfWidth(input).toLowerCase();
  s = s.replace(EMOJI_RE, ' ');
  s = s.replace(PUNCT_RE, '');
  for (const word of TEMPLATE_WORDS) {
    if (s.includes(word)) s = s.split(word).join('');
  }
  return s.trim();
}
