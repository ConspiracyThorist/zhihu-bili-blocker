/**
 * 用户投稿接收端（Cloudflare Worker + KV）。
 *
 * 扩展只做一件事：POST { mid, name }。这里不判断对错，只排队。
 * 校验交给 CI（.github/workflows/up-review.yml）——复用和自动发现同一套
 * matchTitle + 双门槛，达标才进 ups.json。
 *
 * 路由：
 *   POST   /submit        入队（公开，带频率限制）
 *   GET    /pending       列出队列（CI 用，需 token）
 *   DELETE /pending/:mid  处理后出队（CI 用，需 token）
 *
 * 环境变量：
 *   SUBMIT_TOKEN  CI 拉取/删除用的口令
 *   RATE_LIMIT    每个 IP 每天最多提交数（默认 20）
 */

interface Env {
  UPS_QUEUE: KVNamespace;
  SUBMIT_TOKEN: string;
  RATE_LIMIT?: string;
}

interface PendingUp {
  mid: number;
  name: string;
  firstAt: number;
  lastAt: number;
  hits: number;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

/** 队列最多容纳多少条待审核，防止被刷爆存储 */
const QUEUE_MAX = 2000;

/** 定长比较，避免用 !== 泄露前缀匹配长度 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 只接受看起来像 B 站 mid 的正数，挡掉明显的垃圾请求 */
function validMid(value: unknown): number | null {
  const mid = Number(value);
  if (!Number.isFinite(mid) || !Number.isInteger(mid)) return null;
  if (mid < 1000 || mid > 9_007_199_254_740_991) return null;
  return mid;
}

async function submit(request: Request, env: Env): Promise<Response> {
  let body: { mid?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad json' }, 400);
  }

  const mid = validMid(body.mid);
  if (mid === null) return json({ ok: false, error: 'bad mid' }, 400);

  // 频率限制：同一个 IP 每天有限额，防止有人刷队列
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const limit = Number(env.RATE_LIMIT ?? '20');
  const globalLimit = Number(env.GLOBAL_RATE_LIMIT ?? '3000');

  // 全局限额先挡一刀：IP 可以伪造，总量伪造不了
  const totalKey = `rate-total:${dayKey()}`;
  const totalUsed = Number((await env.UPS_QUEUE.get(totalKey)) ?? '0');
  if (totalUsed >= globalLimit) return json({ ok: false, error: 'daily quota exhausted' }, 503);

  const rateKey = `rate:${dayKey()}:${ip}`;
  const used = Number((await env.UPS_QUEUE.get(rateKey)) ?? '0');
  if (used >= limit) return json({ ok: false, error: 'rate limited' }, 429);
  await env.UPS_QUEUE.put(rateKey, String(used + 1), { expirationTtl: 172800 });
  await env.UPS_QUEUE.put(totalKey, String(totalUsed + 1), { expirationTtl: 172800 });

  const key = `pending:${mid}`;
  const prev = (await env.UPS_QUEUE.get(key, 'json')) as PendingUp | null;

  // 新条目才占额度，重复提交不额外增长
  if (!prev) {
    const keys = await env.UPS_QUEUE.list({ prefix: 'pending:', limit: QUEUE_MAX });
    if (keys.keys.length >= QUEUE_MAX) return json({ ok: false, error: 'queue full' }, 503);
  }
  const now = Date.now();
  const entry: PendingUp = prev
    ? { ...prev, lastAt: now, hits: prev.hits + 1, name: String(body.name ?? prev.name).slice(0, 40) }
    : { mid, name: String(body.name ?? '').slice(0, 40), firstAt: now, lastAt: now, hits: 1 };

  // 60 天后自动清理，避免队列无限增长
  await env.UPS_QUEUE.put(key, JSON.stringify(entry), { expirationTtl: 60 * 24 * 3600 });
  return json({ ok: true });
}

async function pending(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  if (!safeEqual(auth, `Bearer ${env.SUBMIT_TOKEN}`)) return json({ ok: false, error: 'unauthorized' }, 401);

  const list = await env.UPS_QUEUE.list({ prefix: 'pending:', limit: 200 });
  const items: PendingUp[] = [];
  for (const key of list.keys) {
    const value = (await env.UPS_QUEUE.get(key.name, 'json')) as PendingUp | null;
    if (value) items.push(value);
  }
  items.sort((a, b) => b.hits - a.hits);
  return json({ ok: true, items });
}

async function remove(mid: string, request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  if (!safeEqual(auth, `Bearer ${env.SUBMIT_TOKEN}`)) return json({ ok: false, error: 'unauthorized' }, 401);
  const parsed = validMid(mid);
  if (parsed === null) return json({ ok: false, error: 'bad mid' }, 400);
  await env.UPS_QUEUE.delete(`pending:${parsed}`);
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === '/submit' && request.method === 'POST') return submit(request, env);
    if (url.pathname === '/pending' && request.method === 'GET') return pending(request, env);
    if (url.pathname.startsWith('/pending/') && request.method === 'DELETE') {
      return remove(url.pathname.slice('/pending/'.length), request, env);
    }
    return json({ ok: false, error: 'not found' }, 404);
  },
};
