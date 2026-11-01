import { startScanner } from '../core/dom';
import { prepareHot, type HotEntry } from '../core/engine';
import { installFeedHook } from '../core/hook';
import { parseRss, pickTitles } from '../core/hotparse';
import {
  mergePool,
  parseSeed,
  prunePool,
  replaceOrigin,
  splitByFreshness,
  type PoolEntry,
} from '../core/pool';
import {
  DEFAULT_SETTINGS,
  KEYS,
  RECORD_LIMIT,
  type HitRecord,
  type HotPool,
  type Settings,
} from '../core/types';

/**
 * 油猴壳。与扩展壳的差别只在外围：
 * - 取数走 GM_xmlhttpRequest（能自定义 UA，且跨域）
 * - 存储走 GM_getValue / GM_setValue
 * - hook 挂到 unsafeWindow 上，才拿得到页面自己的 fetch
 * 匹配、剪枝、DOM 兜底全部复用 core，保证两个版本行为一致。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOT_MAX_AGE = 30 * 60 * 1000;
const SEED_MAX_AGE = 20 * 60 * 60 * 1000;
const HOST_ID = 'zbb-root';

const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window) as Window;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = GM_getValue<string>(key, '');
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    GM_setValue(key, JSON.stringify(value));
  } catch {
    /* 存储失败不影响本次会话 */
  }
}

const state = {
  settings: { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(KEYS.settings, {}) } as Settings,
  fresh: [] as HotEntry[],
  stale: [] as HotEntry[],
  pool: readJson<HotPool | null>(KEYS.hot, null),
  records: readJson<HitRecord[]>(KEYS.records, []),
};

/** 兼容 v1（titles）与 v2（entries）两种存储结构 */
function poolEntries(): PoolEntry[] {
  const raw = state.pool as (HotPool & { titles?: string[] }) | null;
  if (!raw) return [];
  if (Array.isArray(raw.entries)) return raw.entries;
  if (Array.isArray(raw.titles)) {
    const at = raw.updatedAt || Date.now();
    return raw.titles.map((title) => ({ title, firstSeen: at, lastSeen: at, origin: 'hot' as const }));
  }
  return [];
}

function rebuild(): void {
  const split = splitByFreshness(poolEntries(), Date.now(), 7);
  state.fresh = prepareHot(split.fresh.map((e) => e.title));
  state.stale = prepareHot(split.stale.map((e) => e.title)).map((e) => ({ ...e, stale: true }));
}

function allEntries(): HotEntry[] {
  return [...state.fresh, ...state.stale];
}

rebuild();

function saveSettings(): void {
  writeJson(KEYS.settings, state.settings);
}

function savePool(): void {
  writeJson(KEYS.hot, state.pool);
}

function addRecord(record: HitRecord): void {
  const dup = state.records.some(
    (r) => r.biliTitle === record.biliTitle && r.zhihuTitle === record.zhihuTitle,
  );
  if (!dup) state.records.unshift(record);
  state.records = state.records.slice(0, RECORD_LIMIT);
  writeJson(KEYS.records, state.records);
  renderPanel();
}

function gmFetch(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      timeout: 12_000,
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'user-agent': UA,
      },
      onload: (res) => {
        if (res.status >= 200 && res.status < 300) resolve(res.responseText);
        else reject(new Error(`HTTP ${res.status}`));
      },
      onerror: () => reject(new Error('网络错误')),
      ontimeout: () => reject(new Error('超时')),
    });
  });
}

interface Source {
  name: string;
  url: string;
  rss?: boolean;
}

function sources(): Source[] {
  const list: Source[] = [
    { name: '知乎热榜', url: 'https://api.zhihu.com/topstory/hot-list?limit=50&reverse_order=0' },
    {
      name: '知乎热榜(登录态)',
      url: 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50',
    },
  ];
  const rsshub = state.settings.rsshub.trim().replace(/\/+$/, '');
  if (rsshub) list.push({ name: 'RSSHub', url: `${rsshub}/zhihu/hotlist`, rss: true });
  return list;
}

async function refreshHot(force = false): Promise<void> {
  if (!force && state.pool?.updatedAt && Date.now() - state.pool.updatedAt < HOT_MAX_AGE) return;

  const errors: string[] = [];
  for (const source of sources()) {
    try {
      const text = await gmFetch(source.url);
      const titles = source.rss ? parseRss(text) : pickTitles(JSON.parse(text));
      if (titles.length >= 5) {
        const now = Date.now();
        const merged = mergePool(
          poolEntries(),
          titles.map((title) => ({ title, origin: 'hot' as const })),
          now,
        );
        state.pool = {
          ...(state.pool ?? { entries: [], updatedAt: 0, source: 'none', error: '' }),
          entries: prunePool(merged, now, {
            maxAgeDays: state.settings.poolDays,
            maxEntries: state.settings.poolMax,
          }),
          updatedAt: now,
          source: source.name,
          error: '',
        };
        savePool();
        rebuild();
        renderPanel();
        return;
      }
      errors.push(`${source.name}: 只拿到 ${titles.length} 条`);
    } catch (err) {
      errors.push(`${source.name}: ${(err as Error).message}`);
    }
  }

  state.pool = {
    ...(state.pool ?? { entries: [], updatedAt: 0, source: 'none', error: '' }),
    error: errors.join(' | '),
  };
  savePool();
  renderPanel();
}

