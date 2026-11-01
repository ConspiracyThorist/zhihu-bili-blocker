#!/usr/bin/env node
/**
 * 把本地目录同步到 GitHub 仓库（走 API，因为本机 git 不通）。
 *
 * 只上传内容有变化的文件：先用 Git Trees API 拉远端 blob sha，
 * 再对本地文件算同样的 sha1("blob <len>\0"+内容)，不一致才 PUT。
 *
 * 用法：node tools/gh-sync.mjs <本地目录> [owner/repo] [--prune]
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', '.test-tmp', '.npm-cache', '.dsh-office']);
const EXCLUDE_FILES = new Set(['seed.meta.json', '.DS_Store', 'Thumbs.db']);

const args = process.argv.slice(2);
const localRoot = args[0];
const repo = args[1] ?? 'ConspiracyThorist/zhihu-bili-blocker';
const prune = args.includes('--prune');

if (!localRoot) {
  console.error('用法：node tools/gh-sync.mjs <本地目录> [owner/repo] [--prune]');
  process.exit(1);
}

const token = (
  process.env.GITHUB_TOKEN ??
  (await readFile('D:\\test\\.github-token', 'utf8').catch(() => ''))
).trim();
if (!token) {
  console.error('找不到 token');
  process.exit(1);
}

const API = 'https://api.github.com';
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'zbb-sync',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

const blobSha = (buf) => {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(buf).digest('hex');
};

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const repoInfo = await api('GET', `/repos/${repo}`);
if (repoInfo.status !== 200) {
  console.error('仓库不可访问：', repo, repoInfo.json?.message ?? '');
  process.exit(1);
}
const branch = repoInfo.json.default_branch ?? 'main';

const tree = await api('GET', `/repos/${repo}/git/trees/${branch}?recursive=1`);
const remote = new Map();
for (const item of tree.json?.tree ?? []) {
  if (item.type === 'blob') remote.set(item.path, item.sha);
}

const files = await walk(localRoot);
console.log(`本地 ${files.length} 个文件，远端 ${remote.size} 个`);

let uploaded = 0;
let skipped = 0;
const failures = [];

for (const file of files) {
  const rel = relative(localRoot, file).split(sep).join('/');
  const buf = await readFile(file);
  const sha = blobSha(buf);
  if (remote.get(rel) === sha) {
    skipped += 1;
    continue;
  }
  const res = await api('PUT', `/repos/${repo}/contents/${encodeURI(rel)}`, {
    message: `chore: sync ${rel}`,
    content: buf.toString('base64'),
    ...(remote.get(rel) ? { sha: remote.get(rel) } : {}),
  });
  if (res.status === 200 || res.status === 201) {
    uploaded += 1;
    process.stdout.write(`  ↑ ${rel}\n`);
  } else {
    failures.push(`${rel}: ${res.status} ${res.json?.message ?? ''}`);
  }
}

if (prune) {
  const localSet = new Set(files.map((f) => relative(localRoot, f).split(sep).join('/')));
  for (const [path, sha] of remote) {
    if (localSet.has(path)) continue;
    if (path.startsWith('.github/')) continue; // 不碰 CI 配置
    const res = await api('DELETE', `/repos/${repo}/contents/${encodeURI(path)}`, {
      message: `chore: remove ${path}`,
      sha,
    });
    if (res.status === 200) {
      console.log(`  ✗ ${path}`);
      uploaded += 1;
    }
  }
}

console.log(`\n上传 ${uploaded}，跳过（未变化）${skipped}，失败 ${failures.length}`);
for (const f of failures) console.error('  ', f);
process.exit(failures.length ? 1 : 0);
