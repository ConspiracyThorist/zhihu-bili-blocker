/**
 * 阈值调参实验。
 *
 * 对题库里每条标题：拿它去 B 站搜 20 条结果，记录两件事
 *   1. own   —— 该结果与「本条标题」的相似度（召回信号）
 *   2. cross —— 该结果与「库里其他标题」的最高相似度（误伤代理指标）
 *
 * 跑完可以画出「阈值 → 召回 / 交叉命中」两条曲线，用来定三档的数值。
 *
 * 用法：node tools/run-tune.mjs [--limit 259]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSearcher } from './bili-search.mjs';
import { matchTitle, prepareHot } from '../src/core/engine';
import { normalize } from '../src/core/normalize';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOOSE: Settings = { ...DEFAULT_SETTINGS, threshold: 0.5 };
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '--limit=0').split('=')[1]);

const seed = await readFile(join(root, 'seed.txt'), 'utf8');
const titles = seed
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && l.length <= 120);

const entries = prepareHot(titles);
const pool = entries.slice(0, LIMIT > 0 ? LIMIT : entries.length);
console.log(`题库 ${entries.length} 条，本次跑 ${pool.length} 条`);

const searcher = await createSearcher({ intervalMs: 1200 });
const rows: { title: string; keyword: string; results: { title: string; own: number; cross: number }[] }[] = [];

let done = 0;
for (const entry of pool) {
  const keyword = normalize(entry.raw).slice(0, 12) || entry.raw;
  const res = await searcher.search(keyword);
  const scored = [];

  for (const item of res.items) {
    const own = matchTitle(item.title, [entry], LOOSE).score;
    let cross = 0;
    for (const other of entries) {
      if (other === entry) continue;
      const s = matchTitle(item.title, [other], LOOSE).score;
      if (s > cross) cross = s;
    }
    scored.push({ title: item.title, own, cross });
  }

  rows.push({ title: entry.raw, keyword, results: scored });
  done += 1;
  if (done % 10 === 0 || done === pool.length) {
    process.stdout.write(`  ${done}/${pool.length}\r`);
  }
}

const outDir = join(root, 'reports');
await mkdir(outDir, { recursive: true });
await writeFile(
  join(outDir, 'tune.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), poolSize: pool.length, rows }, null, 2),
  'utf8',
);

// ---- 汇总 ----
const thresholds = [0.5, 0.6, 0.66, 0.7, 0.72, 0.75, 0.78, 0.8, 0.82, 0.85, 0.86, 0.88, 0.9, 0.92];
console.log('\n阈值  召回条数  召回率   交叉命中数  交叉率   每查询平均命中');
for (const T of thresholds) {
  let recalled = 0;
  let crossHits = 0;
  const totalResults = rows.reduce((n, r) => n + r.results.length, 0);
  for (const row of rows) {
    if (row.results.some((r) => r.own >= T - 1e-9)) recalled += 1;
    for (const r of row.results) {
      // 这条结果没命中本条目，却命中了库里别的条目 → 潜在的跨条目误判
      if (r.own < T - 1e-9 && r.cross >= T - 1e-9) crossHits += 1;
    }
  }
  console.log(
    `${T.toFixed(2)}  ${String(recalled).padStart(4)}     ${((recalled / rows.length) * 100).toFixed(1)}%   ${String(crossHits).padStart(6)}      ${((crossHits / Math.max(totalResults, 1)) * 100).toFixed(2)}%`,
  );
}

// own 分数分布（正样本：本条目自己的最高分）
const ownMax = rows.map((r) => Math.max(0, ...r.results.map((x) => x.own))).sort((a, b) => b - a);
console.log('\n每条标题的最高 own 分数（前 30）：');
console.log(ownMax.slice(0, 30).map((x) => x.toFixed(2)).join(' '));

const allCross = rows.flatMap((r) => r.results.map((x) => x.cross)).sort((a, b) => b - a);
console.log('\ncross 分数（前 20）:', allCross.slice(0, 20).map((x) => x.toFixed(2)).join(' '));
