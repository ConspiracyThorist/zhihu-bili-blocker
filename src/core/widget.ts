/**
 * 页面右下角的浮窗：只显示两个数，点开才看最近几条。
 *
 * 设计取舍：拦截记录不该占据视觉重心，但用户又需要「刚才拦了没」这个反馈。
 * 所以默认是一枚低存在感的胶囊，hover 才变实；展开后也只给 5 条。
 */
import type { HitRecord } from './types';

export interface WidgetOptions {
  getSession: () => number;
  getTotal: () => number;
  getPool: () => number;
  getRecords: () => HitRecord[];
  onAllow: (record: HitRecord) => void;
}

const STYLE = `
:host { all: initial; }
.pill {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483640;
  display: flex; align-items: center; gap: 7px;
  padding: 7px 12px; border-radius: 999px;
  background: rgba(20, 22, 27, 0.72);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #d9dce2; font: 12px/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  cursor: pointer; opacity: 0.62; transition: opacity .15s, transform .15s, border-color .15s;
  user-select: none;
}
.pill:hover { opacity: 1; transform: translateY(-1px); border-color: rgba(255,255,255,.22); }
.pill.open { opacity: 1; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #fb7299; flex: none; }
.pill b { font-weight: 600; color: #fff; font-variant-numeric: tabular-nums; }
.sep { color: #6b7280; }

.panel {
  position: fixed; right: 18px; bottom: 58px; z-index: 2147483641;
  width: 300px; max-height: 46vh; overflow: auto;
  padding: 10px 12px; border-radius: 12px;
  background: rgba(20, 22, 27, 0.96);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
  color: #e8eaed; font: 12px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.panel[hidden] { display: none; }
.head { display: flex; justify-content: space-between; color: #8b929e; margin-bottom: 8px; }
.item { padding: 6px 0; border-top: 1px solid rgba(255,255,255,.07); }
.item:first-of-type { border-top: 0; padding-top: 0; }
.t { color: #e8eaed; word-break: break-all; }
.m { display: flex; align-items: center; gap: 6px; margin-top: 2px; color: #8b929e; font-size: 11px; }
.z { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s { color: #fb7299; font-variant-numeric: tabular-nums; }
.a { border: 0; background: none; color: #8b929e; font: inherit; font-size: 11px; cursor: pointer; padding: 0 2px; }
.a:hover { color: #4ade80; }
.empty { color: #8b929e; text-align: center; padding: 12px 0; }
`;

function createWidget(opts: WidgetOptions): { refresh: () => void; destroy: () => void } {
  const host = document.createElement('div');
  host.id = 'zbb-widget';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${STYLE}</style>
    <button class="pill" part="pill"><span class="dot"></span><span class="text"></span></button>
    <div class="panel" hidden></div>`;

  const pill = root.querySelector('.pill') as HTMLButtonElement;
  const text = root.querySelector('.text') as HTMLElement;
  const panel = root.querySelector('.panel') as HTMLElement;

  const close = () => {
    panel.hidden = true;
    pill.classList.remove('open');
  };

  const renderPanel = () => {
    const records = opts.getRecords().slice(0, 5);
    panel.textContent = '';

    const head = document.createElement('div');
    head.className = 'head';
    const left = document.createElement('span');
    left.textContent = '最近拦截';
    const right = document.createElement('span');
    right.textContent = `题库 ${opts.getPool()} 条`;
    head.append(left, right);
    panel.append(head);

    if (records.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有拦截记录';
      panel.append(empty);
      return;
    }

    for (const record of records) {
      const item = document.createElement('div');
      item.className = 'item';

      const title = document.createElement('div');
      title.className = 't';
      title.textContent = record.biliTitle;

      const meta = document.createElement('div');
      meta.className = 'm';

      const zhihu = document.createElement('span');
      zhihu.className = 'z';
      zhihu.textContent = `← ${record.zhihuTitle}`;
      zhihu.title = record.zhihuTitle;

      const score = document.createElement('span');
      score.className = 's';
      score.textContent = record.score.toFixed(2);

      const allow = document.createElement('button');
      allow.className = 'a';
      allow.textContent = '放行';
      allow.addEventListener('click', () => {
        opts.onAllow(record);
        renderPanel();
      });

      meta.append(zhihu, score, allow);
      item.append(title, meta);
      panel.append(item);
    }
  };

  const refresh = () => {
    text.textContent = '已拦截 ';
    const session = document.createElement('b');
    session.textContent = String(opts.getSession());
    text.append(session, ' · 累计 ');
    const total = document.createElement('b');
    total.textContent = String(opts.getTotal());
    text.append(total);
    if (!panel.hidden) renderPanel();
  };

  pill.addEventListener('click', (event) => {
    event.stopPropagation();
    if (panel.hidden) {
      renderPanel();
      panel.hidden = false;
      pill.classList.add('open');
    } else {
      close();
    }
  });

  const onDocClick = (event: MouseEvent) => {
    if (panel.hidden) return;
    const path = event.composedPath();
    if (!path.includes(host)) close();
  };
  document.addEventListener('click', onDocClick, true);

  document.documentElement.append(host);
  refresh();

  return {
    refresh,
    destroy: () => {
      document.removeEventListener('click', onDocClick, true);
      host.remove();
    },
  };
}

/**
 * 挂载浮窗。任何环境不支持（比如没有 Shadow DOM）就静默降级成空实现——
 * 浮窗只是反馈，不能因为它挂了就影响屏蔽本身。
 */
export function mountWidget(opts: WidgetOptions): { refresh: () => void; destroy: () => void } {
  try {
    return createWidget(opts);
  } catch {
    return { refresh: () => undefined, destroy: () => undefined };
  }
}
