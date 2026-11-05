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
  /**
   * 每张卡片先过这里，返回 true 表示已处理（比如 UP 库命中被隐藏），
   * 不再走标题匹配。用来给宿主注入「拉黑这个 UP」按钮。
   */
  onCard?: (card: Element) => boolean | void;
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

    // 只往上收「明确的卡片单元」：class 里带 card/cell/item 且只包着这一张卡。
    // 以前几乎无条件上收两级，遇到非常规结构会把邻列一起摘掉，表现就是卡片错位。
    const looksLikeCell = /(^|[s_-])(card|cell|item)([s_-]|$)/i.test(cls) && parent.childElementCount === 1;
    if (looksLikeCell) {
      target = parent;
      continue;
    }
    break;
  }
  // 直接用内联样式隐藏：避免一条全局 [data-zbb] 规则影响到别处，
  // 也避免某些布局里父级被整块摘掉导致邻列错位
  if (target instanceof HTMLElement) {
    target.style.setProperty('display', 'none', 'important');
  }
  target.setAttribute('data-zbb', '1');
}

export function ensureStyle(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = '[data-zbb="1"]{display:none!important}';
  // document_start 阶段 documentElement 可能还不存在，等下一轮再挂
  const root = doc.head ?? doc.documentElement;
  if (!root) return;
  root.appendChild(style);
}

export interface UpOwner {
  mid: number;
  name: string;
}

const UP_STYLE_ID = 'zbb-up-style';

/** 卡片上的 UP 信息：mid 从空间链接里取，名字从作者节点取 */
export function cardOwner(card: Element): UpOwner | null {
  const link = card.querySelector('a[href*="space.bilibili.com"]');
  const href = link?.getAttribute('href') ?? '';
  const mid = Number(href.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? 0);
  if (!mid) return null;
  const name =
    card
      .querySelector('.bili-video-card__info--author, .up-name, [class*="author"]')
      ?.textContent?.trim() ?? '';
  return { mid, name: name.slice(0, 40) };
}

function ensureUpStyle(doc: Document): void {
  if (doc.getElementById(UP_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = UP_STYLE_ID;
  style.textContent = `
[data-zbb-up] {
  /* 左上角：B 站自己的「稍后观看」等在右上角，这里避开它，也避开其它净化脚本的按钮 */
  position: absolute; top: 6px; left: 6px; right: auto; z-index: 2147483000;
  padding: 3px 8px; border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.28);
  background: rgba(20,22,27,.82); color: #fff;
  font: 11px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  opacity: 0; transition: opacity .15s; backdrop-filter: blur(6px);
  /* 只让自己可点，不挡住卡片的其它交互 */
  pointer-events: auto; contain: layout style;
}
.bili-video-card:hover [data-zbb-up],
.feed-card:hover [data-zbb-up],
a:hover > [data-zbb-up],
[data-zbb-up]:hover { opacity: 1; }
[data-zbb-up]:hover { border-color: #fb7299; color: #fb7299; }
`;
  const root = doc.head ?? doc.documentElement;
  if (!root) return;
  root.appendChild(style);
}

/**
 * 挂「屏蔽此 UP」按钮。
 *
 * 定位不要依赖卡片根节点：B 站（以及 AdGuard 之类的插件）会往卡片里塞各种包裹层，
 * 根节点的定位上下文经常不是我们以为的那个，按钮就会飘到别处。
 * 优先挂到封面元素上——它自带定位、且正好是鼠标悬停区域。
 */
export function attachUpButton(card: Element, owner: UpOwner, onBlock: (owner: UpOwner) => void): void {
  if (card.querySelector('[data-zbb-up]')) return;

  // 卡片还没渲染出内容（比如被广告拦截插件替换成占位符）时不要挂
  if (!card.textContent || card.textContent.trim().length < 2) return;

  ensureUpStyle(card.ownerDocument ?? document);

  const cover = card.querySelector(
    '.bili-video-card__cover, [class*="bili-video-card__cover"], .bili-cover, [class*="cover"], .pic',
  );
  // 找不到封面就不挂：退回卡片根节点时定位上下文经常不对，
  // 按钮会飘到页面左上角。宁可这个位置没有按钮，也不要错位。
  if (!cover) return;
  const host = cover as HTMLElement;

  // 绝不修改宿主的 position：B 站封面里还有时长、播放量等绝对定位的角标，
  // 一旦我们把 static 改成 relative，这些角标的参照物就变了，整张卡会「错位」。
  // 所以只在封面本身已经有定位上下文时才挂按钮，否则放弃。
  try {
    const pos = getComputedStyle(host).position;
    if (!pos || pos === 'static') return;
  } catch {
    return;
  }

  const btn = document.createElement('button');
  btn.setAttribute('data-zbb-up', '1');
  btn.textContent = '屏蔽此 UP';
  btn.title = `把 ${owner.name || owner.mid} 加入 UP 库，此后其视频不再出现在首页`;

  // 按下与点击都就地拦下：既避免触发卡片自身的「稍后观看」，
  // 也避免其它脚本挂的委托监听收到我们按钮的事件
  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  btn.addEventListener('pointerdown', swallow);
  btn.addEventListener('mousedown', swallow);
  btn.addEventListener('click', (event) => {
    swallow(event);
    onBlock(owner);
  });

  host.appendChild(btn);
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
    const hot = opts.hot();

    // 卡片上的「屏蔽此 UP」按钮与题库无关：题库为空也照样挂上。
    // 只有标题匹配需要题库与总开关。
    const canMatch = settings.enabled && hot.length > 0;

    ensureStyle();
    const cards = document.querySelectorAll(CARD_SELECTORS.join(','));
    cards.forEach((card) => {
      // onCard 每轮都跑（幂等）：其它脚本重绘卡片时，按钮能被补回来。
      // 标题匹配只对没见过的卡片做一次。
      const first = !seen.has(card);
      if (first) seen.add(card);
      if (opts.onCard?.(card) === true) return;
      if (!canMatch || !first) return;
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
    }, 200);
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
