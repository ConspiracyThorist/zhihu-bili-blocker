/**
 * 页面右下角的浮窗：只显示两个数，点开才看最近几条。
 *
 * 设计取舍：拦截记录不该占据视觉重心，但用户又需要「刚才拦了没」这个反馈。
 * 所以默认是一枚低存在感的胶囊，hover 才变实；展开后也只给 5 条。
 */
import { MODES, modeOf, type HitRecord } from './types';

export interface WidgetSettings {
  getEnabled: () => boolean;
  onToggle: (enabled: boolean) => void;
  getThreshold: () => number;
  onThreshold: (threshold: number) => void;

  /** 以下可选：油猴版没有独立设置页，靠这些把「高级设置」塞进浮窗 */
  getPoolInfo?: () => string;
  getSeedUrl?: () => string;
  onSeedUrl?: (url: string) => void;
  onRefresh?: () => void;
  onSyncSeed?: () => void;
  /** 匿名贡献开关 */
  getContribute?: () => boolean;
  onContribute?: (value: boolean) => void;
}

export interface WidgetOptions {
  getSession: () => number;
  getTotal: () => number;
  getPool: () => number;
  getRecords: () => HitRecord[];
  onAllow: (record: HitRecord) => void;
  /** 扩展版：在侧边栏打开设置页；油猴版不传，因为设置就在面板里 */
  onOpenSettings?: () => void;
  /** 油猴版没有弹窗，设置直接放在展开面板里；扩展不传 */
  settings?: WidgetSettings;
}

const STYLE = `
:host { all: initial; }
.pill {
  position: fixed; right: 18px; top: 42%; z-index: 2147483640;
  display: flex; align-items: center; gap: 7px;
  padding: 7px 12px; border-radius: 999px;
  background: rgba(20, 22, 27, 0.72);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #d9dce2; font: 12px/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  cursor: grab; opacity: 0.62; transition: opacity .15s, border-color .15s;
  user-select: none; touch-action: none; white-space: nowrap;
}
.pill:hover { opacity: 1; border-color: rgba(255,255,255,.22); }
.pill.open { opacity: 1; }
.pill.dragging { transition: none; cursor: grabbing; opacity: 1; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #fb7299; flex: none; }
.pill b { font-weight: 600; color: #fff; font-variant-numeric: tabular-nums; }
.sep { color: #6b7280; }

.panel {
  position: fixed; left: 0; top: 0; z-index: 2147483641;
  width: 300px; max-height: 46vh; overflow: auto;
  padding: 10px 12px; border-radius: 12px;
  background: rgba(20, 22, 27, 0.96);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
  color: #e8eaed; font: 12px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.panel[hidden] { display: none; }
.head { display: flex; justify-content: space-between; align-items: center; color: #8b929e; margin-bottom: 8px; }
.head-right { display: flex; align-items: center; gap: 10px; }
.open-panel {
  border: 0; background: none; padding: 0; cursor: pointer;
  color: #fb7299; font: inherit; font-size: 11px;
}
.open-panel:hover { text-decoration: underline; }
.item { padding: 6px 0; border-top: 1px solid rgba(255,255,255,.07); }
.item:first-of-type { border-top: 0; padding-top: 0; }
.t { color: #e8eaed; word-break: break-all; }
.m { display: flex; align-items: center; gap: 6px; margin-top: 2px; color: #8b929e; font-size: 11px; }
.z { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s { color: #fb7299; font-variant-numeric: tabular-nums; }
.a { border: 0; background: none; color: #8b929e; font: inherit; font-size: 11px; cursor: pointer; padding: 0 2px; }
.a:hover { color: #4ade80; }
.empty { color: #8b929e; text-align: center; padding: 12px 0; }
.settings { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.07); }
.srow { display: flex; align-items: center; justify-content: space-between; color: #8b929e; }
.cb { accent-color: #fb7299; cursor: pointer; }
.modes { display: flex; gap: 6px; margin-top: 8px; }
.chip {
  flex: 1; padding: 5px 0; border-radius: 7px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.1); background: #16181d;
  color: #b9bfc9; font: inherit; font-size: 11px;
}
.chip:hover { border-color: rgba(255,255,255,.24); }
.chip.active { border-color: #fb7299; color: #fb7299; background: rgba(251,114,153,.1); }

.adv { margin-top: 8px; }
.adv > summary {
  cursor: pointer; color: #8b929e; font-size: 11px; list-style: none;
  display: flex; justify-content: space-between; align-items: center;
}
.adv > summary::-webkit-details-marker { display: none; }
.adv > summary::after { content: '展开'; }
.adv[open] > summary::after { content: '收起'; }
.adv-body { margin-top: 6px; display: flex; flex-direction: column; gap: 8px; }
.adv-row { display: flex; justify-content: space-between; color: #8b929e; font-size: 11px; }
.adv-value { color: #e8eaed; font-variant-numeric: tabular-nums; }
.adv-range { width: 100%; accent-color: #fb7299; }
.adv-info { color: #8b929e; font-size: 11px; }
.adv-toggle { accent-color: #fb7299; cursor: pointer; }
.adv-input {
  width: 100%; padding: 5px 7px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,.12); background: #14161a;
  color: #e8eaed; font: inherit; font-size: 11px;
}
.adv-input:focus { outline: none; border-color: #fb7299; }
.adv-actions { display: flex; gap: 6px; }
.adv-btn {
  flex: 1; padding: 5px 0; border-radius: 6px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.12); background: #16181d;
  color: #b9bfc9; font: inherit; font-size: 11px;
}
.adv-btn:hover { border-color: rgba(255,255,255,.26); }
.adv-btn:disabled { opacity: .55; cursor: default; }
`;

