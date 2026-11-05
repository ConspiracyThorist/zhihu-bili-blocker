import { parseRss, pickTitles } from '../core/hotparse';
import { mergePool, parseSeed, prunePool, replaceOrigin, type PoolEntry } from '../core/pool';
import { mergeUps, parseUpsFile, type UpEntry } from '../core/ups';
import {
  DEFAULT_SETTINGS,
  FETCH_TIMEOUT_MS,
  KEYS,
  type HotPool,
  type Settings,
} from '../core/types';

const ALARM_REFRESH = 'zbb:refresh';
const ALARM_SEED = 'zbb:seed';
const ALARM_UPS = 'zbb:ups';
/** 知乎接口实测不校验 UA，但带上真实 UA 更稳妥，也便于日后排查 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/** 远端种子文件最大读取量，防止被塞一个巨大文件拖垮匹配 */
const REMOTE_MAX_BYTES = 512 * 1024;

interface Source {
  name: string;
  url: string;
  credentials?: RequestCredentials;
  kind?: 'json' | 'rss';
}

function buildSources(settings: Settings): Source[] {
  const sources: Source[] = [
    { name: '知乎热榜', url: 'https://api.zhihu.com/topstory/hot-list?limit=50&reverse_order=0' },
    {
      name: '知乎热榜(登录态)',
      url: 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50',
      credentials: 'include',
    },
  ];
  const rsshub = settings.rsshub.trim().replace(/\/+$/, '');
  if (rsshub) sources.push({ name: 'RSSHub', url: `${rsshub}/zhihu/hotlist`, kind: 'rss' });
  return sources;
}

async function fetchTitles(source: Source): Promise<string[]> {
  const res = await fetch(source.url, {
    credentials: source.credentials ?? 'omit',
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': UA,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return source.kind === 'rss' ? parseRss(text) : pickTitles(JSON.parse(text));
}

async function getSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get({ [KEYS.settings]: DEFAULT_SETTINGS });
  return { ...DEFAULT_SETTINGS, ...(data[KEYS.settings] as Partial<Settings>) };
}

/** 兼容 v1 结构（titles: string[]）：老用户升级不用重装 */
async function getPool(): Promise<HotPool> {
  const raw = (await chrome.storage.local.get(KEYS.hot))[KEYS.hot] as
    | HotPool
    | { titles?: string[]; updatedAt?: number; source?: string; error?: string }
    | undefined;

  if (!raw) return { entries: [], updatedAt: 0, source: 'none', error: '' };
  if ('entries' in raw && Array.isArray((raw as HotPool).entries)) return raw as HotPool;

  const legacy = raw as { titles?: string[]; updatedAt?: number; source?: string; error?: string };
  const at = legacy.updatedAt || Date.now();
  const entries: PoolEntry[] = (legacy.titles ?? []).map((title) => ({
    title,
    firstSeen: at,
    lastSeen: at,
    origin: 'hot' as const,
  }));
  return { entries, updatedAt: at, source: legacy.source ?? 'migrated', error: legacy.error ?? '' };
}

async function savePool(pool: HotPool): Promise<void> {
  await chrome.storage.local.set({ [KEYS.hot]: pool });
}

/** 热榜刷新：拉到的标题并入池子，不覆盖历史 */
async function refresh(): Promise<HotPool> {
  const settings = await getSettings();
  const pool = await getPool();
  const errors: string[] = [];

  for (const source of buildSources(settings)) {
    try {
      const titles = await fetchTitles(source);
      if (titles.length < 5) {
        errors.push(`${source.name}: 只拿到 ${titles.length} 条`);
        continue;
      }
      const now = Date.now();
      const merged = mergePool(
        pool.entries,
        titles.map((title) => ({ title, origin: 'hot' as const })),
        now,
      );
      const next: HotPool = {
        ...pool,
        entries: prunePool(merged, now, { maxAgeDays: settings.poolDays, maxEntries: settings.poolMax }),
        updatedAt: now,
        source: source.name,
        error: '',
      };
      await savePool(next);
      return next;
    } catch (err) {
      errors.push(`${source.name}: ${(err as Error).message}`);
    }
  }

  // 全挂：保留旧池，只记录原因，popup 会显示"上次成功时间"
  const stale: HotPool = { ...pool, error: errors.join(' | ') };
  await savePool(stale);
  return stale;
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * 远端题库同步：整批替换 remote 条目，多源按序尝试。
 * 远端列表是权威的——作者删掉的条目，用户端下次同步就该消失。
 */
async function syncSeed(): Promise<HotPool> {
  const settings = await getSettings();
  const pool = await getPool();
  const urls = (settings.remoteSeedUrls ?? []).filter(Boolean);
  if (urls.length === 0) return pool;

  const errors: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'text/plain, */*', 'user-agent': UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = (await res.text()).slice(0, REMOTE_MAX_BYTES);
      const titles = parseSeed(text);
      if (titles.length < 10) throw new Error(`只解析到 ${titles.length} 条`);

      const now = Date.now();
      const withRemote = replaceOrigin(pool.entries, 'remote', titles, now);
      const next: HotPool = {
        ...pool,
        entries: prunePool(withRemote, now, { maxAgeDays: settings.poolDays, maxEntries: settings.poolMax }),
        remote: { at: now, count: titles.length, error: '' },
      };
      await savePool(next);
      return next;
    } catch (err) {
      errors.push(`${shortHost(url)}: ${(err as Error).message}`);
    }
  }

  const next: HotPool = {
    ...pool,
    remote: { ...(pool.remote ?? { at: 0, count: 0, error: '' }), error: errors.join(' | ') },
  };
  await savePool(next);
  return next;
}

