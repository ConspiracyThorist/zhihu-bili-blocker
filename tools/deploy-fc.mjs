/**
 * 部署国内投稿函数（阿里云 FC 3.0 + OSS），全程走 API，不需要控制台点。
 *
 * 做四件事：
 *   1. 读 AK，拿到账号 ID
 *   2. 建 OSS Bucket（队列文件存这里）
 *   3. 打包并上传 FC 函数（nodejs20，依赖零个）
 *   4. 建 HTTP 触发器，打印公网地址
 *
 * 用法：node tools/deploy-fc.mjs [--dry-run]
 */
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createZip } from './lib/zip.mjs';
import { callAcs3, ensureBucket, readCredentials, whoami } from './aliyun.mjs';

const REGION = process.env.FC_REGION ?? 'cn-hangzhou';
const FUNCTION_NAME = 'zbb-ups';
const DRY = process.argv.includes('--dry-run');
const RESULT_PATH = 'server/aliyun/deploy-result.json';

const cred = await readCredentials();
const accountId = await whoami(cred);
console.log(`✓ 账号 ${accountId}，Region ${REGION}`);

const bucket = `zbb-ups-${accountId}`.toLowerCase();
let secret = '';
try {
  secret = (JSON.parse(await readFile(RESULT_PATH, 'utf8')).token ?? '').trim();
} catch {
  secret = '';
}
if (!secret) secret = randomBytes(32).toString('hex');

if (DRY) {
  console.log(`--dry-run：将使用 Bucket ${bucket}、函数 ${FUNCTION_NAME}`);
  process.exit(0);
}

// ---- 1. Bucket ----
const bucketState = await ensureBucket({ ...cred, region: `oss-${REGION}`, bucket });
console.log(`✓ OSS Bucket ${bucket}（${bucketState}）`);

// ---- 2. 打包 ----
function esbuildBinary() {
  const candidates = [
    'node_modules/@esbuild/win32-x64/esbuild.exe',
    'node_modules/@esbuild/win32-arm64/esbuild.exe',
    'node_modules/@esbuild/darwin-arm64/bin/esbuild',
    'node_modules/@esbuild/linux-x64/bin/esbuild',
  ];
  const bin = candidates.find((p) => existsSync(p));
  if (!bin) throw new Error('找不到 esbuild 二进制，请先 npm install');
  return bin;
}

await mkdir('dist/server-aliyun', { recursive: true });
execFileSync(esbuildBinary(), [
  'server/aliyun/src/index.ts',
  '--bundle', '--platform=node', '--target=node20', '--format=cjs',
  '--charset=utf8', '--log-level=warning',
  '--outfile=dist/server-aliyun/index.js',
], { stdio: 'inherit' });
console.log('✓ 编译 server/aliyun/src/index.ts');

const stage = 'dist/fc-stage';
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await writeFile(join(stage, 'index.js'), await readFile('dist/server-aliyun/index.js'));
const zipPath = 'dist/fc-stage.zip';
const { size } = await createZip(stage, zipPath);
const zipFile = (await readFile(zipPath)).toString('base64');
console.log(`✓ 打包 ${(size / 1024).toFixed(1)} KB`);

// ---- 3. 创建函数 ----
const env = {
  OSS_REGION: `oss-${REGION}`,
  OSS_BUCKET: bucket,
  OSS_AK: cred.ak,
  OSS_SK: cred.sk,
  SUBMIT_TOKEN: secret,
  RATE_LIMIT: process.env.RATE_LIMIT ?? '20',
  HOURLY_LIMIT: process.env.HOURLY_LIMIT ?? '500',
};

const created = await callAcs3({
  method: 'POST',
  host: `${accountId}.${REGION}.fc.aliyuncs.com`,
  path: '/2023-03-30/functions',
  query: {},
  action: 'CreateFunction',
  version: '2023-03-30',
  ak: cred.ak,
  sk: cred.sk,
  body: JSON.stringify({
    functionName: FUNCTION_NAME,
    runtime: 'nodejs20',
    handler: 'index.handler',
    code: { zipFile },
    memorySize: 128,
    timeout: 30,
    instanceConcurrency: 20,
    internetAccess: true,
    environmentVariables: env,
    description: '知乎热榜屏蔽：UP 库投稿接收端',
  }),
});
console.log('CreateFunction:', created.status, JSON.stringify(created.body).slice(0, 300));

// 已存在则更新代码
if (created.status === 409 || created.body?.code === 'FunctionAlreadyExists') {
  const updated = await callAcs3({
    method: 'PUT',
    host: `${accountId}.${REGION}.fc.aliyuncs.com`,
    path: `/2023-03-30/functions/${FUNCTION_NAME}`,
    query: {},
    action: 'UpdateFunction',
    version: '2023-03-30',
    ak: cred.ak,
    sk: cred.sk,
    body: JSON.stringify({
      runtime: 'nodejs20',
      handler: 'index.handler',
      code: { zipFile },
      memorySize: 128,
      timeout: 30,
      internetAccess: true,
      environmentVariables: env,
    }),
  });
  console.log('UpdateFunction:', updated.status, JSON.stringify(updated.body).slice(0, 200));
}

// ---- 4. HTTP 触发器 ----
const trigger = await callAcs3({
  method: 'POST',
  host: `${accountId}.${REGION}.fc.aliyuncs.com`,
  path: `/2023-03-30/functions/${FUNCTION_NAME}/triggers`,
  query: {},
  action: 'CreateTrigger',
  version: '2023-03-30',
  ak: cred.ak,
  sk: cred.sk,
  body: JSON.stringify({
    triggerName: 'http',
    triggerType: 'http',
    triggerConfig: JSON.stringify({
      authType: 'anonymous',
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    }),
  }),
});
console.log('CreateTrigger:', trigger.status, JSON.stringify(trigger.body).slice(0, 400));

// ---- 5. 取 URL ----
const got = await callAcs3({
  method: 'GET',
  host: `${accountId}.${REGION}.fc.aliyuncs.com`,
  path: `/2023-03-30/functions/${FUNCTION_NAME}/triggers/http`,
  query: {},
  action: 'GetTrigger',
  version: '2023-03-30',
  ak: cred.ak,
  sk: cred.sk,
});

const config = got.body?.triggerConfig
  ? (typeof got.body.triggerConfig === 'string' ? JSON.parse(got.body.triggerConfig) : got.body.triggerConfig)
  : {};
const url = got.body?.httpTrigger?.urlInternet ?? config.urlInternet ?? '';

await mkdir('server/aliyun', { recursive: true });
await writeFile(
  RESULT_PATH,
  `${JSON.stringify({ endpoint: url, token: secret, accountId, bucket, region: REGION, deployedAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);

console.log('\n===== 部署完成 =====');
console.log('接口地址：', url || '（没取到，需要去控制台看触发器 URL）');
console.log('CI 口令：', secret);
console.log(`已写入 ${RESULT_PATH}（已排除出仓库同步）`);