function createWidget(opts: WidgetOptions): {
  refresh: () => void;
  open: () => void;
  destroy: () => void;
} {
  const host = document.createElement('div');
  host.id = 'zbb-widget';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${STYLE}</style>
    <button class="pill" part="pill"><span class="dot"></span><span class="text"></span></button>
    <div class="panel" hidden></div>`;

  const pill = root.querySelector('.pill') as HTMLButtonElement;
  const text = root.querySelector('.text') as HTMLElement;
  const panel = root.querySelector('.panel') as HTMLElement;

  // ---- 位置：默认右中，可拖动，位置记在 localStorage（两个壳都能用） ----
  const POS_KEY = 'zbb:widget-pos';

  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

  const applyPos = (x: number, y: number): void => {
    pill.style.left = `${x}px`;
    pill.style.top = `${y}px`;
    pill.style.right = 'auto';
    pill.style.transform = 'none';
  };

  const placePanel = (): void => {
    const r = pill.getBoundingClientRect();
    const pw = panel.offsetWidth || 300;
    const ph = panel.offsetHeight || 200;
    const left = clamp(r.right - pw, 8, window.innerWidth - pw - 8);
    let top = r.top - ph - 8;
    if (top < 8) top = clamp(r.bottom + 8, 8, window.innerHeight - ph - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };

  const savePos = (): void => {
    try {
      localStorage.setItem(
        POS_KEY,
        JSON.stringify({ x: parseFloat(pill.style.left), y: parseFloat(pill.style.top) }),
      );
    } catch {
      /* 隐私模式下 localStorage 可能不可写 */
    }
  };

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
    const rightWrap = document.createElement('span');
    rightWrap.className = 'head-right';
    const right = document.createElement('span');
    right.textContent = `题库 ${opts.getPool()} 条`;
    rightWrap.append(right);

    if (opts.onOpenSettings) {
      const open = document.createElement('button');
      open.className = 'open-panel';
      open.textContent = '设置 ↗';
      open.title = '在侧边栏打开设置页';
      open.addEventListener('click', (event) => {
        event.stopPropagation();
        opts.onOpenSettings?.();
        close();
      });
      rightWrap.append(open);
    }

    head.append(left, rightWrap);
    panel.append(head);

    if (records.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有拦截记录';
      panel.append(empty);
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

    appendSettings();
  };

  /** 油猴版没有弹窗，开关和强度直接放进展开面板 */
  const appendSettings = () => {
    const cfg = opts.settings;
    if (!cfg) return;

    const box = document.createElement('div');
    box.className = 'settings';

    const row = document.createElement('div');
    row.className = 'srow';
    const label = document.createElement('span');
    label.textContent = '总开关';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'cb';
    toggle.checked = cfg.getEnabled();
    toggle.addEventListener('change', () => {
      cfg.onToggle(toggle.checked);
      refresh();
    });
    row.append(label, toggle);

    const modes = document.createElement('div');
    modes.className = 'modes';
    const current = modeOf(cfg.getThreshold());
    for (const mode of MODES) {
      const chip = document.createElement('button');
      chip.className = `chip${current?.id === mode.id ? ' active' : ''}`;
      chip.textContent = mode.name;
      chip.title = `阈值 ${mode.threshold}`;
      chip.addEventListener('click', () => {
        cfg.onThreshold(mode.threshold);
        renderPanel();
      });
      modes.append(chip);
    }

    box.append(row, modes);

    // 高级设置：只有宿主提供了对应能力才渲染（扩展版走弹窗，不传这些）
    const hasAdvanced =
      cfg.getPoolInfo || cfg.onRefresh || cfg.onSyncSeed || cfg.getSeedUrl;
    if (hasAdvanced) box.append(buildAdvanced(cfg));

    panel.append(box);
  };

  /** 精确阈值、题库状态、远端源、手动刷新——油猴版没有别的地方放这些 */
  const buildAdvanced = (cfg: WidgetSettings): HTMLElement => {
    const details = document.createElement('details');
    details.className = 'adv';

    const summary = document.createElement('summary');
    summary.textContent = '高级设置';
    details.append(summary);

    const body = document.createElement('div');
    body.className = 'adv-body';

    const head = document.createElement('div');
    head.className = 'adv-row';
    const label = document.createElement('span');
    label.textContent = '精确阈值';
    const value = document.createElement('span');
    value.className = 'adv-value';
    value.textContent = cfg.getThreshold().toFixed(2);
    head.append(label, value);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0.6';
    slider.max = '0.92';
    slider.step = '0.01';
    slider.value = String(cfg.getThreshold());
    slider.className = 'adv-range';
    slider.addEventListener('input', () => {
      value.textContent = Number(slider.value).toFixed(2);
    });
    slider.addEventListener('change', () => {
      cfg.onThreshold(Number(slider.value));
      renderPanel();
    });

    body.append(head, slider);

    if (cfg.getPoolInfo) {
      const info = document.createElement('div');
      info.className = 'adv-info';
      info.textContent = cfg.getPoolInfo();
      body.append(info);
    }

    // 匿名贡献开关：手动拉黑 UP 时是否上报 mid
    if (cfg.getContribute && cfg.onContribute) {
      const row = document.createElement('div');
      row.className = 'adv-row';
      const label = document.createElement('span');
      label.textContent = '匿名贡献 UP';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'adv-toggle';
      toggle.checked = cfg.getContribute();
      toggle.title = '手动屏蔽 UP 时把 UP 编号提交到公共库审核，可随时关闭';
      toggle.addEventListener('change', () => {
        cfg.onContribute?.(toggle.checked);
      });
      row.append(label, toggle);
      body.append(row);
    }

    if (cfg.getSeedUrl || cfg.onSyncSeed) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'adv-input';
      input.placeholder = '远端题库源（留空则不启用）';
      input.spellcheck = false;
      input.value = cfg.getSeedUrl?.() ?? '';
      input.addEventListener('change', () => cfg.onSeedUrl?.(input.value.trim()));
      body.append(input);
    }

    if (cfg.onRefresh || cfg.onSyncSeed) {
      const actions = document.createElement('div');
      actions.className = 'adv-actions';
      for (const [text, fn] of [
        ['刷新热榜', cfg.onRefresh],
        ['同步题库', cfg.onSyncSeed],
      ] as [string, (() => void) | undefined][]) {
        if (!fn) continue;
        const btn = document.createElement('button');
        btn.className = 'adv-btn';
        btn.textContent = text;
        btn.addEventListener('click', () => {
          btn.disabled = true;
          btn.textContent = '请求中…';
          fn();
          window.setTimeout(() => {
            btn.disabled = false;
            btn.textContent = text;
            renderPanel();
          }, 1500);
        });
        actions.append(btn);
      }
      body.append(actions);
    }

    details.append(body);
    return details;
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

  // ---- 拖拽 ----
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  pill.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = pill.getBoundingClientRect();
    dragging = true;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    originX = rect.left;
    originY = rect.top;
    pill.classList.add('dragging');
    try {
      pill.setPointerCapture(event.pointerId);
    } catch {
      /* 合成事件里可能没有真实 pointerId */
    }
  });

  pill.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    moved = true;

    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    applyPos(
      clamp(originX + dx, 4, window.innerWidth - w - 4),
      clamp(originY + dy, 4, window.innerHeight - h - 4),
    );
    if (!panel.hidden) placePanel();
  });

  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    pill.classList.remove('dragging');
    if (moved) savePos();
  };
  pill.addEventListener('pointerup', endDrag);
  pill.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', () => {
    if (!pill.style.left) return;
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    applyPos(
      clamp(parseFloat(pill.style.left), 4, window.innerWidth - w - 4),
      clamp(parseFloat(pill.style.top), 4, window.innerHeight - h - 4),
    );
    if (!panel.hidden) placePanel();
  });

  pill.addEventListener('click', (event) => {
    event.stopPropagation();
    if (moved) {
      moved = false;
      return;
    }
    if (panel.hidden) {
      renderPanel();
      panel.hidden = false;
      pill.classList.add('open');
      placePanel();
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

  // 只在用户拖过之后才切成 left/top 定位。
  // 默认位置由 CSS 的 right 锚定——固定定位元素一旦给 left，宽度会按剩余空间收缩，
  // 首帧量不到宽度就会把文案挤成竖排、甚至挤出屏幕。
  try {
    const saved = localStorage.getItem(POS_KEY);
    if (saved) {
      const pos = JSON.parse(saved) as { x: number; y: number };
      if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        applyPos(
          clamp(pos.x, 4, Math.max(4, window.innerWidth - 160)),
          clamp(pos.y, 4, Math.max(4, window.innerHeight - 40)),
        );
      }
    }
  } catch {
    /* 读不到就用 CSS 默认位置 */
  }
  refresh();

  return {
    refresh,
    open: () => {
      renderPanel();
      panel.hidden = false;
      pill.classList.add('open');
      placePanel();
    },
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
export function mountWidget(opts: WidgetOptions): {
  refresh: () => void;
  open: () => void;
  destroy: () => void;
} {
  try {
    return createWidget(opts);
  } catch {
    return { refresh: () => undefined, open: () => undefined, destroy: () => undefined };
  }
}
