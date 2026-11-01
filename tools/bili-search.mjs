/**
 * B 站搜索客户端：wbi 签名 + buvid3 cookie + 限速。
 * 只用在离线工具里（题库体检），不进入扩展产物。
 */
import { createHash } from 'node:crypto';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

const md5 = (s) => createHash('md5').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyFromUrl = (u) => String(u).split('/').pop().split('.')[0];

function mixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

function sign(params, key) {
  const wts = Math.floor(Date.now() / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${md5(query + key)}`;
}

export function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

export async function createSearcher({ intervalMs = 1200 } = {}) {
  const jar = new Map();
  let mixin = '';
  let keyAt = 0;
  let lastCall = 0;
  let calls = 0;

  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  async function primeCookies() {
    const res = await fetch('https://www.bilibili.com/', {
      headers: { 'user-agent': UA, accept: 'text/html' },
      redirect: 'follow',
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
  }

  async function refreshKeys() {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader() },
    });
    const json = await res.json();
    const img = keyFromUrl(json?.data?.wbi_img?.img_url ?? '');
    const sub = keyFromUrl(json?.data?.wbi_img?.sub_url ?? '');
    if (!img || !sub) throw new Error('拿不到 wbi key');
    mixin = mixinKey(img, sub);
    keyAt = Date.now();
  }

  async function throttle() {
    const wait = intervalMs - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
  }

  async function rawSearch(keyword, page = 1) {
    await throttle();
    calls += 1;
    const params = { search_type: 'video', keyword, page, page_size: 20 };
    const res = await fetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${sign(params, mixin)}`, {
      headers: {
        'user-agent': UA,
        referer: 'https://search.bilibili.com/',
        cookie: cookieHeader(),
        accept: 'application/json',
      },
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async function search(keyword) {
    if (!mixin || Date.now() - keyAt > 15 * 60 * 1000) await refreshKeys();

    let out = await rawSearch(keyword);
    if (out.status === 412 || out.json?.code === -412) {
      await sleep(4000);
      await primeCookies();
      await refreshKeys();
      out = await rawSearch(keyword);
    }

    const result = out.json?.data?.result;
    if (!Array.isArray(result)) {
      return { ok: out.json?.code === 0, code: out.json?.code, total: 0, items: [] };
    }
    return {
      ok: out.json.code === 0,
      code: out.json.code,
      total: out.json.data?.numResults ?? result.length,
      items: result.map((r) => ({
        bvid: r.bvid,
        title: stripHtml(r.title),
        author: r.author,
        play: r.play,
        pubdate: r.pubdate,
      })),
    };
  }

  await primeCookies();
  await refreshKeys();

  return {
    search,
    get calls() {
      return calls;
    },
  };
}
