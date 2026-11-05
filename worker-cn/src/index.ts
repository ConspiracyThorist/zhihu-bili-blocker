/**
 * 国内云函数版投稿接收端（阿里云函数计算 FC 3.0，Node.js 20）。
 *
 * 行为与 Cloudflare 版一致，只是存储换成 OSS 里的一个 JSON 文件。
 * 这里手写 OSS V1 签名，不依赖 ali-oss——那个包会 require 可选的 proxy-agent，
 * 打包不进去，而这点签名逻辑也就三十行。
 *
 * 路由（HTTP 触发器，路径即 event.path）：
 *   POST   /submit         入队（公开，按 IP 限速）
 *   GET    /pending        CI 拉队列（需 token）
 *   DELETE /pending/:mid   出队（需 token）
 *
 * 环境变量：
 *   OSS_REGION / OSS_BUCKET / OSS_AK / OSS_SK
 *   SUBMIT_TOKEN
 *   RATE_LIMIT（默认 20）
 */
import { createHmac } from 'node:crypto';

const QUEUE_KEY = 'zbb-ups/queue.json';
const RATE_PREFIX = 'zbb-ups/rate/';

interface PendingUp {
  mid: number;
  name: string;
  firstAt: number;
  lastAt: number;
  hits: number;
}

interface Queue {
  pending: Record<string, PendingUp>;
}

function bucketHost(): string {
  return `${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com`;
}

/** OSS V1 签名：VERB\n\nContent-Type\nDate\n/{bucket}/{key} */
function sign(verb: string, key: string, contentType: string, date: string): string {
  const resource = `/${process.env.OSS_BUCKET}/${key}`;
  const stringToSign = `${verb}\n\n${contentType}\n${date}\n${resource}`;
  return createHmac('sha1', process.env.OSS_SK!).update(stringToSign).digest('base64');
}

function authHeader(verb: string, key: string, contentType: string, date: string): string {
  return `OSS ${process.env.OSS_AK}:${sign(verb, key, contentType, date)}`;
}

async function getObject(key: string): Promise<string | null> {
  const date = new Date().toUTCString();
  const res = await fetch(`https://${bucketHost()}/${key}`, {
    headers: { date, authorization: authHeader('GET', key, '', date) },
  });
  if (!res.ok) return null;
  return res.text();
}

async function putObject(key: string, body: string): Promise<void> {
  const date = new Date().toUTCString();
  const contentType = 'application/json';
  const res = await fetch(`https://${bucketHost()}/${key}`, {
    method: 'PUT',
    headers: {
      date,
      'content-type': contentType,
      authorization: authHeader('PUT', key, contentType, date),
    },
    body,
  });
  if (!res.ok) throw new Error(`OSS PUT ${key} → ${res.status}`);
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const text = await getObject(key);
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await putObject(key, JSON.stringify(value));
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    },
    isBase64Encoded: false,
    body: JSON.stringify(body ?? {}),
  };
}

function validMid(value: unknown): number | null {
  const mid = Number(value);
  if (!Number.isInteger(mid) || mid < 1000 || mid > 9_007_199_254_740_991) return null;
  return mid;
}

function clientIp(headers: Record<string, string>): string {
  return (
    headers['x-forwarded-for']?.split(',')[0]?.trim() || headers['x-real-ip'] || 'unknown'
  );
}

async function handleSubmit(bodyText: string, headers: Record<string, string>) {
  let body: any;
  try {
    body = JSON.parse(bodyText || '{}');
  } catch {
    return json(400, { ok: false, error: 'bad json' });
  }

  const mid = validMid(body.mid);
  if (mid === null) return json(400, { ok: false, error: 'bad mid' });

  const limit = Number(process.env.RATE_LIMIT ?? '20');
  const rateKey = `${RATE_PREFIX}${new Date().toISOString().slice(0, 10)}/${clientIp(headers)}.json`;
  const used = (await readJson<{ n: number }>(rateKey, { n: 0 })).n;
  if (used >= limit) return json(429, { ok: false, error: 'rate limited' });
  await writeJson(rateKey, { n: used + 1 });

  const queue = await readJson<Queue>(QUEUE_KEY, { pending: {} });
  const now = Date.now();
  const prev = queue.pending[mid];
  queue.pending[mid] = prev
    ? { ...prev, lastAt: now, hits: prev.hits + 1, name: String(body.name ?? prev.name).slice(0, 40) }
    : { mid, name: String(body.name ?? '').slice(0, 40), firstAt: now, lastAt: now, hits: 1 };

  await writeJson(QUEUE_KEY, queue);
  return json(200, { ok: true });
}

/**
 * FC 3.0 的 HTTP 触发器会把**原始 HTTP 报文**塞进 event（Buffer），
 * 不是结构化对象——得自己切请求行、头部和 body。
 * 同时兼容结构化事件（v1: httpMethod/path，v2: requestContext.http）。
 */
function parseRawHttp(buf: Buffer): { method: string; path: string; headers: Record<string, string>; body: string } {
  const text = buf.toString('utf8');
  const split = text.indexOf('\r\n\r\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split + 4) : '';
  const lines = head.split('\r\n');
  const [requestLine = '', ...headerLines] = lines;
  const parts = requestLine.split(' ');
  const method = (parts[0] ?? 'GET').toUpperCase();
  const path = parts[1] ?? '/';

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { method, path, headers, body };
}

function normalize(event: any): { method: string; path: string; headers: Record<string, string>; body: string } {
  let e: any = event;

  // FC 3.0 实测给的是 JSON 字符串（{"VERSION":"V1","RAWPATH":...}）；
  // 少数配置下是裸 HTTP 报文，或已经是对象——三种都接住。
  if (Buffer.isBuffer(e)) e = e.toString('utf8');
  if (typeof e === 'string') {
    try {
      e = JSON.parse(e);
    } catch {
      return parseRawHttp(Buffer.from(e, 'utf8'));
    }
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(e?.headers ?? {})) headers[k.toLowerCase()] = String(v);

  let body = e?.body ?? '';
  if (e?.isBase64Encoded && body) body = Buffer.from(String(body), 'base64').toString('utf8');

  const method = String(e?.httpMethod ?? e?.requestContext?.http?.method ?? 'GET').toUpperCase();
  const path = e?.rawPath ?? e?.path ?? e?.requestContext?.http?.path ?? '/';
  return { method, path, headers, body: String(body) };
}

export const handler = async (rawEvent: any) => {
  const { method, path, headers, body: rawBody } = normalize(rawEvent);

  if (method === 'OPTIONS') return json(204, null);

  if (path === '/submit' && method === 'POST') return handleSubmit(rawBody, headers);

  const auth = headers.authorization ?? '';
  if (auth !== `Bearer ${process.env.SUBMIT_TOKEN}`) {
    if (path === '/pending' || path.startsWith('/pending/')) {
      return json(401, { ok: false, error: 'unauthorized' });
    }
  }

  if (path === '/pending' && method === 'GET') {
    const queue = await readJson<Queue>(QUEUE_KEY, { pending: {} });
    const items = Object.values(queue.pending).sort((a, b) => b.hits - a.hits);
    return json(200, { ok: true, items });
  }

  if (path.startsWith('/pending/') && method === 'DELETE') {
    const mid = validMid(path.slice('/pending/'.length));
    if (mid === null) return json(400, { ok: false, error: 'bad mid' });
    const queue = await readJson<Queue>(QUEUE_KEY, { pending: {} });
    delete queue.pending[mid];
    await writeJson(QUEUE_KEY, queue);
    return json(200, { ok: true });
  }

  return json(404, { ok: false, error: 'not found' });
};
