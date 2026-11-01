import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 产物级冒烟测试：直接执行 dist 里的打包结果（不是源码），
 * 用最小 window/document 桩验证三件事：
 *   1. page.js 能装配好 hook 与 postMessage 桥
 *   2. 收到热榜列表后，feed 响应确实被剪枝
 *   3. 命中会通过 postMessage 回报给隔离世界
 *   4. content.js 在最小环境下加载不抛错
 * （真实浏览器链路见 tests/e2e.mjs，需要能正常启动 Chrome 的环境）
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOT = [
  '如何看待「AI 取代程序员」的说法？',
  '四千元的冰柜被「仅退款」，买家称已销毁，商家跨千里发现商品仍在使用，买卖双方各执一词，责任该如何认定？',
];

const failures = [];
let passed = 0;
const check = (cond, label, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

function feed() {
  return {
    code: 0,
    data: {
      item: [
        { id: 1, bvid: 'BV1', goto: 'av', title: '【搬运】如何看待「AI 取代程序员」的说法？' },
        { id: 2, bvid: 'BV2', goto: 'av', title: '【原神】4.2 版本全角色配队思路' },
        { id: 3, bvid: 'BV3', goto: 'av', title: '四千元冰柜被「仅退款」，商家跨千里发现商品仍在使用' },
      ],
    },
  };
}

async function testPageBundle() {
  const code = await readFile(join(root, 'dist/extension/page.js'), 'utf8');
  const listeners = new Map();
  const posted = [];

  const fakeWindow = {
    location: { href: 'https://www.bilibili.com/' },
    setTimeout,
    clearTimeout,
    addEventListener: (type, fn) => {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    postMessage: (msg) => posted.push(msg),
    fetch: async () =>
      new Response(JSON.stringify(feed()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    XMLHttpRequest: class {
      open() {}
      send() {}
    },
  };

  const fakeDocument = { addEventListener: () => {}, documentElement: {} };
  const factory = new Function('window', 'document', 'setTimeout', 'clearTimeout', code);
  factory(fakeWindow, fakeDocument, setTimeout, clearTimeout);

  const handler = (listeners.get('message') ?? [])[0];
  check(typeof handler === 'function', 'page.js：注册了 message 监听');

  handler({
    source: fakeWindow,
    data: {
      __zbb: 'ext',
      type: 'state',
      payload: { enabled: true, threshold: 0.72, minLen: 8, whitelist: [], titles: HOT },
    },
  });

  const url = 'https://www.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?w_rid=abc&wts=17';
  const json = await (await fakeWindow.fetch(url)).json();
  check(json.data.item.length === 1, 'page.js：feed 响应被剪枝（3 → 1）', `实际 ${json.data.item.length}`);
  check(json.data.item[0].bvid === 'BV2', 'page.js：留下的是无关视频');

  const hits = posted.filter((m) => m && m.__zbb === 'page' && m.type === 'hit');
  check(hits.length === 2, 'page.js：命中 2 次并回报', `实际 ${hits.length}`);
  check(
    hits.every((h) => h.payload && typeof h.payload.score === 'number' && h.payload.layer === 'net'),
    'page.js：回报内容带分数与层级',
  );

  const announced = posted.some((m) => m && m.__zbb === 'page' && m.type === 'ready');
  check(announced, 'page.js：启动时向隔离世界喊话要列表');
}

async function testContentBundle() {
  const code = await readFile(join(root, 'dist/extension/content.js'), 'utf8');
  const listeners = new Map();

  const fakeWindow = {
    location: { href: 'https://www.bilibili.com/' },
    setTimeout,
    setInterval,
    clearInterval,
    clearTimeout,
    addEventListener: (type, fn) => {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    postMessage: () => undefined,
  };

  const element = {
    id: '',
    textContent: '',
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    append() {},
  };

  const fakeDocument = {
    documentElement: { appendChild() {} },
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ ...element }),
    querySelectorAll: () => [],
  };

  const chromeStub = {
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      onChanged: { addListener: () => undefined },
    },
  };

  class ObserverStub {
    observe() {}
    disconnect() {}
  }

  const factory = new Function(
    'window',
    'document',
    'chrome',
    'MutationObserver',
    'setTimeout',
    'setInterval',
    'clearInterval',
    code,
  );

  let error = null;
  try {
    factory(fakeWindow, fakeDocument, chromeStub, ObserverStub, setTimeout, setInterval, clearInterval);
    await new Promise((r) => setTimeout(r, 50));
  } catch (err) {
    error = err;
  }

  check(!error, 'content.js：在最小环境下加载不抛错', error ? String(error) : '');
  check(typeof (listeners.get('message') ?? [])[0] === 'function', 'content.js：注册了 message 监听');
}

console.log('产物冒烟（dist 打包结果）');
await testPageBundle();
await testContentBundle();

console.log(failures.length === 0 ? `\n✓ 冒烟通过：${passed} 项` : `\n✗ 冒烟失败 ${failures.length} 项`);
process.exit(failures.length === 0 ? 0 : 1);
