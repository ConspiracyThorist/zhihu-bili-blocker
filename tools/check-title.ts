/**
 * 单条标题诊断：给定一个 B 站标题，看它和当前题库的匹配情况。
 *
 * 用法：node tools/run-check.mjs "视频标题"
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bigramCoverage, diceCoefficient } from '../src/core/dice';
import { normalize } from '../src/core/normalize';
import { DEFAULT_SETTINGS, MODES } from '../src/core/types';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const seed = await readFile(join(root, 'data', 'seed.txt'), 'utf8');
const titles = seed
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('用法：node tools/run-check.mjs "视频标题"');
  process.exit(1);
}

const norm = normalize(query);
console.log(`输入：${query}`);
console.log(`归一：${norm}（${norm.length} 字）`);
console.log(`题库：${titles.length} 条`);
console.log('');

const scored = [];
for (const raw of titles) {
  const n = normalize(raw);
  if (!n) continue;
  const dice = diceCoefficient(norm, n);
  const cover = bigramCoverage(norm, n);
  scored.push({ raw, dice, cover, best: Math.max(dice, cover) });
}
scored.sort((a, b) => b.best - a.best);

console.log('最接近的 8 条：');
for (const s of scored.slice(0, 8)) {
  console.log(`  ${s.best.toFixed(3)}  dice=${s.dice.toFixed(3)} cover=${s.cover.toFixed(3)}  ${s.raw.slice(0, 40)}`);
}

console.log('\n各档位是否会拦：');
for (const mode of MODES) {
  const hit = scored.find((s) => s.best >= mode.threshold);
  console.log(
    `  ${mode.name.padEnd(2)}（≥${mode.threshold}）  ${hit ? '会拦 → ' + hit.raw.slice(0, 30) : '不拦'}`,
  );
}

const defaultMode = MODES.find((m) => Math.abs(m.threshold - DEFAULT_SETTINGS.threshold) < 0.005);
console.log(`\n当前默认档：${defaultMode?.name ?? '自定义'}（${DEFAULT_SETTINGS.threshold}）`);
