/**
 * 生成题库种子文件 seed.txt（纯文本，一行一条，# 开头是注释）。
 *
 * 数据来源：
 *   1. 知乎热榜（当前 30 条）
 *   2. 知乎日报往期（每天 4~8 条，可回翻）
 *
 * 为什么日报权重不低：2026-11-01 体检显示，日报类"常青问题"的 B 站
 * 命中率是 17.0%，高于热榜时事类的 13.3%——搬运者做"知乎问答"合集时
 * 往往直接拿问题原文当标题。
 *
 * 用法：node tools/build-seed.mjs [--days 60] [--out seed.txt]
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx > -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const days = Number(arg('days', 60));
const outPath = arg('out', join(root, 'seed.txt'));

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 只用于去重的轻量归一，真正的匹配归一在 src/core/normalize.ts */
function dedupeKey(title) {
  return String(title)
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

const seen = new Set();
const entries = [];

function add(title, source, date) {
  if (typeof title !== 'string') return;
  const clean = title.trim();
  if (!clean || clean.length > 120) return;
  const key = dedupeKey(clean);
  if (!key || seen.has(key)) return;
  seen.add(key);
  entries.push({ title: clean, source, date });
}

function ymd(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

async function main() {
  // 1. 热榜
  const hot = await getJson('https://api.zhihu.com/topstory/hot-list?limit=50&reverse_order=0');
  const today = ymd(new Date());
  for (const item of hot.data ?? []) {
    add(item?.target?.title, 'hot', today);
  }
  console.log(`热榜：${entries.length} 条`);

  // 2. 知乎日报往期：before/{date} 返回 date 前一天的内容
  let dailyCount = 0;
  for (let i = 1; i <= days; i += 1) {
    const target = new Date();
    target.setDate(target.getDate() - i);
    const next = new Date(target);
    next.setDate(next.getDate() + 1);
    try {
      const j = await getJson(`https://news-at.zhihu.com/api/4/news/before/${ymd(next)}`);
      for (const story of j.stories ?? []) {
        const before = entries.length;
        add(story.title, 'daily', ymd(target));
        if (entries.length > before) dailyCount += 1;
      }
    } catch (err) {
      console.warn(`  日报 ${ymd(target)} 失败：${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`日报：+${dailyCount} 条（回翻 ${days} 天）`);

  const header = [
    '# zhihu-bili-blocker seed',
    `# generated: ${new Date().toISOString().slice(0, 10)}`,
    `# sources: hot(${entries.filter((e) => e.source === 'hot').length}) + daily(${dailyCount})`,
    `# total: ${entries.length}`,
    '# 一行一条，客户端按行读取并本地累积',
    '',
  ].join('\n');

  const body = entries.map((e) => e.title).join('\n');
  await writeFile(outPath, `${header}\n${body}\n`, 'utf8');
  console.log(`\n写入 ${outPath}（${entries.length} 条）`);

  // 附带一份带来源的元数据，供体检工具分组统计（分发包里不需要）
  const metaPath = outPath.replace(/\.txt$/, '.meta.json');
  await writeFile(
    metaPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2),
    'utf8',
  );
  console.log(`写入 ${metaPath}（含来源标注）`);
}

main().catch((err) => {
  console.error('生成失败：', err.message);
  process.exit(1);
});