/**
 * 同步远端 UP 库。auto 条目整批替换，本地 manual 条目保留。
 * 拉不到就沿用旧库，不阻塞。
 */
async function syncUps(): Promise<UpEntry[]> {
  const settings = await getSettings();
  const stored = (await chrome.storage.local.get(KEYS.ups))[KEYS.ups] as
    | { entries: UpEntry[]; updatedAt: number; error?: string }
    | undefined;
  const current = stored?.entries ?? [];
  const urls = (settings.remoteUpsUrls ?? []).filter(Boolean);
  if (urls.length === 0) return current;

  const errors: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = (await res.text()).slice(0, REMOTE_MAX_BYTES);
      const remote = parseUpsFile(text);
      if (remote.length === 0) throw new Error('没有解析到条目');

      const merged = mergeUps(current, remote);
      await chrome.storage.local.set({
        [KEYS.ups]: { entries: merged, updatedAt: Date.now(), error: '' },
      });
      return merged;
    } catch (err) {
      errors.push(`${shortHost(url)}: ${(err as Error).message}`);
    }
  }

  await chrome.storage.local.set({
    [KEYS.ups]: { entries: current, updatedAt: stored?.updatedAt ?? 0, error: errors.join(' | ') },
  });
  return current;
}

/**
 * 打开侧边栏。sidePanel.open() 要求用户手势，从内容脚本的消息里调用是允许的；
 * 万一被拒（老版本或策略限制），退回一个独立的小窗口，行为上等价。
 */async function openPanel(windowId?: number): Promise<boolean> {
  try {
    if (windowId !== undefined && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId });
      return true;
    }
  } catch {
    /* 继续走兜底 */
  }
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: 380,
      height: 680,
    });
    return true;
  } catch {
    return false;
  }
}

/** 刷新间隔可由 settings.refreshMinutes 覆盖（测试要把 45 分钟压到 1 分钟） */
async function ensureAlarms(): Promise<void> {
  const settings = await getSettings();

  const period = Math.min(Math.max(settings.refreshMinutes, 0.5), 1440);
  const refreshAlarm = await chrome.alarms.get(ALARM_REFRESH);
  if (Math.abs((refreshAlarm?.periodInMinutes ?? 0) - period) > 0.01) {
    await chrome.alarms.create(ALARM_REFRESH, {
      delayInMinutes: Math.min(period, 1),
      periodInMinutes: period,
    });
  }

  const seedAlarm = await chrome.alarms.get(ALARM_SEED);
  if (!seedAlarm) {
    await chrome.alarms.create(ALARM_SEED, { delayInMinutes: 2, periodInMinutes: 24 * 60 });
  }

  const upsAlarm = await chrome.alarms.get(ALARM_UPS);
  if (!upsAlarm) {
    await chrome.alarms.create(ALARM_UPS, { delayInMinutes: 5, periodInMinutes: 24 * 60 });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarms();
  void chrome.storage.local.get(KEYS.settings).then((data) => {
    if (!data[KEYS.settings]) {
      void chrome.storage.local.set({ [KEYS.settings]: DEFAULT_SETTINGS });
    }
  });
  void refresh().then(() => syncSeed());
  void syncUps();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureAlarms();
  void refresh();
  void syncSeed();
  void syncUps();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_REFRESH) void refresh();
  if (alarm.name === ALARM_SEED) void syncSeed();
  if (alarm.name === ALARM_UPS) void syncUps();
});

chrome.runtime.onMessage.addListener(
  (message: { type?: string }, sender, sendResponse) => {
    if (message?.type === 'OPEN_PANEL') {
      openPanel(sender.tab?.windowId)
        .then((ok) => sendResponse({ ok }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message?.type === 'REFRESH') {
    refresh()
      .then((pool) => sendResponse({ ok: true, pool }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'SYNC_SEED') {
    syncSeed()
      .then((pool) => sendResponse({ ok: !pool.remote?.error, pool }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'SYNC_UPS') {
    syncUps()
      .then((entries) => sendResponse({ ok: true, entries }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === 'GET_STATE') {
    chrome.storage.local
      .get({ [KEYS.settings]: DEFAULT_SETTINGS, [KEYS.hot]: null, [KEYS.records]: [] })
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  return false;
});

// 刷新间隔或题库源改了要重新排定时器
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[KEYS.settings]) void ensureAlarms();
});

void ensureAlarms();
