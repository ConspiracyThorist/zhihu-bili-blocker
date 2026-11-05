import { matchTitle, type HotEntry } from './engine';
import { pruneFeed } from './pruner';
import { isFeedUrl } from './urlFilter';
import type { MatchResult, Settings } from './types';

export interface HookState {
  settings: Settings;
  hot: HotEntry[];
  /** UP 库命中的 mid 集合（整号屏蔽） */
  blockedUps?: Set<number>;
}

/** 从 feed 卡片里取 UP 的 mid：B 站的字段是 owner.mid，个别接口放在顶层 */
function ownerMid(item: unknown): number {
  const node = item as { owner?: { mid?: unknown }; mid?: unknown } | null;
  const mid = Number(node?.owner?.mid ?? node?.mid);
  return Number.isFinite(mid) ? mid : 0;
}

export interface HookOptions {
  /** 页面 window（扩展是 window，油猴是 unsafeWindow） */
  win: Window;
  /** 热榜列表就绪的信号，最多等一小会儿，避免首屏来不及过滤 */
  ready: Promise<void>;
  getState: () => HookState;
  onHit: (biliTitle: string, result: MatchResult) => void;
  checkUrl?: (url: string) => boolean;
}

/**
 * 拦截层：在页面解析推荐 JSON 之前把命中项摘掉。
 * 这是主路径——做到这一步，卡片从头到尾不会出现，也就不存在"闪一下"。
 */
export function installFeedHook(opts: HookOptions): void {
  const { win, ready, getState, onHit } = opts;
  const check = opts.checkUrl ?? ((u: string) => isFeedUrl(u, win.location?.href));

  patchFetch(win, check, ready, getState, onHit);
  patchXhr(win, check, getState, onHit);
}

function patchFetch(
  win: Window,
  isFeed: (url: string) => boolean,
  ready: Promise<void>,
  getState: () => HookState,
  onHit: (biliTitle: string, result: MatchResult) => void,
): void {
  const nativeFetch = win.fetch;
  if (typeof nativeFetch !== 'function') return;

  const patched = function (this: unknown, ...args: unknown[]): Promise<Response> {
    const input = args[0];
    const pending = nativeFetch.apply(this as never, args as never) as Promise<Response>;

    let url = '';
    try {
      if (typeof input === 'string') url = input;
      else if (typeof Request !== 'undefined' && input instanceof Request) url = input.url;
      else url = String(input);
    } catch {
      url = '';
    }
    if (!url || !isFeed(url)) return pending;

    return pending
      .then(async (res) => {
        if (!res || !res.ok) return res;
        try {
          await ready;
        } catch {
          /* 列表没等到就不动它，宁可不屏蔽也不能白屏 */
        }
        const state = getState();
        if (!state.settings.enabled || state.hot.length === 0) return res;

        const contentType = res.headers.get('content-type') ?? '';
        if (contentType && !contentType.includes('json')) return res;

        const json: unknown = await res.clone().json();
        const removed = pruneFeed(json, {
          match: (title) => matchTitle(title, state.hot, state.settings),
          onHit,
          shouldDrop: (item) => {
            const ups = state.blockedUps;
            return !!ups && ups.size > 0 && ups.has(ownerMid(item));
          },
        });
        if (removed === 0) return res;

        const headers = new Headers(res.headers);
        headers.delete('content-encoding');
        headers.delete('content-length');
        return new Response(JSON.stringify(json), {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      })
      .catch(() => pending);
  };

  win.fetch = patched as typeof win.fetch;
}

function patchXhr(
  win: Window,
  isFeed: (url: string) => boolean,
  getState: () => HookState,
  onHit: (biliTitle: string, result: MatchResult) => void,
): void {
  const XHR = (win as Window & typeof globalThis).XMLHttpRequest;
  if (!XHR || !XHR.prototype) return;

  const nativeOpen = XHR.prototype.open as (...args: never[]) => void;
  const nativeSend = XHR.prototype.send;

  XHR.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    (this as { __zbbUrl?: string }).__zbbUrl = String(args[1]);
    return nativeOpen.apply(this, args as never[]);
  } as typeof XHR.prototype.open;

  XHR.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
    const self = this as XMLHttpRequest & { __zbbUrl?: string };
    const url = self.__zbbUrl ?? '';
    if (url && isFeed(url)) {
      self.addEventListener('load', () => {
        try {
          if (self.status < 200 || self.status >= 300) return;
          const state = getState();
          if (!state.settings.enabled || state.hot.length === 0) return;

          const raw: unknown =
            self.responseType === 'json' ? (self.response as unknown) : self.responseText;
          if (!raw) return;
          const json: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;

          const removed = pruneFeed(json, {
            match: (title) => matchTitle(title, state.hot, state.settings),
            onHit,
            shouldDrop: (item) => {
              const ups = state.blockedUps;
              return !!ups && ups.size > 0 && ups.has(ownerMid(item));
            },
          });
          if (removed === 0) return;

          const text = JSON.stringify(json);
          if (self.responseType === '' || self.responseType === 'text') {
            Object.defineProperty(self, 'responseText', { value: text, configurable: true });
          } else if (self.responseType === 'json') {
            Object.defineProperty(self, 'response', { value: json, configurable: true });
          }
        } catch {
          /* 任何异常都放弃这单，页面拿到原始响应 */
        }
      });
    }
    return nativeSend.apply(this, args as never);
  } as typeof XHR.prototype.send;
}
