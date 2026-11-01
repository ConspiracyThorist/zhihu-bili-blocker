import {
  DEFAULT_SETTINGS,
  KEYS,
  type HitRecord,
  type HotPool,
  type Settings,
} from '../core/types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

let settings: Settings = { ...DEFAULT_SETTINGS };
let pool: HotPool | null = null;
let records: HitRecord[] = [];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtTime(ts: number): string {
  if (!ts) return '从未成功';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? `今天 ${hm}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

function renderPool(): void {
  const info = $('#hotInfo');
  const source = $('#hotSource');
  const error = $('#hotError');
  const seedMeta = $('#seedMeta');

  const entries = pool?.entries ?? [];
  const remoteCount = entries.filter((e) => e.origin === 'remote').length;
  const localCount = entries.length - remoteCount;

  if (!entries.length) {
    info.textContent = '空';
    source.textContent = '—';
  } else {
    info.textContent = `${entries.length} 条`;
    source.textContent = `本地 ${localCount} · 远端 ${remoteCount} · ${fmtTime(pool?.updatedAt ?? 0)}`;
  }

  const remote = pool?.remote;
  if (remote?.count) {
    seedMeta.textContent = `${remote.count} 条 · ${fmtTime(remote.at)}`;
  } else if (remote?.error) {
    seedMeta.textContent = '同步失败';
  } else {
    seedMeta.textContent = settings.remoteSeedUrls.length ? '尚未同步' : '未启用';
  }

  const message = [pool?.error, remote?.error].filter(Boolean).join(' | ');
  if (message) {
    error.textContent = `上次失败：${message}`;
    error.classList.remove('hidden');
  } else {
    error.classList.add('hidden');
  }
}

function renderSettings(): void {
  ($('#toggle') as HTMLInputElement).checked = settings.enabled;
  const slider = $('#threshold') as HTMLInputElement;
  slider.value = String(settings.threshold);
  $('#thresholdValue').textContent = settings.threshold.toFixed(2);
  ($('#seedUrl') as HTMLInputElement).value = settings.remoteSeedUrls[0] ?? '';
}

function renderRecords(): void {
  const list = $('#records');
  const empty = $('#empty');
  $('#recordCount').textContent = String(records.length);
  list.textContent = '';
  empty.classList.toggle('hidden', records.length > 0);

  for (const record of records) {
    const li = document.createElement('li');

    const title = document.createElement('div');
    title.className = 'rec-title';
    title.textContent = record.biliTitle;

    const meta = document.createElement('div');
    meta.className = 'rec-meta';

    const zhihu = document.createElement('span');
    zhihu.className = 'rec-zhihu';
    zhihu.textContent = `← ${record.zhihuTitle}`;
    zhihu.title = `匹配到的知乎标题：${record.zhihuTitle}`;

    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = record.score.toFixed(2);

    const allow = document.createElement('button');
    allow.className = 'allow';
    allow.textContent = '放行';
    allow.title = '加入白名单，以后不再屏蔽这条';
    allow.addEventListener('click', () => void allowTitle(record));

    meta.append(zhihu, score, allow);
    li.append(title, meta);
    list.append(li);
  }
}

async function saveSettings(): Promise<void> {
  await chrome.storage.local.set({ [KEYS.settings]: settings });
}

async function allowTitle(record: HitRecord): Promise<void> {
  if (!settings.whitelist.includes(record.biliTitle)) {
    settings = { ...settings, whitelist: [...settings.whitelist, record.biliTitle] };
    await saveSettings();
  }
  records = records.filter(
    (r) => !(r.biliTitle === record.biliTitle && r.zhihuTitle === record.zhihuTitle),
  );
  await chrome.storage.local.set({ [KEYS.records]: records });
  renderRecords();
}

async function readState(): Promise<void> {
  const data = await chrome.storage.local.get({
    [KEYS.settings]: DEFAULT_SETTINGS,
    [KEYS.hot]: null,
    [KEYS.records]: [],
  });
  settings = { ...DEFAULT_SETTINGS, ...(data[KEYS.settings] as Partial<Settings>) };
  pool = data[KEYS.hot] as HotPool | null;
  records = (data[KEYS.records] as HitRecord[]) ?? [];
  renderSettings();
  renderPool();
  renderRecords();
}

function bind(): void {
  ($('#toggle') as HTMLInputElement).addEventListener('change', (event) => {
    settings = { ...settings, enabled: (event.target as HTMLInputElement).checked };
    void saveSettings();
  });

  const slider = $('#threshold') as HTMLInputElement;
  slider.addEventListener('input', () => {
    $('#thresholdValue').textContent = Number(slider.value).toFixed(2);
  });
  slider.addEventListener('change', () => {
    settings = { ...settings, threshold: Number(slider.value) };
    void saveSettings();
  });

  ($('#seedUrl') as HTMLInputElement).addEventListener('change', (event) => {
    const url = (event.target as HTMLInputElement).value.trim();
    settings = { ...settings, remoteSeedUrls: url ? [url] : [] };
    void saveSettings();
    renderPool();
  });

  $('#refresh').addEventListener('click', () => {
    const btn = $('#refresh') as HTMLButtonElement;
    const hint = $('#refreshHint');
    btn.disabled = true;
    hint.textContent = '请求中…';
    chrome.runtime.sendMessage({ type: 'REFRESH' }, (reply: { ok?: boolean; error?: string }) => {
      btn.disabled = false;
      hint.textContent = reply?.ok ? '已更新' : `失败：${reply?.error ?? '未知错误'}`;
      window.setTimeout(() => {
        hint.textContent = '';
      }, 3000);
      void readState();
    });
  });

  $('#syncSeed').addEventListener('click', () => {
    const btn = $('#syncSeed') as HTMLButtonElement;
    const hint = $('#seedHint');
    if (!settings.remoteSeedUrls.length) {
      hint.textContent = '先填地址';
      return;
    }
    btn.disabled = true;
    hint.textContent = '同步中…';
    chrome.runtime.sendMessage({ type: 'SYNC_SEED' }, (reply: { ok?: boolean; error?: string }) => {
      btn.disabled = false;
      hint.textContent = reply?.ok ? '已同步' : `失败：${reply?.error ?? '未知错误'}`;
      window.setTimeout(() => {
        hint.textContent = '';
      }, 3000);
      void readState();
    });
  });

  $('#clear').addEventListener('click', async () => {
    records = [];
    await chrome.storage.local.set({ [KEYS.records]: records });
    renderRecords();
  });

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') void readState();
  });
}

bind();
void readState();
