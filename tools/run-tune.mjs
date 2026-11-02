import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 打包 tools/tune.ts 并执行（与 run-audit 同一套路） */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'tools', 'tune.mjs');

function esbuildBinary() {
  const candidates = [
    join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    join(root, 'node_modules', '@esbuild', 'win32-arm64', 'esbuild.exe'),
    join(root, 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild'),
    join(root, 'node_modules', '@esbuild', 'linux-x64', 'bin', 'esbuild'),
  ];
  const bin = candidates.find((p) => existsSync(p));
  if (!bin) throw new Error('找不到 esbuild 二进制，请先 npm install');
  return bin;
}

await mkdir(dirname(out), { recursive: true });
execFileSync(esbuildBinary(), [
  join(root, 'tools', 'tune.ts'),
  '--bundle',
  '--format=esm',
  '--platform=node',
  '--target=node22',
  '--charset=utf8',
  '--log-level=warning',
  `--outfile=${out}`,
], { stdio: 'inherit' });

await import(`file://${out.replace(/\\/g, '/')}?t=${Date.now()}`);
