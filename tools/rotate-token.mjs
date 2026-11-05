/**
 * 轮换投稿端点的 CI 口令。
 *
 * 做两件事：
 *   1. Cloudflare Worker：写入新的 SUBMIT_TOKEN 密钥
 *   2. 阿里云函数：更新环境变量里的 SUBMIT_TOKEN
 *
 * 轮换后要把新的阿里云口令同步到 GitHub Secret（UPS_TOKEN），
 * 脚本会打印出来，也可直接用 tools/gh-secret.mjs 写入。
 *
 * 用法：node tools/rotate-token.mjs [cloudflare|aliyun|all]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { callAcs3 } from './aliyun.mjs';

const WHICH = (process.argv[2] ?? 'all').toLowerCase();
const CF_PATH = '.local/deploy-result.cloudflare.json';
const ALI_PATH = '.local/deploy-result.aliyun.json';
const newToken = () => randomBytes(32).toString('hex');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function rotateCloudflare() {
  const cf = await readJson(CF_PATH);
  const apiToken = (await readFile('.local/cloudflare-token', 'utf8')).trim();
  const secret = newToken();

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/workers/scripts/zbb-ups/secrets`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SUBMIT_TOKEN', text: secret, type: 'secret_text' }),
      signal: AbortSignal.timeout(30000),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    console.log('✗ Cloudflare 轮换失败：', res.status, JSON.stringify(json.errors ?? {}).slice(0, 200));
    return null;
  }
  await writeFile(CF_PATH, JSON.stringify({ ...cf, token: secret, rotatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  console.log(`✓ Cloudflare 口令已轮换（新口令前缀 ${secret.slice(0, 8)}…）`);
  return secret;
}

async function rotateAliyun() {
  const ali = await readJson(ALI_PATH);
  const credits = JSON.parse(await readFile('.local/aliyun-ak', 'utf8').then((raw) => {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return JSON.stringify({ ak: lines[0], sk: lines[1] });
  }));
  const secret = newToken();

  const res = await callAcs3({
    method: 'PUT',
    host: `${ali.accountId}.${ali.region}.fc.aliyuncs.com`,
    path: '/2023-03-30/functions/zbb-ups',
    query: {},
    action: 'UpdateFunction',
    version: '2023-03-30',
    ak: credits.ak,
    sk: credits.sk,
    body: JSON.stringify({
      environmentVariables: {
        OSS_REGION: `oss-${ali.region}`,
        OSS_BUCKET: ali.bucket,
        OSS_AK: credits.ak,
        OSS_SK: credits.sk,
        SUBMIT_TOKEN: secret,
        RATE_LIMIT: '20',
        HOURLY_LIMIT: '500',
      },
    }),
  });

  if (res.status !== 200) {
    console.log('✗ 阿里云轮换失败：', res.status, JSON.stringify(res.body).slice(0, 200));
    return null;
  }

  await writeFile(ALI_PATH, JSON.stringify({ ...ali, token: secret, rotatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  console.log(`✓ 阿里云口令已轮换（新口令前缀 ${secret.slice(0, 8)}…）`);

  // 旧口令应立刻失效
  const check = await fetch(`${ali.endpoint}/pending`, { headers: { authorization: `Bearer ${ali.token}` } });
  console.log(`  旧口令校验：HTTP ${check.status} ${check.status === 401 ? '（已失效 ✓）' : '（仍可用 ⚠️）'}`);

  return secret;
}

let aliToken = null;
if (WHICH === 'all' || WHICH === 'cloudflare') await rotateCloudflare();
if (WHICH === 'all' || WHICH === 'aliyun') aliToken = await rotateAliyun();

if (aliToken) {
  console.log(`\n新的阿里云口令（需同步到 GitHub Secret UPS_TOKEN）：\n${aliToken}`);
  console.log(`\n写入：node tools/gh-secret.mjs UPS_TOKEN=${aliToken}`);
}
