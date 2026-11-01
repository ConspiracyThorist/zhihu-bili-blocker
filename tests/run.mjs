import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'test', 'all.test.mjs');

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
    join(root, 'tests', 'all.test.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node22',
    '--log-level=warning',
    `--outfile=${out}`,
  ],
  { stdio: 'inherit' },
);

const mod = await import(pathToFileURL(out).href + `?t=${Date.now()}`);
const { passed, failures } = await mod.run();

for (const failure of failures) console.error(`✗ ${failure}`);
console.log(
  `\n${failures.length === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 条断言，${failures.length} 条失败`,
);
process.exit(failures.length === 0 ? 0 : 1);
