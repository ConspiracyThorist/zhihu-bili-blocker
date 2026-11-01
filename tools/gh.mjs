#!/usr/bin/env node
/**
 * GitHub 操作小工具：走 api.github.com（本机唯一稳定的 GitHub 通道）。
 *
 * 为什么不用 git：这台机器上 github.com:443 基本不通（TCP 超时），
 * SSH 又被沙箱挡在 sh.exe 建管道那一步。API 是唯一能长期用的路。
 *
 * 用法：
 *   node tools/gh.mjs whoami
 *   node tools/gh.mjs list [--repo owner/name]
 *   node tools/gh.mjs get <path>
 *   node tools/gh.mjs put <本地文件> [远端路径] [-m 提交信息]
 *   node tools/gh.mjs del <path> [-m 提交信息]
 *   node tools/gh.mjs runs            # 最近几次 Actions 运行
 *   node tools/gh.mjs run <workflow>  # 触发一次并等结果
 *
 * token 来源：环境变量 GITHUB_TOKEN，或 D:\test\.github-token
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const DEFAULT_REPO = 'ConspiracyThorist/zhihu-bili-blocker';
const API = 'https://api.github.com';

async function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  for (const p of ['D:\\test\\.github-token', 'D:\\test\\.github_token']) {
    try {
      return (await readFile(p, 'utf8')).trim();
    } catch {
      /* 继续找 */
    }
  }
  throw new Error('找不到 token：请设置 GITHUB_TOKEN，或写入 D:\\test\\.github-token');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const positional = [];
  const opts = {};
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--repo') opts.repo = args[++i];
    else if (a === '-m' || a === '--message') opts.message = args[++i];
    else positional.push(a);
  }
  return { command, positional, opts };
}

const { command, positional, opts } = parseArgs(process.argv);
const repo = opts.repo ?? DEFAULT_REPO;

let cachedToken = null;
async function ensureToken() {
  if (!cachedToken) cachedToken = await getToken();
  return cachedToken;
}

async function api(method, path, body, raw = false) {
  const token = await ensureToken();
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'zbb-gh-cli',
    'content-type': 'application/json',
  };
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  if (raw) return { status: res.status, res };
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

async function must(method, path, body) {
  const r = await api(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${r.json?.message ?? ''}`);
  return r.json;
}

async function fileSha(path) {
  const r = await api('GET', `/repos/${repo}/contents/${encodeURI(path)}`);
  return r.status === 200 ? r.json.sha : undefined;
}

const commands = {
  async whoami() {
    const me = await must('GET', '/user');
    console.log(`登录：${me.login}`);
    console.log(`仓库：${repo}`);
    return me.login;
  },

  async list() {
    const tree = await must('GET', `/repos/${repo}/git/trees/main?recursive=1`);
    for (const item of tree.tree.filter((t) => t.type === 'blob')) {
      console.log(`${String(item.size).padStart(8)}  ${item.path}`);
    }
  },

  async get() {
    const [path] = positional;
    if (!path) throw new Error('用法：get <path>');
    const data = await must('GET', `/repos/${repo}/contents/${encodeURI(path)}`);
    process.stdout.write(Buffer.from(data.content, 'base64').toString('utf8'));
    console.log();
  },

  async put() {
    const [local, remoteArg] = positional;
    if (!local) throw new Error('用法：put <本地文件> [远端路径]');
    const remote = remoteArg ?? basename(local);
    const content = await readFile(local, 'utf8');
    const sha = await fileSha(remote);
    const res = await api('PUT', `/repos/${repo}/contents/${encodeURI(remote)}`, {
      message: opts.message ?? `chore: update ${remote}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    });
    if (res.status >= 400) throw new Error(`上传失败：${res.status} ${res.json?.message ?? ''}`);
    console.log(`✓ 已更新 ${remote}（${content.split('\n').length} 行）`);
  },

  async del() {
    const [path] = positional;
    if (!path) throw new Error('用法：del <path>');
    const sha = await fileSha(path);
    if (!sha) throw new Error('文件不存在');
    const res = await api('DELETE', `/repos/${repo}/contents/${encodeURI(path)}`, {
      message: opts.message ?? `chore: delete ${path}`,
      sha,
    });
    if (res.status >= 400) throw new Error(`删除失败：${res.status} ${res.json?.message ?? ''}`);
    console.log(`✓ 已删除 ${path}`);
  },

  async runs() {
    const data = await must('GET', `/repos/${repo}/actions/runs?per_page=5`);
    for (const r of data.workflow_runs) {
      console.log(`${r.conclusion ?? r.status}\t${r.name}\t${r.created_at}\t${r.html_url}`);
    }
  },

  async run() {
    const [workflow] = positional;
    if (!workflow) throw new Error('用法：run <workflow 文件名或 ID>');
    const res = await api('POST', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, { ref: 'main' });
    if (res.status >= 400) throw new Error(`触发失败：${res.status} ${res.json?.message ?? ''}`);
    console.log('已触发，等待结果…');
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      const data = await must('GET', `/repos/${repo}/actions/runs?per_page=1`);
      const latest = data.workflow_runs[0];
      if (!latest) continue;
      if (latest.status === 'completed') {
        console.log(`结果：${latest.conclusion}  ${latest.html_url}`);
        return latest.conclusion;
      }
    }
    console.log('等待超时，结果未知');
  },
};

if (!commands[command]) {
  console.log('用法：node tools/gh.mjs <whoami|list|get|put|del|runs|run> [参数]');
  process.exit(1);
}

try {
  await commands[command]();
} catch (err) {
  console.error('✗', err.message);
  process.exit(1);
}
