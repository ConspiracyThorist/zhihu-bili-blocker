import { attachUpButton, cardOwner, hideCard, startScanner } from '../core/dom';
import { prepareHot, type HotEntry } from '../core/engine';
import { installFeedHook } from '../core/hook';
import { parseRss, pickTitles } from '../core/hotparse';
import { mergeUps, parseUpsFile, type UpEntry } from '../core/ups';
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
  type Stats,
} from '../core/types';
import { mountWidget } from '../core/widget';

/**
 * 油猴壳。与扩展壳的差别只在外围：
 * - 取数走 GM_xmlhttpRequest（能自定义 UA，且跨域）
 * - 存储走 GM_getValue / GM_setValue
 * - hook 挂到 unsafeWindow 上，才拿得到页面自己的 fetch
 * 匹配、剪枝、DOM 兜底、浮窗全部复用 core，保证两个版本行为一致。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOT_MAX_AGE = 30 * 60 * 1000;
const SEED_MAX_AGE = 20 * 60 * 60 * 1000;

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
  stats: readJson<Stats>(KEYS.stats, { total: 0 }),
  ups: readJson<{ entries: UpEntry[]; updatedAt: number }>(KEYS.ups, { entries: [], updatedAt: 0 }),
};

/** UP 库命中的 mid 集合；开关关掉时返回空集合 */
function blockedMids(): Set<number> {
  if (!state.settings.upBlockEnabled) return new Set();
  return new Set(state.ups.entries.map((entry) => entry.mid));
}