/** 远端种子：整批替换 remote 条目 */
async function syncSeed(force = false): Promise<void> {
  const urls = (state.settings.remoteSeedUrls ?? []).filter(Boolean);
  if (!urls.length) return;
  if (!force && state.pool?.remote?.at && Date.now() - state.pool.remote.at < SEED_MAX_AGE) return;

  const errors: string[] = [];
  for (const url of urls) {
    try {
      const text = await gmFetch(url);
      const titles = parseSeed(text.slice(0, 512 * 1024));
      if (titles.length < 10) throw new Error(`只解析到 ${titles.length} 条`);
      const now = Date.now();
      const entries = replaceOrigin(poolEntries(), 'remote', titles, now);
      state.pool = {
        ...(state.pool ?? { entries: [], updatedAt: 0, source: 'none', error: '' }),
        entries: prunePool(entries, now, {
          maxAgeDays: state.settings.poolDays,
          maxEntries: state.settings.poolMax,
        }),
        remote: { at: now, count: titles.length, error: '' },
      };
      savePool();
      rebuild();
      renderPanel();
      return;
    } catch (err) {
      errors.push(`${url}: ${(err as Error).message}`);
    }
  }

  state.pool = {
    ...(state.pool ?? { entries: [], updatedAt: 0, source: 'none', error: '' }),
    remote: { at: 0, count: 0, error: errors.join(' | ') },
  };
  savePool();
  renderPanel();
}

// ---- 拦截层（主路径）----
installFeedHook({
  win,
  ready: Promise.resolve(),
  getState: () => ({ settings: state.settings, hot: allEntries() }),
  onHit: (biliTitle, result) => {
    addRecord({
      biliTitle,
      zhihuTitle: result.zhihuTitle,
      score: result.score,
      reason: result.reason === 'none' ? 'dice' : result.reason,
      layer: 'net',
      at: Date.now(),
    });
  },
});

// ---- DOM 兜底 ----
startScanner({
  settings: () => state.settings,
  hot: () => allEntries(),
  onHit: (biliTitle, result) => {
    addRecord({
      biliTitle,
      zhihuTitle: result.zhihuTitle,
      score: result.score,
      reason: result.reason === 'none' ? 'dice' : result.reason,
      layer: 'dom',
      at: Date.now(),
    });
  },
});

// ---- 面板 ----
const TEMPLATE = `
<style>
  :host { all: initial; }
  .fab {
    position: fixed; right: 18px; bottom: 84px; z-index: 2147483646;
    width: 40px; height: 40px; border: 0; border-radius: 12px;
    background: linear-gradient(145deg, #fb7299, #e8618c); color: #fff;
    font: 600 15px/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.35);
    transition: transform .15s;
  }
  .fab:hover { transform: translateY(-2px); }
  .panel {
    position: fixed; right: 18px; bottom: 132px; z-index: 2147483647;
    width: 320px; max-height: 60vh; overflow: auto;
    background: #16181d; color: #e8eaed; border: 1px solid #2b2f37; border-radius: 12px;
    padding: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
    font: 12px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .panel[hidden] { display: none; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  header b { font-size: 13px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 6px 0; }
  .meta { color: #8b929e; }
  button.act {
    flex: 1; padding: 6px 8px; border: 0; border-radius: 8px;
    background: rgba(251,114,153,.16); color: #fb7299; font: inherit; cursor: pointer;
  }
  button.act:disabled { opacity: .5; cursor: default; }
  input[type=range] { width: 120px; accent-color: #fb7299; }
  input[type=checkbox] { accent-color: #fb7299; }
  .list { margin-top: 8px; border-top: 1px solid #2b2f37; padding-top: 8px; }
  .item { padding: 5px 0; border-bottom: 1px solid #23272e; }
  .item:last-child { border-bottom: 0; }
  .item .t { word-break: break-all; }
  .item .m { display: flex; gap: 6px; color: #8b929e; font-size: 11px; }
  .item .m .z { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .m .s { color: #fb7299; }
  .item .m .a { border: 0; background: none; color: #8b929e; font: inherit; font-size: 11px; cursor: pointer; }
  .item .m .a:hover { color: #4ade80; }
  .hint { color: #8b929e; font-size: 11px; }
  .empty { color: #8b929e; text-align: center; padding: 14px 0; }
  footer { color: #8b929e; font-size: 11px; margin-top: 8px; }
</style>
<button class="fab" title="知乎热榜屏蔽（点击展开）">知</button>
<section class="panel" hidden>
  <header>
    <b>知乎热榜 → B 站屏蔽</b>
    <label title="总开关"><input type="checkbox" id="en" /></label>
  </header>
  <div class="meta" id="meta">—</div>
  <div class="row">
    <button class="act" id="refresh">刷新热榜</button>
    <span class="hint" id="hint"></span>
  </div>
  <div class="row">
    <span>相似度阈值</span>
    <span><input type="range" id="th" min="0.6" max="0.92" step="0.01" /> <b id="thv">0.72</b></span>
  </div>
  <div class="list" id="list"></div>
  <footer id="foot">最近拦截 0 条</footer>
</section>`;

