import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'test');

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

await mkdir(outDir, { recursive: true });

async function bundleAndRun(entry, exportName) {
  const out = join(outDir, `${entry}.mjs`);
  execFileSync(
    esbuildBinary(),
    [
      join(root, 'tests', entry),
      '--bundle',
      '--format=esm',
      '--platform=node',
      '--target=node22',
      '--log-level=warning',
      // happy-dom 依赖 ws 的动态 require，交给 Node 运行时解析
      '--external:happy-dom',
      `--outfile=${out}`,
    ],
    { stdio: 'inherit' },
  );
  const mod = await import(pathToFileURL(out).href + `?t=${Date.now()}`);
  return mod[exportName]();
}

const results = [];
results.push(await bundleAndRun('all.test.ts', 'run'));
results.push(await bundleAndRun('widget.test.ts', 'runWidget'));

const passed = results.reduce((n, r) => n + r.passed, 0);
const failures = results.flatMap((r) => r.failures);

for (const failure of failures) console.error(`✗ ${failure}`);
console.log(
  `\n${failures.length === 0 ? '✓ 全部通过' : '✗ 有失败'}：${passed} 条断言，${failures.length} 条失败`,
);
process.exit(failures.length === 0 ? 0 : 1);