/** 匿名提交到公共 UP 库；失败不影响本地屏蔽 */
function submitUp(mid: number, name: string): void {
  if (!state.settings.contributeUps) return;
  const endpoints = (state.settings.upsEndpoints ?? [])
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (endpoints.length === 0) return;

  const attempt = (index: number): void => {
    if (index >= endpoints.length) return;
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${endpoints[index]}/submit`,
      timeout: 8_000,
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({ mid, name }),
      onload: (res) => {
        if (res.status < 200 || res.status >= 300) attempt(index + 1);
      },
      onerror: () => attempt(index + 1),
      ontimeout: () => attempt(index + 1),
    });
  };
  attempt(0);
}

function addUp(mid: number, name: string): void {
  if (state.ups.entries.some((entry) => entry.mid === mid)) return;
  state.ups = {
    entries: [...state.ups.entries, { mid, name, source: 'manual', addedAt: Date.now() }],
    updatedAt: Date.now(),
  };
  writeJson(KEYS.ups, state.ups);
  submitUp(mid, name);
  widget?.refresh();
}

let sessionHits = 0;
let widget: ReturnType<typeof mountWidget> | null = null;

/** 题库只有一种存储结构：entries + 元信息 */
function poolEntries(): PoolEntry[] {
  const raw = state.pool;
  return Array.isArray(raw?.entries) ? raw.entries : [];
}

function rebuild(): void {
  const split = splitByFreshness(poolEntries(), Date.now(), 7);
  state.fresh = prepareHot(split.fresh.map((e) => e.title));
  state.stale = prepareHot(split.stale.map((e) => e.title)).map((e) => ({ ...e, stale: true }));
}

function allEntries(): HotEntry[] {
  return [...state.fresh, ...state.stale];
}

function saveSettings(): void {
  writeJson(KEYS.settings, state.settings);
}

function savePool(): void {
  writeJson(KEYS.hot, state.pool);
}

function fmtTime(ts: number): string {
  if (!ts) return '从未成功';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString()
    ? `今天 ${hm}`
    : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

function addRecord(record: HitRecord): void {
  const dup = state.records.some(
    (r) => r.biliTitle === record.biliTitle && r.zhihuTitle === record.zhihuTitle,
  );
  if (!dup) {
    state.records.unshift(record);
    state.records = state.records.slice(0, RECORD_LIMIT);
    sessionHits += 1;
    state.stats = { total: state.stats.total + 1 };
    writeJson(KEYS.records, state.records);
    writeJson(KEYS.stats, state.stats);
  }
  widget?.refresh();
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
        widget?.refresh();
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
  widget?.refresh();
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
      widget?.refresh();
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
  widget?.refresh();
}

const UPS_MAX_AGE = 20 * 60 * 60 * 1000;

/** 同步远端 UP 库：auto 条目整批替换，手动拉黑的保留 */
async function syncUps(force = false): Promise<void> {
  const urls = (state.settings.remoteUpsUrls ?? []).filter(Boolean);
  if (!urls.length) return;
  if (!force && state.ups.updatedAt && Date.now() - state.ups.updatedAt < UPS_MAX_AGE) return;

  for (const url of urls) {
    try {
      const text = await gmFetch(url);
      const remote = parseUpsFile(text.slice(0, 512 * 1024));
      if (!remote.length) throw new Error('没有解析到条目');
      state.ups = { entries: mergeUps(state.ups.entries, remote), updatedAt: Date.now() };
      writeJson(KEYS.ups, state.ups);
      rebuild();
      widget?.refresh();
      return;
    } catch {
      /* 换下一个源 */
    }
  }
}

// ---- 拦截层（主路径）----
installFeedHook({
  win,
  ready: Promise.resolve(),
  getState: () => ({ settings: state.settings, hot: allEntries(), blockedUps: blockedMids() }),
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
  onCard: (card) => {
    const owner = cardOwner(card);
    if (!owner) return false;
    const blocked = blockedMids();
    if (blocked.size > 0 && blocked.has(owner.mid)) {
      hideCard(card);
      return true;
    }
    attachUpButton(card, owner, (o) => {
      addUp(o.mid, o.name);
      hideCard(card);
    });
    return false;
  },
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

// ---- 浮窗（与扩展同一套 core/widget）----
/** 油猴没有弹窗，开关和强度直接放在浮窗的展开面板里 */
function mountUi(): void {
  if (widget || !document.documentElement) return;
  widget = mountWidget({
    getSession: () => sessionHits,
    getTotal: () => state.stats.total,
    getPool: () => poolEntries().length,
    getRecords: () => state.records,
    onAllow: (record) => {
      if (!state.settings.whitelist.includes(record.biliTitle)) {
        state.settings = {
          ...state.settings,
          whitelist: [...state.settings.whitelist, record.biliTitle],
        };
        saveSettings();
      }
      state.records = state.records.filter((r) => r.biliTitle !== record.biliTitle);
      writeJson(KEYS.records, state.records);
      widget?.refresh();
    },
    settings: {
      getEnabled: () => state.settings.enabled,
      onToggle: (enabled) => {
        state.settings = { ...state.settings, enabled };
        saveSettings();
      },
      getThreshold: () => state.settings.threshold,
      onThreshold: (threshold) => {
        state.settings = { ...state.settings, threshold };
        saveSettings();
      },
      // 油猴版没有独立设置页，高级项都塞进浮窗
      getPoolInfo: () => {
        const pool = state.pool;
        if (!pool?.updatedAt) return '题库尚未同步';
        const remote = pool.remote?.count ? ` · 远端 ${pool.remote.count}` : '';
        return `题库 ${poolEntries().length} 条 · ${pool.source}${remote} · ${fmtTime(pool.updatedAt)}`;
      },
      getSeedUrl: () => state.settings.remoteSeedUrls[0] ?? '',
      onSeedUrl: (url) => {
        state.settings = { ...state.settings, remoteSeedUrls: url ? [url] : [] };
        saveSettings();
        void syncSeed(true);
      },
      getContribute: () => state.settings.contributeUps,
      onContribute: (value) => {
        state.settings = { ...state.settings, contributeUps: value };
        saveSettings();
      },
      onRefresh: () => void refreshHot(true),
      onSyncSeed: () => void syncSeed(true),
    },
  });
}

rebuild();
if (document.documentElement) mountUi();
else document.addEventListener('DOMContentLoaded', mountUi, { once: true });

if (typeof GM_registerMenuCommand === 'function') {
  GM_registerMenuCommand('打开知乎屏蔽面板', () => {
    mountUi();
    widget?.open();
  });
}

void refreshHot().then(() => syncSeed()).then(() => syncUps());
