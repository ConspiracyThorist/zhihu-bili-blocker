/**
 * 一键部署投稿 Worker（不用本地装 wrangler）。
 *
 * 做四件事：
 *   1. 用 esbuild 把 worker/src/index.ts 打成单文件 ESM
 *   2. 找到（或创建）KV 命名空间 UPS_QUEUE
 *   3. 上传 Worker（模块格式），绑定 KV
 *   4. 生成并写入 SUBMIT_TOKEN 密钥，打印出来给 CI 用
 *
 * token 从 D:\test\.cf-token 或环境变量 CLOUDFLARE_API_TOKEN 读。
 * 需要的权限：Workers Scripts:Edit、Workers KV Storage:Edit、Account Settings:Read
 *
 * 用法：node tools/deploy-worker.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_NAME = 'zbb-ups';
const KV_TITLE = 'UPS_QUEUE';
const DRY = process.argv.includes('--dry-run');
const TOKEN_PATH = 'D:\\test\\.cf-token';

async function readToken() {
  const env = (process.env.CLOUDFLARE_API_TOKEN ?? '').trim();
  if (env) return env;
  try {
    return (await readFile(TOKEN_PATH, 'utf8')).trim();
  } catch {
    return '';
  }
}

const API = 'https://api.cloudflare.com/client/v4';
const authHeaders = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function call(method, path, body, init = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: init.headers ?? authHeaders(),
    body,
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const detail = (json.errors ?? []).map((e) => `${e.code}:${e.message}`).join('; ');
    throw new Error(`${method} ${path} → ${res.status} ${detail}`);
  }
  return json.result;
}

// ---- 1. 打包 ----
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

const outDir = join(root, 'dist', 'worker');
await mkdir(outDir, { recursive: true });
const bundlePath = join(outDir, 'index.js');
execFileSync(esbuildBinary(), [
  join(root, 'worker', 'src', 'index.ts'),
  '--bundle',
  '--format=esm',
  '--platform=neutral',
  '--target=es2022',
  '--charset=utf8',
  '--log-level=warning',
  `--outfile=${bundlePath}`,
], { stdio: 'inherit' });
console.log(`✓ 打包 ${bundlePath}`);

if (DRY) {
  console.log('--dry-run：到此为止，没有调用 Cloudflare API');
  process.exit(0);
}

const token = await readToken();
if (!token) {
  console.error(`缺少 API token：写入 ${TOKEN_PATH}，或设置 CLOUDFLARE_API_TOKEN`);
  process.exit(1);
}

// ---- 2. 账号 ----
const accounts = await call('GET', '/accounts');
const account = accounts?.[0];
if (!account) throw new Error('token 下没有可用的 Cloudflare 账号');
console.log(`✓ 账号 ${account.name}（${account.id}）`);

// ---- 3. KV ----
const existing = await call('GET', `/accounts/${account.id}/storage/kv/namespaces?per_page=50`);
let kv = (existing ?? []).find((n) => n.title === KV_TITLE);
if (kv) {
  console.log(`✓ 复用 KV 命名空间 ${KV_TITLE}（${kv.id}）`);
} else {
  kv = await call('POST', `/accounts/${account.id}/storage/kv/namespaces`, JSON.stringify({ title: KV_TITLE }));
  console.log(`✓ 创建 KV 命名空间 ${KV_TITLE}（${kv.id}）`);
}

// ---- 4. 上传 Worker ----
const code = await readFile(bundlePath);
const metadata = {
  main_module: 'index.js',
  compatibility_date: '2026-01-01',
  bindings: [{ type: 'kv_namespace', name: 'UPS_QUEUE', namespace_id: kv.id }],
};

const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
form.append('index.js', new Blob([code], { type: 'application/javascript+module' }), 'index.js');

await call('PUT', `/accounts/${account.id}/workers/scripts/${SCRIPT_NAME}`, form, {
  headers: { authorization: `Bearer ${token}` },
});
console.log(`✓ 上传 Worker ${SCRIPT_NAME}`);

// ---- 5. 密钥 ----
const secret = randomBytes(32).toString('hex');
await call(
  'PUT',
  `/accounts/${account.id}/workers/scripts/${SCRIPT_NAME}/secrets`,
  JSON.stringify({ name: 'SUBMIT_TOKEN', text: secret, type: 'secret_text' }),
);
console.log('✓ 写入密钥 SUBMIT_TOKEN');

// ---- 6. workers.dev 子域 ----
let subdomain = '';
try {
  const sub = await call('GET', `/accounts/${account.id}/workers/subdomain`);
  subdomain = sub?.subdomain ?? '';
} catch {
  subdomain = '';
}
if (!subdomain) {
  subdomain = `zbb-${account.id.slice(0, 6)}`;
  await call('PUT', `/accounts/${account.id}/workers/subdomain`, JSON.stringify({ subdomain }));
  console.log(`✓ 创建 workers.dev 子域 ${subdomain}`);
}

const endpoint = `https://${SCRIPT_NAME}.${subdomain}.workers.dev`;
const outFile = join(root, 'worker', 'deploy-result.json');
await writeFile(
  outFile,
  `${JSON.stringify({ endpoint, token: secret, accountId: account.id, kvId: kv.id, deployedAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);

console.log('\n===== 部署完成 =====');
console.log(`接口地址：${endpoint}`);
console.log(`CI 口令：${secret}`);
console.log(`已写入 ${outFile}（不要提交到仓库）`);
