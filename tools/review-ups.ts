/**
 * 审核用户投稿：从 Worker 队列取 mid，拉该 UP 的投稿，
 * 用和自动发现同一套 matchTitle + 双门槛判定，达标才并入 ups.json。
 *
 * 判定口径：
 *   命中率 = 与题库匹配（≥「标准」档 0.78）的视频数 / 该 UP 最近投稿数
 *   入选：命中 ≥2 且命中率 ≥30%
 *
 * 环境变量：
 *   UPS_ENDPOINT   Worker 地址
 *   UPS_TOKEN      CI 拉队列用的口令
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSearcher } from './bili-search.mjs';
import { matchTitle, prepareHot } from '../src/core/engine';
import { qualifies } from '../src/core/ups';
import { DEFAULT_SETTINGS, MODES, type Settings } from '../src/core/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPS_PATH = join(root, 'ups.json');
const ENDPOINT = (process.env.UPS_ENDPOINT ?? '').trim().replace(/\/$/, '');
const TOKEN = (process.env.UPS_TOKEN ?? '').trim();
const STANDARD = MODES.find((m) => m.id === 'standard')!;
const MATCHER: Settings = { ...DEFAULT_SETTINGS, threshold: STANDARD.threshold };

if (!ENDPOINT || !TOKEN) {
  console.log('没有配置 UPS_ENDPOINT / UPS_TOKEN，跳过');
  process.exit(0);
}

interface PendingUp {
  mid: number;
  name: string;
  firstAt: number;
  lastAt: number;
  hits: number;
}

interface UpsEntry {
  mid: number;
  name: string;
  hits?: number;
  total?: number;
  rate?: number;
  samples?: string[];
  source?: string;
}

interface UpsFile {
  generatedAt: string;
  threshold: number;
  mode?: 'full' | 'incremental';
  scanned?: string[];
  entries: UpsEntry[];
}

const auth = { authorization: `Bearer ${TOKEN}` };

async function fetchPending(): Promise<PendingUp[]> {
  const res = await fetch(`${ENDPOINT}/pending`, { headers: auth });
  if (!res.ok) throw new Error(`拉取队列失败：HTTP ${res.status}`);
  const json = (await res.json()) as { items?: PendingUp[] };
  return json.items ?? [];
}

async function dropPending(mid: number): Promise<void> {
  await fetch(`${ENDPOINT}/pending/${mid}`, { method: 'DELETE', headers: auth });
}

const seed = await readFile(join(root, 'seed.txt'), 'utf8');
const titles = seed
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && l.length <= 120);
const pool = prepareHot(titles);

const pending = await fetchPending();
console.log(`待审核 ${pending.length} 个 UP，题库 ${pool.length} 条`);

const searcher = await createSearcher({ intervalMs: 1200 });
const accepted: UpsEntry[] = [];
const rejected: { mid: number; name: string; why: string }[] = [];

for (const item of pending) {
  const res = await searcher.userVideos(item.mid, 50);
  if (!res.ok || res.items.length === 0) {
    // 接口失败不删队列，下次再试
    rejected.push({ mid: item.mid, name: item.name, why: `拿不到作品列表（code=${res.code}）` });
    continue;
  }

  let hits = 0;
  const samples: string[] = [];
  for (const video of res.items) {
    const m = matchTitle(video.title, pool, MATCHER);
    if (!m.hit) continue;
    hits += 1;
    if (samples.length < 3) samples.push(video.title.slice(0, 50));
  }
  const total = res.items.length;

  if (!qualifies(hits, total)) {
    rejected.push({ mid: item.mid, name: item.name, why: `${hits}/${total} 未达门槛` });
    await dropPending(item.mid);
    continue;
  }

  accepted.push({
    mid: item.mid,
    name: item.name || `UP ${item.mid}`,
    hits,
    total,
    rate: Math.round((hits / total) * 100) / 100,
    samples,
    source: 'auto',
  });
  await dropPending(item.mid);
  console.log(`  ✓ ${item.name}（${item.mid}）${hits}/${total}`);
}

for (const r of rejected) console.log(`  ✗ ${r.name}（${r.mid}）${r.why}`);

if (accepted.length === 0) {
  console.log('本轮没有新 UP 入选，ups.json 不变');
  process.exit(0);
}

// 合并：同 mid 以新统计为准，其余保留
let file: UpsFile;
try {
  file = JSON.parse(await readFile(UPS_PATH, 'utf8')) as UpsFile;
} catch {
  file = { generatedAt: new Date().toISOString(), threshold: MATCHER.threshold, entries: [] };
}

const byMid = new Map(file.entries.map((e) => [e.mid, e]));
for (const add of accepted) {
  const prev = byMid.get(add.mid);
  byMid.set(add.mid, prev ? { ...add, name: add.name || prev.name } : add);
}
file.entries = [...byMid.values()].sort(
  (a, b) => (b.hits ?? 0) - (a.hits ?? 0) || (b.rate ?? 0) - (a.rate ?? 0),
);
file.generatedAt = new Date().toISOString();

await mkdir(join(root, 'reports'), { recursive: true });
await writeFile(UPS_PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
console.log(`\n并入 ${accepted.length} 个，公共库现有 ${file.entries.length} 个`);
