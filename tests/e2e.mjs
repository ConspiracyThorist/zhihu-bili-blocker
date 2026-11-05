import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 真实浏览器端到端（headless Chrome + CDP）。
 *
 * 用 CDP 的 Fetch 域在协议层伪造 www.bilibili.com 的响应，
 * 不依赖 DNS / TLS / 本地服务器——之前用 host-resolver-rules 的方式
 * 会因为系统代理或真站可达而失效。
 *
 * 覆盖：manifest 的 MAIN world 注入、storage→postMessage 桥、fetch hook 剪枝、
 * DOM 兜底与防留白、开关语义、401 降级、popup 渲染、定时器配置、远端题库同步。
 *
 * 需要能正常启动 Chrome 的会话（沙箱内 Chrome 会因命名管道被拒而自杀）。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = join(root, '.test-tmp');
const extDir = join(root, 'dist', 'extension');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9333;

const HOT_TITLES = [
  '如何看待「AI 取代程序员」的说法？',
  '四千元的冰柜被「仅退款」，买家称已销毁，商家跨千里发现商品仍在使用，买卖双方各执一词，责任该如何认定？',
];

const BASE_SETTINGS = {
  enabled: true,
  threshold: 0.72,
  minLen: 8,
  whitelist: [],
  refreshMinutes: 45,
  remoteSeedUrls: [],
  poolDays: 30,
  poolMax: 800,
  rsshub: '',
};

