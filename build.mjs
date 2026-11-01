import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './utils/zip.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const extDir = join(dist, 'extension');

const VERSION = '1.0.0';

const banner = `// ==UserScript==
// @name         知乎热榜屏蔽B站推荐
// @namespace    zhihu-bili-blocker
// @version      ${VERSION}
// @description  同步知乎热榜，标题模糊匹配后在渲染前屏蔽 B 站首页推荐里的搬运视频
// @author       zhihu-bili-blocker
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.zhihu.com
// @connect      www.zhihu.com
// @connect      gitee.com
// @connect      fastly.jsdelivr.net
// @connect      raw.githubusercontent.com
// @license      MIT
// @noframes
// ==/UserScript==
`;

/**
 * 直接用 esbuild 的 CLI 二进制，而不是 require('esbuild')。
 * JS API 靠 pipe 和子进程通信，某些受限环境（如被沙箱限制 spawn 的 DSH 会话）会 EPERM；
 * CLI 走继承 stdio，哪儿都能跑。
 */
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

function bundle(entry, outfile, extra = []) {
  execFileSync(
    esbuildBinary(),
    [
      entry,
      '--bundle',
      '--format=iife',
      '--target=chrome111',
      '--legal-comments=none',
      '--log-level=warning',
      `--outfile=${outfile}`,
      ...extra,
    ],
    { stdio: 'inherit' },
  );
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(extDir, { recursive: true });

  bundle(join(root, 'src/extension/background.ts'), join(extDir, 'background.js'));
  bundle(join(root, 'src/extension/content.ts'), join(extDir, 'content.js'));
  bundle(join(root, 'src/extension/page.ts'), join(extDir, 'page.js'));
  bundle(join(root, 'src/extension/popup.ts'), join(extDir, 'popup.js'));
  bundle(join(root, 'src/userscript/main.ts'), join(dist, 'zhihu-bili-blocker.user.js'), [
    `--banner:js=${banner}`,
  ]);

  await cp(join(root, 'manifest.json'), join(extDir, 'manifest.json'));
  await cp(join(root, 'src/extension/popup.html'), join(extDir, 'popup.html'));
  await cp(join(root, 'src/extension/popup.css'), join(extDir, 'popup.css'));
  await cp(join(root, 'assets/icons'), join(extDir, 'icons'), { recursive: true });

  const zip = await createZip(extDir, join(dist, 'zhihu-bili-blocker.zip'));
  const userJs = await stat(join(dist, 'zhihu-bili-blocker.user.js'));

  console.log('构建完成');
  console.log(`  扩展目录    dist/extension  (${zip.fileCount} 个文件)`);
  console.log(`  扩展压缩包  dist/zhihu-bili-blocker.zip  ${kb(zip.size)}`);
  console.log(`  油猴脚本    dist/zhihu-bili-blocker.user.js  ${kb(userJs.size)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