let shadow: ShadowRoot | null = null;

function fmtTime(ts: number): string {
  if (!ts) return '从未成功';
  const date = new Date(ts);
  const now = new Date();
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return date.toDateString() === now.toDateString()
    ? `今天 ${hm}`
    : `${date.getMonth() + 1}-${date.getDate()} ${hm}`;
}

function renderPanel(): void {
  if (!shadow) return;
  const meta = shadow.getElementById('meta') as HTMLElement | null;
  const foot = shadow.getElementById('foot');
  const list = shadow.getElementById('list') as HTMLElement | null;
  const en = shadow.getElementById('en') as HTMLInputElement | null;
  const th = shadow.getElementById('th') as HTMLInputElement | null;
  const thv = shadow.getElementById('thv');
  if (!meta || !list || !foot || !en || !th || !thv) return;

  const pool = state.pool;
  const entries = poolEntries();
  meta.textContent = pool?.updatedAt
    ? `题库 ${entries.length} 条 · ${fmtTime(pool.updatedAt)}${pool.error ? ' · 上次失败' : ''}`
    : '题库未同步';
  meta.title = [pool?.error, pool?.remote?.error].filter(Boolean).join(' | ');
  en.checked = state.settings.enabled;
  th.value = String(state.settings.threshold);
  thv.textContent = state.settings.threshold.toFixed(2);
  foot.textContent = `最近拦截 ${state.records.length} 条 · 油猴版 v1.0.0`;

  list.textContent = '';
  if (state.records.length === 0) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = '还没有拦截记录';
    list.append(p);
    return;
  }

  for (const record of state.records.slice(0, 8)) {
    const item = document.createElement('div');
    item.className = 'item';

    const title = document.createElement('div');
    title.className = 't';
    title.textContent = record.biliTitle;

    const metaRow = document.createElement('div');
    metaRow.className = 'm';

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
      if (!state.settings.whitelist.includes(record.biliTitle)) {
        state.settings = {
          ...state.settings,
          whitelist: [...state.settings.whitelist, record.biliTitle],
        };
        saveSettings();
      }
      state.records = state.records.filter(
        (r) => !(r.biliTitle === record.biliTitle && r.zhihuTitle === record.zhihuTitle),
      );
      writeJson(KEYS.records, state.records);
      renderPanel();
    });

    metaRow.append(zhihu, score, allow);
    item.append(title, metaRow);
    list.append(item);
  }
}

function bindPanel(): void {
  if (!shadow) return;
  const fab = shadow.querySelector('.fab');
  const panel = shadow.querySelector('.panel') as HTMLElement | null;
  const en = shadow.getElementById('en') as HTMLInputElement | null;
  const th = shadow.getElementById('th') as HTMLInputElement | null;
  const refresh = shadow.getElementById('refresh') as HTMLButtonElement | null;
  const hint = shadow.getElementById('hint');

  fab?.addEventListener('click', () => {
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderPanel();
  });

  en?.addEventListener('change', () => {
    state.settings = { ...state.settings, enabled: en.checked };
    saveSettings();
    if (!en.checked) {
      document.querySelectorAll('[data-zbb="1"]').forEach((el) => el.removeAttribute('data-zbb'));
    }
  });

  th?.addEventListener('input', () => {
    if (!shadow) return;
    const value = shadow.getElementById('thv');
    if (value) value.textContent = Number(th.value).toFixed(2);
  });
  th?.addEventListener('change', () => {
    state.settings = { ...state.settings, threshold: Number(th.value) };
    saveSettings();
  });

  refresh?.addEventListener('click', async () => {
    refresh.disabled = true;
    if (hint) hint.textContent = '请求中…';
    await refreshHot(true);
    refresh.disabled = false;
    if (hint) {
      hint.textContent = state.pool?.error ? '失败，见悬浮提示' : '已更新';
      window.setTimeout(() => {
        if (hint) hint.textContent = '';
      }, 2500);
    }
  });
}

function mountPanel(): void {
  if (shadow || document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = TEMPLATE;
  document.documentElement.append(host);
  bindPanel();
  renderPanel();
}

if (document.documentElement) mountPanel();
else document.addEventListener('DOMContentLoaded', mountPanel, { once: true });

if (typeof GM_registerMenuCommand === 'function') {
  GM_registerMenuCommand('打开知乎屏蔽面板', () => {
    mountPanel();
    const panel = shadow?.querySelector('.panel') as HTMLElement | null;
    if (panel) {
      panel.hidden = false;
      renderPanel();
    }
  });
}

void refreshHot();
void syncSeed();
