import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 把 tools/audit.ts 打包成可执行脚本再跑（tools 不进 tsc 检查范围，只做打包） */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'tools', 'audit.mjs');

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
execFileSync(
  esbuildBinary(),
  [
    join(root, 'tools', 'audit.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node22',
    '--log-level=warning',
    `--outfile=${out}`,
  ],
  { stdio: 'inherit' },
);

await import(`file://${out.replace(/\\/g, '/')}?t=${Date.now()}`);
