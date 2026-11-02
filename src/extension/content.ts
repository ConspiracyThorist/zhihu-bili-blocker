import { startScanner } from '../core/dom';
import { prepareHot, type HotEntry } from '../core/engine';
import { splitByFreshness, type PoolEntry } from '../core/pool';
import { mountWidget } from '../core/widget';
import {
  DEFAULT_SETTINGS,
  KEYS,
  RECORD_LIMIT,
  type HitRecord,
  type HotPool,
  type Settings,
  type Stats,
} from '../core/types';

/**
 * 隔离世界（默认 world）：负责 storage 读写、DOM 兜底层、右下角浮窗、以及与 MAIN world 的桥。
 * MAIN world 拿不到 chrome.storage，所以这里是唯一的数据源。
 */
let settings: Settings = { ...DEFAULT_SETTINGS };
let fresh: HotEntry[] = [];
let stale: HotEntry[] = [];
let records: HitRecord[] = [];
let statsTotal = 0;
let sessionHits = 0;
let flushTimer = 0;
let loaded = false;
let widget: ReturnType<typeof mountWidget> | null = null;

/** 池子按新鲜度切两段：老条目在匹配时要更高的分数 */
function rebuild(entries: PoolEntry[]): void {
  const split = splitByFreshness(entries, Date.now(), 7);
  fresh = prepareHot(split.fresh.map((e) => e.title));
  stale = prepareHot(split.stale.map((e) => e.title)).map((e) => ({ ...e, stale: true }));
}

function postState(): void {
  try {
    window.postMessage(
      {
        __zbb: 'ext',
        type: 'state',
        payload: {
          enabled: settings.enabled,
          threshold: settings.threshold,
          minLen: settings.minLen,
          whitelist: settings.whitelist,
          titles: fresh.map((entry) => entry.raw),
          staleTitles: stale.map((entry) => entry.raw),
        },
      },
      '*',
    );
  } catch {
    /* 页面导航中可能抛错，忽略 */
  }
}

function pushRecord(record: HitRecord): void {
  const dup = records.some(
    (r) => r.biliTitle === record.biliTitle && r.zhihuTitle === record.zhihuTitle,
  );
  if (!dup) {
    records.unshift(record);
    if (records.length > RECORD_LIMIT) records = records.slice(0, RECORD_LIMIT);
    sessionHits += 1;
    statsTotal += 1;
  }
  widget?.refresh();
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    void chrome.storage.local.set({
      [KEYS.records]: records,
      [KEYS.stats]: { total: statsTotal },
    });
  }, 300);
}

function applySettings(next: Partial<Settings>): void {
  const wasEnabled = settings.enabled;
  settings = { ...DEFAULT_SETTINGS, ...next };
  if (wasEnabled && !settings.enabled) {
    // 关掉总开关时把已隐藏的卡片放出来，而不是让它们留到下次刷新
    document.querySelectorAll('[data-zbb="1"]').forEach((el) => el.removeAttribute('data-zbb'));
  }
  postState();
}

/** 兼容 v1（titles: string[]）与 v2（entries: PoolEntry[]）两种结构 */
function entriesOf(value: unknown): PoolEntry[] {
  const pool = value as HotPool & { titles?: string[] };
  if (pool && Array.isArray(pool.entries)) return pool.entries;
  if (pool && Array.isArray(pool.titles)) {
    const at = pool.updatedAt || Date.now();
    return pool.titles.map((title) => ({ title, firstSeen: at, lastSeen: at, origin: 'hot' as const }));
  }
  return [];
}

async function load(): Promise<void> {
  const data = await chrome.storage.local.get({
    [KEYS.settings]: DEFAULT_SETTINGS,
    [KEYS.hot]: null,
    [KEYS.records]: [],
    [KEYS.stats]: { total: 0 },
  });

  settings = { ...DEFAULT_SETTINGS, ...(data[KEYS.settings] as Partial<Settings>) };
  rebuild(entriesOf(data[KEYS.hot]));
  records = (data[KEYS.records] as HitRecord[]) ?? [];
  statsTotal = (data[KEYS.stats] as Stats | undefined)?.total ?? 0;
  loaded = true;
  postState();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[KEYS.settings]) {
    applySettings((changes[KEYS.settings].newValue as Partial<Settings>) ?? {});
  }
  if (changes[KEYS.hot]) {
    rebuild(entriesOf(changes[KEYS.hot].newValue));
    postState();
  }
  if (changes[KEYS.records]) {
    records = (changes[KEYS.records].newValue as HitRecord[]) ?? records;
  }
});

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { __zbb?: string; type?: string; payload?: HitRecord } | null;
  if (!data || data.__zbb !== 'page') return;
  if (data.type === 'ready') {
    // 还没读完 storage 就先别回空列表，等 load 完成后它会主动 postState
    if (loaded) postState();
  } else if (data.type === 'hit' && data.payload) {
    pushRecord(data.payload);
  }
});

const scanner = startScanner({
  settings: () => settings,
  hot: () => [...fresh, ...stale],
  onHit: (biliTitle, result) => {
    pushRecord({
      biliTitle,
      zhihuTitle: result.zhihuTitle,
      score: result.score,
      reason: result.reason === 'none' ? 'dice' : result.reason,
      layer: 'dom',
      at: Date.now(),
    });
  },
});

void load().then(() => {
  // 列表到达时可能已经有卡片渲染出来了，补扫一遍，别等到下一个定时周期
  scanner.scan();
  widget?.refresh();
});

/** 右下角浮窗：只显示「已拦截 / 累计」，点开才看最近 5 条 */
function mountUi(): void {
  if (widget || !document.documentElement) return;
  widget = mountWidget({
    getSession: () => sessionHits,
    getTotal: () => statsTotal,
    getPool: () => fresh.length + stale.length,
    getRecords: () => records,
    onAllow: (record) => {
      const next: Settings = {
        ...settings,
        whitelist: [...settings.whitelist, record.biliTitle],
      };
      settings = next;
      records = records.filter((r) => r.biliTitle !== record.biliTitle);
      void chrome.storage.local.set({ [KEYS.settings]: next, [KEYS.records]: records });
      postState();
      widget?.refresh();
    },
    onOpenSettings: () => {
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_PANEL' });
      } catch {
        /* 扩展上下文失效（比如被重载）时忽略 */
      }
    },
  });
}

if (document.documentElement) mountUi();
else document.addEventListener('DOMContentLoaded', mountUi, { once: true });
