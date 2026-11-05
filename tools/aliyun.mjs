/**
 * 阿里云部署工具：调用 ACS3 签名接口（FC 3.0 / STS），以及 OSS V1 签名。
 *
 * 只做本项目需要的几个动作：
 *   whoami()          读账号 ID
 *   ensureBucket()    建 OSS Bucket（已存在就跳过）
 *   deployFunction()  上传 FC 函数（zip 内含 index.js）
 *   createHttpTrigger() 建 HTTP 触发器
 *
 * AK/SK 从 D:\test\.aliyun-ak 读（两行），或环境变量 ALIYUN_AK / ALIYUN_SK。
 */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function readCredentials() {
  const ak = (process.env.ALIYUN_AK ?? '').trim();
  const sk = (process.env.ALIYUN_SK ?? '').trim();
  if (ak && sk) return { ak, sk };
  const raw = await readFile('D:\\test\\.aliyun-ak', 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('.aliyun-ak 需要两行：AccessKeyId / AccessKeySecret');
  return { ak: lines[0], sk: lines[1] };
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding);
}

/**
 * ACS3-HMAC256 签名（阿里云 2023 之后的新接口都用这个）。
 * 文档：https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
 */
export function acs3({ method, host, path, query = {}, body = '', action, version, ak, sk }) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const contentHash = sha256Hex(payload);
  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = createHash('md5').update(`${date}${Math.random()}`).digest('hex');

  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-version': version,
    'x-acs-date': date,
    'x-acs-signature-nonce': nonce,
    'x-acs-content-sha256': contentHash,
    'content-type': 'application/json; charset=utf-8',
  };

  const signedKeys = Object.keys(headers).sort();
  const canonicalHeaders = `${signedKeys.map((k) => `${k}:${String(headers[k]).trim()}`).join('\n')}\n`;
  const signedHeaders = signedKeys.join(';');

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k]))}`)
    .join('&');

  const canonicalRequest = [
    method.toUpperCase(),
    path || '/',
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    contentHash,
  ].join('\n');

  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = hmac(sk, stringToSign, 'hex');
  const authorization =
    `ACS3-HMAC-SHA256 Credential=${ak},SignedHeaders=${signedHeaders},Signature=${signature}`;

  return { headers: { ...headers, authorization }, payload };
}

/** 发一个 ACS3 签名的请求，返回 { status, body } */
export async function callAcs3(opts) {
  const { host, path, query } = opts;
  const { headers, payload } = acs3(opts);
  const qs = Object.keys(query ?? {}).length
    ? `?${Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`
    : '';
  const res = await fetch(`https://${host}${path}${qs}`, {
    method: opts.method,
    headers,
    body: opts.method === 'GET' ? undefined : payload,
    signal: AbortSignal.timeout(40000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** 读当前 AK 对应的账号 ID */
export async function whoami(cred) {
  const res = await callAcs3({
    method: 'POST',
    host: 'sts.aliyuncs.com',
    path: '/',
    query: { Action: 'GetCallerIdentity', Version: '2015-04-01', Format: 'JSON' },
    body: '',
    action: 'GetCallerIdentity',
    version: '2015-04-01',
    ...cred,
  });
  if (res.status !== 200) {
    throw new Error(`STS GetCallerIdentity 失败：${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  return res.body.AccountId;
}

/** OSS V1 签名：VERB\n\nContent-Type\nDate\n/{bucket}/{key} */
function ossAuth({ ak, sk, method, bucket, key = '', contentType = '' }) {
  const date = new Date().toUTCString();
  const stringToSign = `${method}\n\n${contentType}\n${date}\n/${bucket}/${key}`;
  const signature = createHmac('sha1', sk).update(stringToSign).digest('base64');
  return { date, authorization: `OSS ${ak}:${signature}` };
}

/** 建 Bucket；已存在（409）也算成功 */
export async function ensureBucket({ ak, sk, region, bucket }) {
  const host = `${bucket}.${region}.aliyuncs.com`;
  const auth = ossAuth({ ak, sk, method: 'PUT', bucket });
  const res = await fetch(`https://${host}/`, {
    method: 'PUT',
    headers: { date: auth.date, authorization: auth.authorization },
  });
  if (res.ok) return 'created';
  const text = await res.text();
  if (res.status === 409 || text.includes('BucketAlreadyExists')) return 'exists';
  throw new Error(`建 Bucket 失败：${res.status} ${text.slice(0, 200)}`);
}