function feedBody() {
  return {
    code: 0,
    data: {
      item: [
        { id: 1, bvid: 'BV1', goto: 'av', title: '【搬运】如何看待「AI 取代程序员」的说法？' },
        { id: 2, bvid: 'BV2', goto: 'av', title: '【原神】4.2 版本全角色配队思路', owner: { mid: 7001, name: '搬运UP' } },
        { id: 3, bvid: 'BV3', goto: 'av', title: '四千元冰柜被「仅退款」，商家跨千里发现商品仍在使用' },
      ],
    },
  };
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>e2e</title></head>
<body>
  <div id="cards">
    <div class="bili-video-card"><h3 class="bili-video-card__info--tit">【搬运】如何看待「AI 取代程序员」的说法？</h3></div>
    <div class="bili-video-card"><h3 class="bili-video-card__info--tit">【原神】4.2 版本全角色配队思路</h3><a href="https://space.bilibili.com/7001"><span class="bili-video-card__info--author">搬运UP</span></a></div>
    <div class="cell"><div class="bili-video-card"><h3 class="bili-video-card__info--tit">四千元冰柜被「仅退款」，商家跨千里发现商品仍在使用</h3></div></div>
  </div>
  <script>
    window.__fetchNative = window.fetch.toString().indexOf('native code') >= 0;
    window.__net = null;
    var fail = new URLSearchParams(location.search).get('mode') === 'fail';
    fetch('/x/web-interface/wbi/index/top/feed/rcmd?w_rid=t&wts=1' + (fail ? '&mode=fail' : ''))
      .then(function (r) {
        window.__status = r.status;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        window.__net = { count: j.data.item.length, titles: j.data.item.map(function (i) { return i.title; }) };
      })
      .catch(function (e) { window.__net = { error: String(e) }; });
  </script>
</body></html>`;

const SEED_LINES = ['# e2e seed', ...Array.from({ length: 12 }, (_, i) => `远端题库样本第${i + 1}条`)];

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function connect(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (onEvent) {
      onEvent(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function waitFor(read, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new Error(detail.exception?.description || detail.text || 'evaluate 失败');
  }
  return result.result.value;
}

function launchChrome(headlessFlag, profile) {
  // Chrome 137+ 起 --load-extension 对正式版不再生效，改走 CDP 的 Extensions.loadUnpacked，
  // 但必须先带 --enable-unsafe-extension-debugging 启动。
  return spawn(
    CHROME,
    [
      headlessFlag,
      '--enable-unsafe-extension-debugging',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}

/** 在协议层伪造 bilibili 的响应 */
function installRoute(player) {
  return async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    const url = new URL(request.url);
    const fulfill = (status, contentType, body) =>
      player()
        .send('Fetch.fulfillRequest', {
          requestId,
          responseCode: status,
          responseHeaders: [{ name: 'content-type', value: contentType }],
          body: Buffer.from(body, 'utf8').toString('base64'),
        })
        .catch(() => undefined);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      await fulfill(200, 'text/html; charset=utf-8', PAGE);
      return;
    }
    if (url.pathname.includes('/feed/rcmd')) {
      if (url.searchParams.get('mode') === 'fail') {
        await fulfill(401, 'application/json; charset=utf-8', '{"error":"unauthorized"}');
        return;
      }
      await fulfill(200, 'application/json; charset=utf-8', JSON.stringify(feedBody()));
      return;
    }
    if (url.pathname === '/seed.txt') {
      await fulfill(200, 'text/plain; charset=utf-8', SEED_LINES.join('\n'));
      return;
    }
    await fulfill(404, 'text/plain; charset=utf-8', 'not found');
  };
}

/** 上一轮的 Chrome 可能还没退干净，直接删会 EBUSY；重试几次再放弃 */
async function removeWithRetry(dir, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(500);
    }
  }
  console.warn(`  ! 清理失败（不影响结果）：${dir}`);
}

async function main() {
  // 用带时间戳的子目录，避免和上一轮残留的 profile 撞车
  const runDir = join(tmp, `run-${Date.now()}`);
  await mkdir(runDir, { recursive: true });

  const profile = join(runDir, 'profile');
  let chrome = launchChrome('--headless=new', profile);

  let failures = 0;
  const check = (cond, label, detail = '') => {
    if (cond) console.log(`  ✓ ${label}`);
    else {
      failures += 1;
      console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    }
  };

  try {
    console.log('端到端（headless Chrome + CDP Fetch 拦截）');
    const version = await waitFor(
      () => httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`).catch(() => null),
      20_000,
      'Chrome DevTools',
    );
    console.log(`  Chrome ${version.Browser}`);

    const browserCdp = await connect(version.webSocketDebuggerUrl);
    const loaded = await browserCdp.send('Extensions.loadUnpacked', { path: extDir });
    const extId = loaded.id;
    check(Boolean(extId), `扩展加载成功（id ${extId}）`);

    // 等 onInstalled 触发的首次刷新跑完，避免覆盖注入的测试数据
    await sleep(3000);

    const sw = await waitFor(
      async () => {
        const list = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`).catch(() => []);
        return list.find((t) => t.type === 'service_worker' && t.url.includes(loaded.id)) ?? null;
      },
      25_000,
      '扩展 service worker',
    );
    check(Boolean(sw), 'service worker 已启动');

    const swCdp = await connect(sw.webSocketDebuggerUrl, (msg) => {
      void installRoute(() => swCdpRef)(msg);
      if (msg.method === 'Runtime.exceptionThrown') {
        console.log('  [sw exception]', JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
      }
    });
    await swCdp.send('Runtime.enable');
    let swCdpRef = null;
    swCdpRef = swCdp;
    // Service Worker 自己也要发请求（远端种子），所以拦截器必须挂到它身上
    await swCdp.send('Fetch.enable', {
      patterns: [{ urlPattern: 'https://www.bilibili.com/*', requestStage: 'Request' }],
    });

    const now = Date.now();
    const writeState = (settings, entries) =>
      evaluate(
        swCdp,
        `chrome.storage.local.set(${JSON.stringify({
          'zbb:hot': entries ?? {
            entries: HOT_TITLES.map((title) => ({ title, firstSeen: now, lastSeen: now, origin: 'hot' })),
            updatedAt: now,
            source: 'e2e',
            error: '',
          },
          'zbb:settings': settings,
        })}).then(function(){ return 'ok'; })`,
      );
    await writeState(BASE_SETTINGS);

    const pageTarget = (await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).find((t) => t.type === 'page');
    let pageCdpRef = null;
    const pageCdp = await connect(pageTarget.webSocketDebuggerUrl, (msg) => {
      void installRoute(() => pageCdpRef)(msg);
      if (msg.method === 'Runtime.exceptionThrown') {
        console.log('  [page exception]', JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
      }
    });
    pageCdpRef = pageCdp;

    await pageCdp.send('Page.enable');
    await pageCdp.send('Runtime.enable');
    await pageCdp.send('Fetch.enable', {
      patterns: [{ urlPattern: 'https://www.bilibili.com/*', requestStage: 'Request' }],
    });

    // ---- 1) 拦截层 + DOM 兜底 ----
    await pageCdp.send('Page.navigate', { url: 'https://www.bilibili.com/' });
    await waitFor(
      async () => {
        try {
          return await evaluate(pageCdp, 'window.__net');
        } catch {
          return null;
        }
      },
      12_000,
      '页面 __net',
    ).catch(() => null);
    await sleep(300);

    const net = JSON.parse((await evaluate(pageCdp, 'JSON.stringify(window.__net)')) || 'null');
    check(Boolean(net), '页面脚本执行完成（能读到 __net）');
    check(net && net.count === 1, '拦截层：feed 3 条被摘到 1 条', `实际 ${net?.count}`);
    check(net && net.titles?.[0]?.includes('原神'), '拦截层：留下的是无关视频', JSON.stringify(net?.titles));

    const dom = JSON.parse(
      (await evaluate(
        pageCdp,
        `JSON.stringify({
          cards: Array.from(document.querySelectorAll('.bili-video-card')).map(function (el) {
            return el.getAttribute('data-zbb') === '1';
          }),
          cell: document.querySelector('.cell').getAttribute('data-zbb') === '1'
        })`,
      )) || '{}',
    );
    check(dom.cards?.length === 3, 'DOM：页面有 3 张卡片');
    check(dom.cards?.[0] === true, 'DOM 兜底：搬运卡片被隐藏');
    check(dom.cards?.[1] === false, 'DOM 兜底：无关卡片保持可见');
    check(dom.cell === true, 'DOM 兜底：标记打在最外层网格单元（防留白）');

    const widget = JSON.parse(
      (await evaluate(
        pageCdp,
        `JSON.stringify((function () {
          const host = document.getElementById('zbb-widget');
          if (!host || !host.shadowRoot) return { ok: false };
          const pill = host.shadowRoot.querySelector('.pill');
          return { ok: true, text: (pill && pill.textContent) || '' };
        })())`,
      )) || '{}',
    );
    check(widget.ok === true, '浮窗：已挂载到页面');
    check(
      String(widget.text ?? '').includes('已拦截') && String(widget.text ?? '').includes('累计'),
      '浮窗：显示「已拦截 / 累计」两个数',
      widget.text,
    );
    check(/已拦截\s*2/.test(String(widget.text ?? '')), '浮窗：本次拦截数已计入', widget.text);

    // 侧边栏入口：SW 里必须有 sidePanel API，浮窗面板里必须有对应按钮
    const sidePanelApi = await evaluate(
      swCdp,
      `String(typeof (chrome.sidePanel && chrome.sidePanel.open))`,
    );
    check(sidePanelApi === 'function', '侧边栏：service worker 拿到 sidePanel.open', sidePanelApi);

    const settingsBtn = JSON.parse(
      (await evaluate(
        pageCdp,
        `JSON.stringify((function () {
          const host = document.getElementById('zbb-widget');
          const pill = host.shadowRoot.querySelector('.pill');
          pill.click();
          const btn = host.shadowRoot.querySelector('.open-panel');
          return { found: !!btn, text: (btn && btn.textContent) || '' };
        })())`,
      )) || '{}',
    );
    check(settingsBtn.found === true, '侧边栏：浮窗面板里有「设置」入口', settingsBtn.text);

    const clicked = await evaluate(
      pageCdp,
      `(function () {
        const host = document.getElementById('zbb-widget');
        const btn = host.shadowRoot.querySelector('.open-panel');
        btn.click();
        return 'ok';
      })()`,
    );
    check(clicked === 'ok', '侧边栏：点击设置不抛错');

    const hasAdv = await evaluate(
      pageCdp,
      `(function () {
        const host = document.getElementById('zbb-widget');
        return String(!!host.shadowRoot.querySelector('.adv'));
      })()`,
    );
    check(hasAdv === 'false', '浮窗：扩展版不渲染油猴专属的「高级设置」', hasAdv);

    const drag = JSON.parse(
      (await evaluate(
        pageCdp,
        `JSON.stringify((function () {
          const host = document.getElementById('zbb-widget');
          const pill = host.shadowRoot.querySelector('.pill');
          const before = pill.getBoundingClientRect();
          const base = { bubbles: true, composed: true, pointerId: 1, button: 0, isPrimary: true };
          pill.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: before.left + 8, clientY: before.top + 8 }));
          pill.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: 140, clientY: 220 }));
          pill.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: 140, clientY: 220 }));
          const after = pill.getBoundingClientRect();
          return {
            startTop: Math.round(before.top),
            viewportH: window.innerHeight,
            moved: Math.abs(after.left - before.left) > 30 || Math.abs(after.top - before.top) > 30,
            left: Math.round(after.left),
            top: Math.round(after.top),
            saved: !!localStorage.getItem('zbb:widget-pos')
          };
        })())`,
      )) || '{}',
    );
    check(
      drag.startTop < drag.viewportH * 0.7,
      '浮窗：初始位置在右侧中部而非底部',
      `top=${drag.startTop}/${drag.viewportH}`,
    );
    check(drag.moved === true, '浮窗：可拖动', `left=${drag.left} top=${drag.top}`);
    check(drag.saved === true, '浮窗：拖动后位置已记住');

    await sleep(700);
    const records = JSON.parse(
      (await evaluate(
        swCdp,
        `chrome.storage.local.get('zbb:records').then(function(d){ return JSON.stringify(d['zbb:records'] || []); })`,
      )) || '[]',
    );
    check(records.length === 2, '记录：命中 2 条写入 storage', `实际 ${records.length}`);
    check(records.every((r) => typeof r.score === 'number' && r.zhihuTitle), '记录：带分数与对应知乎标题');

    // ---- 2) 开关关闭 ----
    await writeState({ ...BASE_SETTINGS, enabled: false });
    await pageCdp.send('Page.navigate', { url: 'https://www.bilibili.com/' });
    await sleep(3000);
    const netOff = JSON.parse((await evaluate(pageCdp, 'JSON.stringify(window.__net)')) || 'null');
    check(netOff?.count === 3, '开关关闭：feed 3 条原样返回', `实际 ${netOff?.count}`);
    const marksOff = JSON.parse(
      (await evaluate(pageCdp, `JSON.stringify(Array.from(document.querySelectorAll('[data-zbb="1"]')).length)`)) || '0',
    );
    check(marksOff === 0, '开关关闭：页面上没有任何隐藏标记', `实际 ${marksOff}`);

    // ---- 3) 401 降级 ----
    await writeState({ ...BASE_SETTINGS, refreshMinutes: 1 });
    await pageCdp.send('Page.navigate', { url: 'https://www.bilibili.com/?mode=fail' });
    await sleep(3000);
    const netFail = JSON.parse((await evaluate(pageCdp, 'JSON.stringify(window.__net)')) || 'null');
    const status = await evaluate(pageCdp, 'window.__status');
    check(status === 401, '降级：页面确实收到了 401', `实际 ${status}`);
    check(Boolean(netFail?.error), '降级：错误被页面捕获（未白屏）', JSON.stringify(netFail));
    const bodyLen = await evaluate(pageCdp, 'document.body.textContent.length');
    check(bodyLen > 10, '降级：页面内容仍然渲染', `body 文本长度 ${bodyLen}`);

    // ---- 4) popup ----
    const created = await browserCdp.send('Target.createTarget', {
      url: `chrome-extension://${extId}/popup.html`,
    });
    const popupTarget = await waitFor(
      async () => {
        const list = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`).catch(() => []);
        return list.find((t) => t.id === created.targetId) ?? null;
      },
      10_000,
      'popup 页面',
    );
    const popupCdp = await connect(popupTarget.webSocketDebuggerUrl);
    await sleep(1200);

    const popup = JSON.parse(
      (await evaluate(
        popupCdp,
        `JSON.stringify({
          hot: document.querySelector('#hotInfo').textContent,
          threshold: document.querySelector('#threshold').value,
          toggle: document.querySelector('#toggle').checked,
          records: document.querySelectorAll('#records li').length,
          source: document.querySelector('#hotSource').textContent
        })`,
      )) || '{}',
    );
    check(popup.hot?.includes('条'), 'popup：题库条数已渲染', popup.hot);
    check(popup.threshold === '0.72', 'popup：阈值渲染为 0.72', popup.threshold);
    check(popup.toggle === true, 'popup：总开关与存储一致');

    // ---- UP 库 ----
    const upBtn = await evaluate(
      pageCdp,
      `(function () {
        const btn = document.querySelector('[data-zbb-up]');
        return btn ? btn.textContent : '';
      })()`,
    );
    check(String(upBtn).includes('屏蔽此 UP'), 'UP 库：卡片上出现「屏蔽此 UP」按钮', String(upBtn));

    // 加进 UP 库之前：标题匹配掉 2 条，只剩原神那条
    const beforeUp = await evaluate(
      pageCdp,
      `(async () => {
        const r = await fetch('/x/web-interface/wbi/index/top/feed/rcmd?w_rid=t&wts=8');
        const j = await r.json();
        return String(j.data.item.length);
      })()`,
    );
    check(Number(beforeUp) === 1, 'UP 库：加库之前剩 1 条（标题匹配结果）', String(beforeUp));

    await evaluate(
      swCdp,
      `(async () => {
        const cur = await chrome.storage.local.get('zbb:ups');
        const entries = (cur['zbb:ups'] && cur['zbb:ups'].entries) || [];
        await chrome.storage.local.set({ 'zbb:ups': { entries: entries.concat([{ mid: 7001, name: '搬运UP', source: 'manual', addedAt: Date.now() }]), updatedAt: Date.now(), error: '' } });
        return 'ok';
      })()`,
    );
    await sleep(800);

    const afterUp = await evaluate(
      pageCdp,
      `(async () => {
        const r = await fetch('/x/web-interface/wbi/index/top/feed/rcmd?w_rid=t&wts=9');
        const j = await r.json();
        return JSON.stringify({ count: j.data.item.length, mids: j.data.item.map(function (i) { return i.owner && i.owner.mid; }) });
      })()`,
    );
    const upResult = JSON.parse(afterUp || '{}');
    check(upResult.count === 0, 'UP 库：命中 mid 后最后一条也被摘掉', String(afterUp));
    check(!String(upResult.mids).includes('7001'), 'UP 库：留下的 feed 不含被屏蔽的 UP');

    check(popup.records === 2, 'popup：命中记录渲染 2 条', String(popup.records));

    // ---- 5) 远端题库同步 ----
    await writeState({ ...BASE_SETTINGS, refreshMinutes: 1, remoteSeedUrls: ['https://www.bilibili.com/seed.txt'] });
    const syncOk = await evaluate(
      popupCdp,
      `new Promise(function(r){ chrome.runtime.sendMessage({type:'SYNC_SEED'}, function(res){ r(String(res && res.ok)); }); })`,
    );
    check(syncOk === 'true', '远端题库：同步请求成功', String(syncOk));

    const poolAfter = JSON.parse(
      (await evaluate(
        swCdp,
        `chrome.storage.local.get('zbb:hot').then(function(d){ return JSON.stringify(d['zbb:hot'] || null); })`,
      )) || 'null',
    );
    const remoteCount = (poolAfter?.entries ?? []).filter((e) => e.origin === 'remote').length;
    check(remoteCount === 12, '远端题库：12 条并入池子', String(remoteCount));
    check(
      (poolAfter?.entries ?? []).some((e) => e.title.includes('AI 取代程序员')),
      '远端题库：本地条目未被覆盖',
    );

    await evaluate(
      popupCdp,
      `new Promise(function(r){ chrome.runtime.sendMessage({type:'SYNC_SEED'}, function(){ r('done'); }); })`,
    );
    const poolAgain = JSON.parse(
      (await evaluate(
        swCdp,
        `chrome.storage.local.get('zbb:hot').then(function(d){ return JSON.stringify(d['zbb:hot'] || null); })`,
      )) || 'null',
    );
    check(
      (poolAgain?.entries ?? []).filter((e) => e.origin === 'remote').length === 12,
      '远端题库：重复同步不会翻倍（整批替换）',
      String((poolAgain?.entries ?? []).filter((e) => e.origin === 'remote').length),
    );

    // ---- 6) 定时器 ----
    const alarms = JSON.parse(
      (await evaluate(swCdp, `chrome.alarms.getAll().then(function(a){ return JSON.stringify(a); })`)) || '[]',
    );
    const alarm = alarms.find((a) => a.name === 'zbb:refresh');
    check(Boolean(alarm), '定时器：zbb:refresh 已注册', JSON.stringify(alarms));
    check(
      Boolean(alarm) && Math.abs((alarm.periodInMinutes ?? 0) - 1) < 0.01,
      '定时器：周期跟随 settings.refreshMinutes=1',
      String(alarm?.periodInMinutes),
    );
    check(alarms.some((a) => a.name === 'zbb:seed'), '定时器：zbb:seed 已注册（每日同步题库）');

    popupCdp.close();
    browserCdp.close();
    pageCdp.close();
    swCdp.close();
  } finally {
    chrome.kill();
  }

  console.log(failures === 0 ? '\n✓ 端到端全部通过' : `\n✗ 端到端失败 ${failures} 项`);
  chrome.kill();
  await sleep(800);
  await removeWithRetry(runDir);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('e2e 异常：', err.message);
  process.exit(1);
});
