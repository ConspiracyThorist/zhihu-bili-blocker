/**
 * 给 UI 截图：弹窗 + 页面浮窗。
 * 需要能启动 Chrome 的会话（沙箱里跑不了）。
 *
 * 用法：node tests/screenshot.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = join(root, '.test-tmp');
const outDir = join(root, 'reports', 'screenshots');
const extDir = join(root, 'dist', 'extension');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9444;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>b</title>
<style>
body{margin:0;background:#18191c;color:#e8eaed;font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:24px}
.card{background:#212226;border-radius:8px;overflow:hidden}
.thumb{height:96px;background:linear-gradient(135deg,#2b2d33,#3a3d45)}
.info{padding:10px}
h3{margin:0;font-size:13px;font-weight:500;line-height:1.4}
.meta{margin-top:6px;color:#8b929e;font-size:11px}
</style></head><body>
<div class="grid" id="grid"></div>
<script>
const titles = [
  '【搬运】如何看待「AI 取代程序员」的说法？',
  '【原神】4.2 版本全角色配队思路',
  '四千元冰柜被「仅退款」，商家跨千里发现商品仍在使用',
  '语言学中有哪些类似「哈基米」的现象？',
  '为什么现在的年轻人不愿意结婚了？',
  'S16 瑞士轮 BLG 2:0 淘汰 HLE 晋级八强',
  '古代穷人为什么不搬到海边去？',
  '【开箱】新买的机械键盘'
];
const grid = document.getElementById('grid');
for (const t of titles) {
  const el = document.createElement('div');
  el.className = 'bili-video-card';
  el.innerHTML = '<div class="thumb"></div><div class="info"><h3 class="bili-video-card__info--tit"></h3><div class="meta">bilibili · 昨天</div></div>';
  el.querySelector('h3').textContent = t;
  grid.append(el);
}
fetch('/x/web-interface/wbi/index/top/feed/rcmd?w_rid=t&wts=1').then(r=>r.json()).then(j=>{window.__net={count:j.data.item.length}}).catch(()=>{});
</script></body></html>`;

async function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (onEvent) onEvent(m);
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}

const httpJson = async (u) => (await fetch(u)).json();

async function waitFor(read, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`超时：${label}`);
    await sleep(250);
  }
}

async function main() {
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--enable-unsafe-extension-debugging',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${join(tmp, 'profile')}`,
      `--remote-debugging-port=${PORT}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const version = await waitFor(() => httpJson(`http://127.0.0.1:${PORT}/json/version`).catch(() => null), 20000, 'devtools');
    const browser = await connect(version.webSocketDebuggerUrl);
    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: extDir });
    await sleep(2500);

    // 造一份接近真实的数据
    const sw = await waitFor(async () => {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => []);
      return list.find((t) => t.type === 'service_worker' && t.url.includes('background.js')) ?? null;
    }, 20000, 'sw');
    const swCdp = await connect(sw.webSocketDebuggerUrl);

    const now = Date.now();
    const titles = [
      '如何看待「AI 取代程序员」的说法？',
      '四千元的冰柜被「仅退款」，买家称已销毁，商家跨千里发现商品仍在使用',
      '语言学中有哪些类似「哈基米」的现象？',
      '为什么现在的年轻人不愿意结婚了？',
    ];
    const entries = Array.from({ length: 314 }, (_, i) => ({
      title: titles[i % titles.length] + (i >= titles.length ? `（样本${i}）` : ''),
      firstSeen: now,
      lastSeen: now,
      origin: i % 5 === 0 ? 'remote' : 'hot',
    }));
    const records = [
      { biliTitle: '【搬运】如何看待「AI 取代程序员」的说法？', zhihuTitle: titles[0], score: 0.83, reason: 'cover', layer: 'net', at: now },
      { biliTitle: '四千元冰柜被仅退款，商家跨千里发现商品仍在使用', zhihuTitle: titles[1], score: 0.9, reason: 'cover', layer: 'net', at: now - 60000 },
    ];
    await swCdp.send('Runtime.evaluate', {
      expression: `chrome.storage.local.set(${JSON.stringify({
        'zbb:hot': { entries, updatedAt: now, source: '知乎热榜', error: '', remote: { at: now, count: 63, error: '' } },
        'zbb:records': records,
        'zbb:stats': { total: 128 },
        'zbb:settings': {
          enabled: true, threshold: 0.72, minLen: 8, whitelist: [], refreshMinutes: 45,
          remoteSeedUrls: ['https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/seed.txt'],
          poolDays: 30, poolMax: 800, rsshub: '',
        },
      })})`,
      awaitPromise: true,
    });

    // 1) 弹窗
    const popupTarget = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const popup = await waitFor(async () => {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => []);
      return list.find((t) => t.id === popupTarget.targetId) ?? null;
    }, 10000, 'popup');
    const popupCdp = await connect(popup.webSocketDebuggerUrl);
    await popupCdp.send('Emulation.setDeviceMetricsOverride', {
      width: 340, height: 620, deviceScaleFactor: 2, mobile: false,
    });
    await sleep(1200);
    const shot1 = await popupCdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(outDir, 'popup.png'), Buffer.from(shot1.data, 'base64'));
    console.log('✓ dist/screenshots/popup.png');
    popupCdp.close();

    // 2) 页面 + 浮窗
    const pageTarget = (await httpJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page');
    let pageRef = null;
    const page = await connect(pageTarget.webSocketDebuggerUrl, (msg) => {
      if (msg.method !== 'Fetch.requestPaused') return;
      const { requestId } = msg.params;
      const url = new URL(msg.params.request.url);
      const fulfill = (code, type, body) =>
        pageRef
          .send('Fetch.fulfillRequest', {
            requestId,
            responseCode: code,
            responseHeaders: [{ name: 'content-type', value: type }],
            body: Buffer.from(body, 'utf8').toString('base64'),
          })
          .catch(() => undefined);
      if (url.pathname === '/' || url.pathname === '/index.html') return void fulfill(200, 'text/html; charset=utf-8', PAGE);
      if (url.pathname.includes('/feed/rcmd')) {
        return void fulfill(200, 'application/json; charset=utf-8', JSON.stringify({
          code: 0,
          data: { item: [{ id: 1, bvid: 'BV1', goto: 'av', title: '【搬运】如何看待「AI 取代程序员」的说法？' }] },
        }));
      }
      return void fulfill(404, 'text/plain', 'x');
    });
    pageRef = page;
    await page.send('Page.enable');
    await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.bilibili.com/*', requestStage: 'Request' }] });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 640, deviceScaleFactor: 2, mobile: false });
    await page.send('Page.navigate', { url: 'https://www.bilibili.com/' });
    await sleep(3500);
    const shot2 = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(outDir, 'page.png'), Buffer.from(shot2.data, 'base64'));
    console.log('✓ dist/screenshots/page.png');

    // 展开浮窗面板，截一张带「设置」入口的
    await page.send('Runtime.evaluate', {
      expression: `(function(){ const h=document.getElementById('zbb-widget'); h && h.shadowRoot && h.shadowRoot.querySelector('.pill').click(); })()`,
    });
    await sleep(600);
    const shot3 = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(outDir, 'panel.png'), Buffer.from(shot3.data, 'base64'));
    console.log('✓ dist/screenshots/panel.png');

    page.close();
    swCdp.close();
    browser.close();
  } finally {
    chrome.kill();
  }

  await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

main().catch(async (err) => {
  console.error('截图失败：', err.message);
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
