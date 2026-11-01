/**
 * 判断一个 URL 是不是首页推荐 feed。
 *
 * 关键：只比对 pathname，绝不比对整串。
 * B 站 feed 走 wbi 签名，query 里每次都带新的 w_rid/wts，拿整串做匹配必然失效。
 * 另外也不改请求——只改响应，签名是不是我们的问题就无所谓了。
 */
const FEED_PATHS = [/\/feed\/rcmd\b/, /\/top\/feed\b/, /\/index\/top\/feed\b/, /\/wbi\/index\/top\/feed\b/];

const BILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com']);

export function isFeedUrl(input: string, base = 'https://www.bilibili.com/'): boolean {
  if (!input) return false;
  try {
    const url = new URL(input, base);
    const host = url.hostname.toLowerCase();
    if (!BILI_HOSTS.has(host) && !host.endsWith('.bilibili.com')) return false;
    return FEED_PATHS.some((re) => re.test(url.pathname));
  } catch {
    return false;
  }
}
