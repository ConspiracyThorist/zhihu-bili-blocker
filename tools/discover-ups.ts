/**
 * UP 库自动发现：拿题库标题去 B 站搜索，统计「谁在系统性搬运」。
 *
 * 判定用双门槛：命中 ≥2 条且命中率 ≥30%（见 core/ups.ts 的 qualifies）。
 * 单条命中不拉黑，避免一次标题撞车就封掉正常 UP。
 *
 * 这个任务放在 CI 里跑，不在客户端——259 条 × 1.2 秒是几分钟的量，
 * 让每个用户的浏览器都去搜一遍既慢又容易被风控。
 *
 * 用法：node tools/run-discover.mjs [--limit N]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSearcher } from './bili-search.mjs';
import { matchTitle, prepareHot } from '../src/core/engine';
import { qualifies } from '../src/core/ups';
import { DEFAULT_SETTINGS, MODES, type Settings } from '../src/core/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 命中定义用「标准」档，比默认的保守宽松一点：反查 UP 需要更多样本才稳 */
const STANDARD = MODES.find((m) => m.id === 'standard')!;
const MATCHER: Settings = { ...DEFAULT_SETTINGS, threshold: STANDARD.threshold };
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '--limit=0').split('=')[1]);

const seed = await readFile(join(root, 'seed.txt'), 'utf8');
const titles = seed
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && l.length <= 120);
const entries = prepareHot(titles);
const pool = entries.slice(0, LIMIT > 0 ? LIMIT : entries.length);

console.log(`题库 ${entries.length} 条，本次搜 ${pool.length} 条`);

const searcher = await createSearcher({ intervalMs: 1200 });

/** mid -> { name, total, hits, samples } */
const stats = new Map<number, { name: string; total: number; hits: number; samples: string[] }>();

let done = 0;
for (const entry of pool) {
  const keyword = entry.norm.slice(0, 12) || entry.raw;
  const res = await searcher.search(keyword);
  for (const item of res.items) {
    if (!item.mid) continue;
    const hit = matchTitle(item.title, [entry], MATCHER).hit;
    const cur = stats.get(item.mid) ?? { name: item.author ?? '', total: 0, hits: 0, samples: [] };
    cur.total += 1;
    if (hit) {
      cur.hits += 1;
      if (cur.samples.length < 3) cur.samples.push(item.title.slice(0, 50));
    }
    if (!cur.name && item.author) cur.name = item.author;
    stats.set(item.mid, cur);
  }
  done += 1;
  if (done % 20 === 0 || done === pool.length) process.stdout.write(`  ${done}/${pool.length}\r`);
}

const qualified = [...stats.entries()]
  .filter(([, s]) => qualifies(s.hits, s.total))
  .map(([mid, s]) => ({
    mid,
    name: s.name,
    hits: s.hits,
    total: s.total,
    rate: Math.round((s.hits / s.total) * 100) / 100,
    samples: s.samples,
  }))
  .sort((a, b) => b.hits - a.hits || b.rate - a.rate);

const upsFile = {
  generatedAt: new Date().toISOString(),
  threshold: MATCHER.threshold,
  entries: qualified,
};

await mkdir(join(root, 'reports'), { recursive: true });
await writeFile(join(root, 'ups.json'), `${JSON.stringify(upsFile, null, 2)}\n`, 'utf8');

console.log(`\n扫描到 ${stats.size} 个 UP，入选 ${qualified.length} 个（命中≥2 且命中率≥30%）`);
for (const u of qualified.slice(0, 10)) {
  console.log(`  ${String(u.hits).padStart(3)}/${String(u.total).padStart(3)}  ${u.name}（${u.mid}）  ${u.samples[0] ?? ''}`);
}
console.log('\n写入 ups.json');
