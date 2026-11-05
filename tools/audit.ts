/**
 * 题库体检：把题库里的每条标题拿去 B 站搜索，看能不能搜到「同题视频」。
 *
 * 测的是题库的**召回能力**（这条标题在 B 站有没有对应内容），
 * 不等于实际拦截率——首页推荐未必推它。报告里会写明这个区别。
 *
 * 用法（由 run-audit.mjs 打包后执行）：
 *   node dist/tools/audit.mjs --seed data/seed.txt --limit 0 --sample 12
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSearcher } from './bili-search.mjs';
import { matchTitle, prepareHot, type HotEntry } from '../src/core/engine';
import { normalize } from '../src/core/normalize';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETTINGS: Settings = { ...DEFAULT_SETTINGS };

const arg = (name: string, fallback: string | number): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : String(fallback);
};

const seedPath = arg('seed', join(root, 'data', 'seed.txt'));
const limit = Number(arg('limit', 0));
const sample = Number(arg('sample', 12));

interface Strat {
  name: string;
  keyword: (title: string) => string;
  applies?: (title: string) => boolean;
}

/**
 * 实体词策略：中文标题里能当检索锚点的通常是拉丁词与数字代号
 * （BLG / HLE / S16 / Deepseek / 2026）。按"人会怎么搜"来拼。
 *
 * 必须用**原始标题**取词：归一化会把 "2:0" 拼成 "20"，把 "BLG" 粘进中文里。
 */
export function entityTokens(title: string): string[] {
  const raw = title.match(/[A-Za-z]+\d*|\d+[A-Za-z]+/g) ?? [];
  const tokens = raw
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t));
  return [...new Set(tokens)].slice(0, 3);
}

const STRATEGIES: Strat[] = [
  { name: 'A 原句', keyword: (t) => t },
  { name: 'B 归一前12字', keyword: (t) => normalize(t).slice(0, 12) },
  { name: 'C 归一前8字', keyword: (t) => normalize(t).slice(0, 8) },
  {
    name: 'D 实体词',
    keyword: (t) => entityTokens(t).join(' '),
    applies: (t) => entityTokens(t).length > 0,
  },
];

interface HitItem {
  bvid: string;
  title: string;
  score: number;
  reason: string;
}

interface Row {
  title: string;
  source: string;
  keyword: string;
  total: number;
  hits: HitItem[];
  /** 20 条结果里与本题最相似的一条的分数（阈值压到 0.4 才有意义），用于区分"改写"与"没人搬" */
  best: number;
  bestTitle: string;
}

async function loadSourceMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const metaPath = seedPath.replace(/\.txt$/, '.meta.json');
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { entries: { title: string; source: string }[] };
    for (const e of meta.entries ?? []) map.set(e.title, e.source);
  } catch {
    /* 没有元数据就按 unknown 统计 */
  }
  return map;
}

async function loadTitles(): Promise<string[]> {
  const text = await readFile(seedPath, 'utf8');
  const titles = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => l.length <= 120);
  return limit > 0 ? titles.slice(0, limit) : titles;
}

async function auditOne(
  searcher: Awaited<ReturnType<typeof createSearcher>>,
  entry: HotEntry,
  keyword: string,
  source: string,
): Promise<Row> {
  const empty: Row = { title: entry.raw, source, keyword, total: 0, hits: [], best: 0, bestTitle: '' };
  if (!keyword || keyword.length < 2) return empty;

  const res = await searcher.search(keyword);
  // 用低阈值再算一遍，拿到"最相似"的分数；是否算命中仍按产品阈值判
  const loose: Settings = { ...SETTINGS, threshold: 0.4 };
  const hits: HitItem[] = [];
  let best = 0;
  let bestTitle = '';
  for (const item of res.items) {
    const r = matchTitle(item.title, [entry], loose);
    if (r.score > best) {
      best = r.score;
      bestTitle = item.title;
    }
    if (r.score >= SETTINGS.threshold) {
      hits.push({ bvid: item.bvid, title: item.title, score: r.score, reason: r.reason });
    }
  }
  return { title: entry.raw, source, keyword, total: res.items.length, hits, best, bestTitle };
}

function summarize(rows: Row[]) {
  const hitRows = rows.filter((r) => r.hits.length > 0);
  // 三档：能拦 / 相关但改写 / 没人搬
  const strong = hitRows.length;
  const weak = rows.filter((r) => r.hits.length === 0 && r.best >= 0.5).length;
  return {
    total: rows.length,
    hitTitles: hitRows.length,
    rate: rows.length ? hitRows.length / rows.length : 0,
    avgResults: rows.reduce((s, r) => s + r.total, 0) / Math.max(rows.length, 1),
    avgHits: hitRows.reduce((s, r) => s + r.hits.length, 0) / Math.max(hitRows.length, 1),
    strong,
    weak,
    none: rows.length - strong - weak,
  };
}

