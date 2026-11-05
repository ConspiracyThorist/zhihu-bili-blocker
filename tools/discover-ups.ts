/**
 * UP 库自动发现：拿题库标题去 B 站搜索，统计「谁在系统性搬运」。
 *
 * 判定用双门槛：命中 ≥2 条且命中率 ≥30%（见 core/ups.ts 的 qualifies）。
 * 单条命中不拉黑，避免一次标题撞车就封掉正常 UP。
 *
 * 两种模式，共用同一份 ups.json：
 *   --incremental（默认）只搜上次之后新增的标题，几十秒跑完，结果**合并**进已有条目
 *   --full        全量重扫，结果**重建**（会清掉不再符合条件的条目）
 *
 * 增量必须合并而不是覆盖：只扫了几十条，命中数天然比全量小，
 * 直接覆盖会把上一轮攒下的 UP 全部清空。
 *
 * 这个任务放在 CI 里跑，不在客户端——259 条 × 1.2 秒是几分钟的量，
 * 让每个用户的浏览器都去搜一遍既慢又容易被风控。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSearcher } from './bili-search.mjs';
import { matchTitle, prepareHot } from '../src/core/engine';
import { qualifies } from '../src/core/ups';
import { DEFAULT_SETTINGS, MODES, type Settings } from '../src/core/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPS_PATH = join(root, 'data', 'ups.json');
/** 命中定义用「标准」档，比默认的保守宽松一点：反查 UP 需要更多样本才稳 */
const STANDARD = MODES.find((m) => m.id === 'standard')!;
const MATCHER: Settings = { ...DEFAULT_SETTINGS, threshold: STANDARD.threshold };

const FULL = process.argv.includes('--full');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '--limit=0').split('=')[1]);
/** scanned 列表的上限，防止文件无限膨胀 */
const SCANNED_MAX = 2000;

interface UpsFile {
  generatedAt: string;
  threshold: number;
  mode?: 'full' | 'incremental';
  scanned?: string[];
  entries: { mid: number; name: string; hits: number; total: number; rate: number; samples: string[] }[];
}

async function readExisting(): Promise<UpsFile | null> {
  try {
    return JSON.parse(await readFile(UPS_PATH, 'utf8')) as UpsFile;
  } catch {
    return null;
  }
}

const seed = await readFile(join(root, 'data', 'seed.txt'), 'utf8');
const titles = [...new Set(
  seed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.length <= 120),
)];

const existing = await readExisting();
const scannedBefore = new Set(FULL ? [] : (existing?.scanned ?? []));
const fresh = titles.filter((t) => !scannedBefore.has(t));
const targets = (LIMIT > 0 ? fresh.slice(0, LIMIT) : fresh);

console.log(
  `题库 ${titles.length} 条，模式 ${FULL ? 'full（全量重建）' : 'incremental（增量合并）'}，本次搜 ${targets.length} 条`,
);

const entries = prepareHot(targets);
const searcher = await createSearcher({ intervalMs: 1200 });

/** mid -> { name, total, hits, samples } */
const stats = new Map<number, { name: string; total: number; hits: number; samples: string[] }>();

let done = 0;
for (const entry of entries) {
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
  if (done % 20 === 0 || done === entries.length) process.stdout.write(`  ${done}/${entries.length}\r`);
}

const discovered = [...stats.entries()]
  .filter(([, s]) => qualifies(s.hits, s.total))
  .map(([mid, s]) => ({
    mid,
    name: s.name,
    hits: s.hits,
    total: s.total,
    rate: Math.round((s.hits / s.total) * 100) / 100,
    samples: s.samples,
  }));

// 增量：把本轮结果累加进已有条目；全量：直接重建
let merged = discovered;

// 保护：一条结果都没拿到，多半是 B 站限流/接口变更，不是「真的没人搬」。
// 这时候不要把已有库清空，保留上一版等下次跑。
if (stats.size === 0 && existing?.entries.length) {
  console.warn('⚠️ 本轮没有拿到任何搜索结果，保留原有 UP 库不覆盖');
  process.exit(0);
}

// 同样的道理：全量重建时若结果明显少于现有库，说明这一轮没扫全，
// 直接重建等于把已验证的条目删掉。改成合并，宁多勿少。
const degraded =
  FULL &&
  !!existing?.entries.length &&
  discovered.length < existing.entries.length * 0.6;
if (degraded) {
  console.warn(
    `⚠️ 全量只发现 ${discovered.length} 个，明显少于现有 ${existing!.entries.length} 个，本轮改为合并而不是重建`,
  );
}

if ((!FULL || degraded) && existing) {
  const byMid = new Map(existing.entries.map((e) => [e.mid, { ...e }]));
  for (const add of discovered) {
    const prev = byMid.get(add.mid);
    if (!prev) {
      byMid.set(add.mid, add);
      continue;
    }
    const hits = (prev.hits ?? 0) + add.hits;
    const total = (prev.total ?? 0) + add.total;
    byMid.set(add.mid, {
      mid: add.mid,
      name: add.name || prev.name,
      hits,
      total,
      rate: Math.round((hits / total) * 100) / 100,
      samples: [...new Set([...(prev.samples ?? []), ...add.samples])].slice(0, 3),
    });
  }
  merged = [...byMid.values()].sort((a, b) => b.hits - a.hits || b.rate - a.rate);
}

const scanned = [...new Set([...scannedBefore, ...targets])].slice(-SCANNED_MAX);

const upsFile: UpsFile = {
  generatedAt: new Date().toISOString(),
  threshold: MATCHER.threshold,
  mode: FULL ? 'full' : 'incremental',
  scanned,
  entries: merged,
};

await mkdir(join(root, 'reports'), { recursive: true });
await writeFile(UPS_PATH, `${JSON.stringify(upsFile, null, 2)}\n`, 'utf8');

console.log(`\n本轮扫描 ${stats.size} 个 UP，入选 ${discovered.length} 个；合并后库里共 ${merged.length} 个`);
for (const u of merged.slice(0, 10)) {
  console.log(`  ${String(u.hits).padStart(3)}/${String(u.total).padStart(3)}  ${u.name}（${u.mid}）  ${u.samples[0] ?? ''}`);
}
console.log(`\n写入 ups.json（已扫描 ${scanned.length}/${titles.length} 条标题）`);
