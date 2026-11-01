import { matchTitle, type HotEntry } from './engine';
import type { MatchResult, Settings } from './types';

/** 首页卡片可能出现的选择器，按覆盖广度排 */
export const CARD_SELECTORS = [
  '.bili-video-card',
  '.bili-video-card.is-rcmd',
  '.feed-card',
  'div[class*="bili-video-card"]',
  '.recommended-container .bili-video-card',
];

const TITLE_SELECTORS = ['.bili-video-card__info--tit', 'h3[class*="tit"]', 'a[title]'];

const STYLE_ID = 'zbb-style';

export interface ScannerOptions {
  settings: () => Settings;
  hot: () => HotEntry[];
  onHit: (biliTitle: string, result: MatchResult) => void;
}

export function extractTitle(card: Element): string {
  for (const sel of TITLE_SELECTORS) {
    const el = card.querySelector(sel);
    if (!el) continue;
    const text = (el.getAttribute('title') ?? el.textContent ?? '').trim();
    if (text) return text;
  }
  return '';
}

/**
 * 隐藏目标要选"最外层网格单元"，而不是卡片本身。
 * 只把卡片 display:none 的话，B 站的 masonry 列里会留下与卡片等高的空白洞。
 * 但也不能一路往上删——到了列容器（col_/container）就必须停，否则整列消失。
 */
export function hideCard(card: Element): void {
  let target: Element = card;
  for (let i = 0; i < 2; i += 1) {
    const parent = target.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    const cls = typeof parent.className === 'string' ? parent.className : '';
    if (parent.childElementCount === 1 && !/container|col_|content|main|feed-content/i.test(cls)) {
      target = parent;
      continue;
    }
    break;
  }
  target.setAttribute('data-zbb', '1');
}

export function ensureStyle(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = '[data-zbb="1"]{display:none!important}';
  (doc.head ?? doc.documentElement).appendChild(style);
}

export interface Scanner {
  /** 立即扫一遍，用于"热榜列表刚到"时补扫已经渲染的卡片 */
  scan: () => void;
  stop: () => void;
}

/**
 * DOM 兜底层：SSR 首屏、拦截层覆盖不到的卡片走这里。
 * 判定仍然交给同一个 matchTitle，保证两层结论一致。
 */
export function startScanner(opts: ScannerOptions): Scanner {
  const seen = new WeakSet<Element>();
  let timer = 0;
  let stopped = false;

  const scan = (): void => {
    if (stopped) return;
    const settings = opts.settings();
    if (!settings.enabled) return;
    const hot = opts.hot();
    if (hot.length === 0) return;

    ensureStyle();
    const cards = document.querySelectorAll(CARD_SELECTORS.join(','));
    cards.forEach((card) => {
      if (seen.has(card)) return;
      seen.add(card);
      const title = extractTitle(card);
      if (!title) return;
      const result = matchTitle(title, hot, settings);
      if (!result.hit) return;
      hideCard(card);
      opts.onHit(title, result);
    });
  };

  const schedule = (): void => {
    if (timer || stopped) return;
    timer = window.setTimeout(() => {
      timer = 0;
      scan();
    }, 120);
  };

  scan();

  const root = document.documentElement ?? document;
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true });

  // 前 60 秒定时补扫，兜住 masonry 重新布局、数据晚到的情况
  const interval = window.setInterval(scan, 1500);
  window.setTimeout(() => window.clearInterval(interval), 60_000);

  return {
    scan,
    stop: () => {
      stopped = true;
      observer.disconnect();
      window.clearInterval(interval);
      if (timer) window.clearTimeout(timer);
    },
  };
}