function groupBySource(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const list = groups.get(row.source) ?? [];
    list.push(row);
    groups.set(row.source, list);
  }
  return [...groups.entries()].map(([source, list]) => ({ source, s: summarize(list) }));
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const titles = await loadTitles();
  const entries = prepareHot(titles);
  const sourceMap = await loadSourceMap();
  const sourceOf = (title: string) => sourceMap.get(title) ?? 'unknown';

  console.log(`题库：${titles.length} 条（归一后 ${entries.length} 条）`);

  const searcher = await createSearcher({ intervalMs: 1000 });

  // 阶段一：在热榜条目上比对检索词策略（日报长文对策略不敏感，放进来会污染结论）
  const hotEntries = entries.filter((e) => sourceOf(e.raw) === 'hot');
  const pool = (hotEntries.length >= 5 ? hotEntries : entries).slice(0, Math.min(sample, entries.length));
  console.log(`\n[阶段一] 策略对比，样本 ${pool.length} 条（来源：${hotEntries.length >= 5 ? '热榜' : '全部'}）`);

  const stratStats: { strat: Strat; rows: Row[]; s: ReturnType<typeof summarize> }[] = [];
  for (const strat of STRATEGIES) {
    const rows: Row[] = [];
    for (const entry of pool) {
      const kw = strat.applies && !strat.applies(entry.raw) ? '' : strat.keyword(entry.raw).trim();
      rows.push(await auditOne(searcher, entry, kw, sourceOf(entry.raw)));
    }
    const s = summarize(rows);
    stratStats.push({ strat, rows, s });
    console.log(
      `  ${strat.name.padEnd(12)} 命中 ${s.hitTitles}/${s.total} (${pct(s.rate)})，平均结果 ${s.avgResults.toFixed(1)}，平均命中 ${s.avgHits.toFixed(1)}`,
    );
  }

  // 只用「对所有标题都适用」的策略里挑最好的一档
  const universal = stratStats.filter((x) => !x.strat.applies);
  const bestUniversal = [...universal].sort((a, b) => b.s.hitTitles - a.s.hitTitles || b.s.avgHits - a.s.avgHits)[0];
  const dStat = stratStats.find((x) => x.strat.name.startsWith('D'));
  console.log(`  通用策略选用：${bestUniversal.strat.name}${dStat ? `；含实体词时改用 D（样本命中 ${dStat.s.hitTitles}/${dStat.s.total}）` : ''}`);

  // 阶段二：全量。含拉丁/数字的标题走实体词，其余走通用最优策略
  console.log(`\n[阶段二] 全量体检，${entries.length} 条`);
  const rows: Row[] = [];
  let done = 0;
  for (const entry of entries) {
    const tokens = entityTokens(entry.raw);
    const kw = tokens.length > 0 ? tokens.join(' ') : bestUniversal.strat.keyword(entry.raw);
    rows.push(await auditOne(searcher, entry, kw.trim(), sourceOf(entry.raw)));
    done += 1;
    if (done % 10 === 0) process.stdout.write(`  ${done}/${entries.length}\r`);
  }

  const s = summarize(rows);
  const groups = groupBySource(rows);
  const zero = rows.filter((r) => r.hits.length === 0);
  const hitRows = rows.filter((r) => r.hits.length > 0);

  const report = [
    '# 题库体检报告',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 题库文件：${seedPath}`,
    `- 条目数：${entries.length}`,
    `- 检索策略：含实体词走「实体词」，否则走「${bestUniversal.strat.name}」`,
    `- 请求数：${searcher.calls}`,
    '',
    '## 结论',
    '',
    `- **整体命中率：${pct(s.rate)}**（${s.hitTitles}/${s.total} 条标题能在 B 站搜到同题视频）`,
    `- 命中条目的平均命中视频数：${s.avgHits.toFixed(2)}`,
    '',
    '### 按来源拆分（关键）',
    '',
    '| 来源 | 条数 | 能拦 | 相关 | 没人搬 | 能拦率 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...groups.map(
      (g) =>
        `| ${g.source} | ${g.s.total} | ${g.s.strong} | ${g.s.weak} | ${g.s.none} | ${pct(g.s.rate)} |`,
    ),
    '',
    '> 搜索命中 ≠ 会被首页推荐。这是题库召回能力的**上界估计**，实际拦截率会低于此值。',
    '',
    '## 策略对比（小样本）',
    '',
    '| 策略 | 命中标题 | 命中率 | 平均结果数 | 平均命中数 |',
    '| --- | --- | --- | --- | --- |',
    ...stratStats.map(
      (x) => `| ${x.strat.name} | ${x.s.hitTitles}/${x.s.total} | ${pct(x.s.rate)} | ${x.s.avgResults.toFixed(1)} | ${x.s.avgHits.toFixed(1)} |`,
    ),
    '',
    '## 命中最强的 10 条',
    '',
    ...hitRows
      .sort((a, b) => b.hits.length - a.hits.length)
      .slice(0, 10)
      .map(
        (r) =>
          `- **${r.title}**\n  - 检索词：\`${r.keyword}\`，命中 ${r.hits.length} 条，最高分 ${Math.max(...r.hits.map((h) => h.score)).toFixed(2)}\n  - 例：${r.hits[0].title}`,
      ),
    '',
    '## 零命中清单',
    '',
    zero.length === 0 ? '_无_' : zero.map((r) => `- [${r.source}] ${r.title}`).join('\n'),
    '',
  ].join('\n');

  const outDir = join(root, 'reports');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'pool-audit.md'), report, 'utf8');
  await writeFile(
    join(outDir, 'pool-audit.json'),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), strategy: bestUniversal.strat.name, summary: s, groups, rows },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`\n整体命中率 ${pct(s.rate)}（${s.hitTitles}/${s.total}）`);
  for (const g of groups) console.log(`  ${g.source.padEnd(8)} ${g.s.hitTitles}/${g.s.total} (${pct(g.s.rate)})`);
  console.log('报告：docs/pool-audit.md');
}

main().catch((err) => {
  console.error('体检失败：', err);
  process.exit(1);
});
