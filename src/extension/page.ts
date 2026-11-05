import { prepareHot, type HotEntry } from '../core/engine';
import { installFeedHook } from '../core/hook';
import { DEFAULT_SETTINGS, type Settings } from '../core/types';

/**
 * MAIN world：这里能拿到页面自己的 window.fetch，拦截必须在这一层做。
 * 注意本文件拿不到 chrome.storage，热榜列表由 content.js 通过 postMessage 送进来。
 */
const state: { settings: Settings; hot: HotEntry[]; blockedUps: Set<number> } = {
  settings: { ...DEFAULT_SETTINGS },
  hot: [],
  blockedUps: new Set(),
};

let resolveReady: (() => void) | undefined;
let settled = false;
const ready = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

function settle(): void {
  if (settled) return;
  settled = true;
  debug.settled += 1;
  window.clearTimeout(timeout);
  resolveReady?.();
}

// 兜底：等不到列表就放行——宁可漏，也不能让首页卡住
const timeout = window.setTimeout(settle, 1500);

const debug = { total: 0, sourceMismatch: 0, sourceNull: 0, badNs: 0, accepted: 0, hotLen: 0, feedSeen: 0, settled: 0 };
(window as unknown as Record<string, unknown>).__zbbDebug = debug;

window.addEventListener('message', (event: MessageEvent) => {
  debug.total += 1;
  if (event.source === null) debug.sourceNull += 1;
  if (event.source !== window) {
    debug.sourceMismatch += 1;
    return;
  }
  const data = event.data as { __zbb?: string; type?: string; payload?: Record<string, unknown> } | null;
  if (!data || data.__zbb !== 'ext' || data.type !== 'state') {
    debug.badNs += 1;
    return;
  }
  debug.accepted += 1;

  const payload = data.payload ?? {};
  state.settings = { ...DEFAULT_SETTINGS, ...(payload as Partial<Settings>) };
  const blocked = Array.isArray(payload.blockedUps) ? (payload.blockedUps as number[]) : [];
  state.blockedUps = new Set(blocked.filter((n) => Number.isFinite(n) && n > 0));
  const titles = Array.isArray(payload.titles) ? (payload.titles as string[]) : [];
  const staleTitles = Array.isArray(payload.staleTitles) ? (payload.staleTitles as string[]) : [];
  state.hot = [
    ...prepareHot(titles),
    // 老条目单独标记：engine 会给它们抬高分数线
    ...prepareHot(staleTitles).map((entry) => ({ ...entry, stale: true })),
  ];
  debug.hotLen = state.hot.length;

  // 关键：content 可能先回一个空列表（它还没读完 storage）。
  // 空列表不算"就绪"，否则 hook 会拿着空字典把首屏请求原样放行。
  if (state.hot.length > 0) settle();
});

installFeedHook({
  win: window,
  ready,
  getState: () => {
    debug.hotLen = state.hot.length;
    return state;
  },
  onHit: (biliTitle, result) => {
    try {
      window.postMessage(
        {
          __zbb: 'page',
          type: 'hit',
          payload: {
            biliTitle,
            zhihuTitle: result.zhihuTitle,
            score: result.score,
            reason: result.reason,
            layer: 'net',
            at: Date.now(),
          },
        },
        '*',
      );
    } catch {
      /* 记录失败不影响屏蔽 */
    }
  },
});

/**
 * 通知 content.js 送列表。
 * document_start 时对面可能还没挂好监听，所以多喊几次。
 */
function announce(): void {
  try {
    window.postMessage({ __zbb: 'page', type: 'ready' }, '*');
  } catch {
    /* 忽略 */
  }
}

announce();
document.addEventListener('DOMContentLoaded', announce, { once: true });
window.setTimeout(announce, 300);
window.setTimeout(announce, 1200);
