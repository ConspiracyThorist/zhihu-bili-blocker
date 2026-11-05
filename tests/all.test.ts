import { bigramCoverage, diceCoefficient } from '../src/core/dice';
import { matchTitle, prepareHot } from '../src/core/engine';
import { installFeedHook } from '../src/core/hook';
import { normalize } from '../src/core/normalize';
import { mergePool, parseSeed, prunePool, replaceOrigin, splitByFreshness } from '../src/core/pool';
import { pruneFeed } from '../src/core/pruner';
import { mergeUps, parseUpsFile, qualifies } from '../src/core/ups';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/types';
import { isFeedUrl } from '../src/core/urlFilter';

const failures: string[] = [];
let passed = 0;

function ok(cond: boolean, label: string): void {
  if (cond) passed += 1;
  else failures.push(label);
}

function eq<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function gte(actual: number, floor: number, label: string): void {
  if (actual >= floor) passed += 1;
  else failures.push(`${label}：期望 ≥ ${floor}，实际 ${actual}`);
}

function lte(actual: number, ceiling: number, label: string): void {
  if (actual <= ceiling) passed += 1;
  else failures.push(`${label}：期望 ≤ ${ceiling}，实际 ${actual}`);
}

/** 真实取到的知乎热榜标题，作为匹配样本 */
const HOT = [
  '四千元的冰柜被「仅退款」，买家称已销毁，商家跨千里发现商品仍在使用，买卖双方各执一词，责任该如何认定？',
  '为什么现在的年轻人不愿意结婚了？',
  '如何看待「AI 取代程序员」的说法？',
  '有哪些看似很傻但实则很聪明的设计？',
];

const settings: Settings = { ...DEFAULT_SETTINGS };
const hot = prepareHot(HOT);

function testNormalize(): void {
  eq(normalize('如何看待「AI 取代程序员」的说法？'), 'ai取代程序员的说法', '归一：去模板词与标点');
  eq(normalize('ＨＥＬＬＯ　ＷＯＲＬＤ'), 'helloworld', '归一：全角转半角');
  eq(normalize('🔥神回复：为什么年轻人不结婚'), '年轻人不结婚', '归一：去 emoji 与模板词');
  eq(normalize(''), '', '归一：空串');
  eq(normalize('？？？'), '', '归一：纯标点');
}

function testDice(): void {
  eq(diceCoefficient('abc', 'abc'), 1, 'Dice：完全相同');
  lte(diceCoefficient('abcdef', 'uvwxyz'), 0.2, 'Dice：完全无关');
  const a = normalize(HOT[0]);
  const b = normalize('四千元冰柜被「仅退款」，商家跨千里发现商品仍在使用');
  gte(bigramCoverage(b, a), 0.85, '覆盖率：删减版应接近满覆盖');
  lte(diceCoefficient(b, a), 0.7, 'Dice：删减版会被长度差压低（这正是要补覆盖率的原因）');
}

function testMatch(): void {
  const hit1 = matchTitle('【搬运】如何看待「AI 取代程序员」的说法？', hot, settings);
  ok(hit1.hit, '匹配：加前缀搬运应命中');
  eq(hit1.reason, 'exact', '匹配：去模板词后应判为 exact');

  const hit2 = matchTitle('四千元冰柜被「仅退款」，商家跨千里发现商品仍在使用', hot, settings);
  ok(hit2.hit, '匹配：删减版应命中');
  eq(hit2.reason, 'cover', '匹配：删减版应走覆盖率');

  const miss1 = matchTitle('【原神】4.2 版本全角色配队思路', hot, settings);
  ok(!miss1.hit, '匹配：无关标题不应命中');

  const miss2 = matchTitle('结婚', hot, settings);
  ok(!miss2.hit, '匹配：短标题不应命中');

  const whitelisted = matchTitle(
    '【搬运】如何看待「AI 取代程序员」的说法？',
    hot,
    { ...settings, whitelist: ['AI 取代程序员'] },
  );
  ok(!whitelisted.hit, '匹配：白名单应放行');

  const disabled = matchTitle('【搬运】如何看待「AI 取代程序员」的说法？', hot, {
    ...settings,
    enabled: false,
  });
  ok(!disabled.hit, '匹配：总开关关闭应放行');

  const strict = matchTitle('四千元冰柜被「仅退款」，商家跨千里发现商品仍在使用', hot, {
    ...settings,
    threshold: 0.95,
  });
  ok(!strict.hit, '匹配：阈值调高后删减版应放过');
}

function makeFeed(): Record<string, any> {
  return {
    code: 0,
    data: {
      item: [
        { id: 1, bvid: 'BV1', goto: 'av', title: '【搬运】如何看待「AI 取代程序员」的说法？' },
        { id: 2, bvid: 'BV2', goto: 'av', title: '【原神】4.2 版本全角色配队思路' },
        { id: 3, bvid: 'BV3', goto: 'av', title: '四千元冰柜被「仅退款」，商家跨千里发现商品仍在使用' },
      ],
      config: { tags: [{ name: '游戏' }, { name: '生活' }] },
    },
  };
}

function testPruner(): void {
  const feed = makeFeed();
  const hitTitles: string[] = [];
  const removed = pruneFeed(feed, {
    match: (title) => matchTitle(title, hot, settings),
    onHit: (title) => hitTitles.push(title),
  });

  eq(removed, 2, '剪枝：应移除 2 条');
  eq(feed.data.item.length, 1, '剪枝：只留 1 条');
  eq(feed.data.item[0].bvid, 'BV2', '剪枝：留下的是无关那条');
  eq(feed.data.config.tags.length, 2, '剪枝：无关数组不应被动');
  eq(hitTitles.length, 2, '剪枝：命中回调应触发 2 次');
}

function testUrlFilter(): void {
  ok(
    isFeedUrl('https://www.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?w_rid=abc&wts=17'),
    'URL：wbi 签名版 feed 应识别',
  );
  ok(isFeedUrl('https://www.bilibili.com/x/web-interface/index/top/feed/rcmd'), 'URL：老版 feed 应识别');
  ok(!isFeedUrl('https://www.bilibili.com/video/BV1xx411c7mD'), 'URL：播放页不是 feed');
  ok(!isFeedUrl('https://evil.example.com/feed/rcmd'), 'URL：非 B 站域名不应识别');
}

async function testHook(): Promise<void> {
  const fakeWin = {
    location: { href: 'https://www.bilibili.com/' },
    Request: globalThis.Request,
    XMLHttpRequest: class {},
    fetch: () => Promise.resolve(
      new Response(JSON.stringify(makeFeed()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  } as unknown as Window;

  const hits: string[] = [];
  installFeedHook({
    win: fakeWin,
    ready: Promise.resolve(),
    getState: () => ({ settings: { ...DEFAULT_SETTINGS }, hot }),
    onHit: (title) => hits.push(title),
  });

  const patched = fakeWin.fetch as unknown as (url: string) => Promise<Response>;
  const feedUrl = 'https://www.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?w_rid=abc&wts=17';
  const json = (await (await patched(feedUrl)).json()) as Record<string, any>;
  eq(json.data.item.length, 1, '拦截层：feed 响应应被剪枝');
  eq(hits.length, 2, '拦截层：命中应上报 2 次');

  const otherUrl = 'https://www.bilibili.com/x/web-interface/view?bvid=BV1';
  const other = await patched(otherUrl);
  const otherJson = (await other.json()) as Record<string, any>;
  eq(otherJson.data.item.length, 3, '拦截层：非 feed 响应不应被动');

  const disabledWin = {
    location: { href: 'https://www.bilibili.com/' },
    Request: globalThis.Request,
    XMLHttpRequest: class {},
    fetch: () => Promise.resolve(
      new Response(JSON.stringify(makeFeed()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  } as unknown as Window;

  installFeedHook({
    win: disabledWin,
    ready: Promise.resolve(),
    getState: () => ({ settings: { ...DEFAULT_SETTINGS, enabled: false }, hot }),
    onHit: () => undefined,
  });
  const stillAll = (await (await (disabledWin.fetch as unknown as (u: string) => Promise<Response>)(feedUrl)).json()) as Record<string, any>;
  eq(stillAll.data.item.length, 3, '拦截层：开关关闭时不应剪枝');
}

function testPool(): void {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const a = mergePool([], [{ title: '如何看待「AI 取代程序员」的说法？', origin: 'hot' }], now);
  eq(a.length, 1, '题库：首次合并应入池');

  const b = mergePool(a, [{ title: '【搬运】如何看待「AI 取代程序员」的说法？', origin: 'hot' }], now + 1000);
  eq(b.length, 1, '题库：归一后重复的标题不应新增');
  eq(b[0].firstSeen, now, '题库：重复条目应保留 firstSeen');

  const aged = mergePool(
    [{ title: '老条目', firstSeen: now - 40 * DAY, lastSeen: now - 40 * DAY, origin: 'hot' }],
    [],
    now,
  );
  eq(prunePool(aged, now, { maxAgeDays: 30 }).length, 0, '题库：超过保留期应被淘汰');

  const many = mergePool(
    [],
    Array.from({ length: 10 }, (_, i) => ({ title: `标题${i}号测试内容`, origin: 'hot' as const })),
    now,
  );
  eq(prunePool(many, now, { maxEntries: 5 }).length, 5, '题库：超过上限应截断');

  const withRemote = replaceOrigin(
    [...many, { title: '旧远端条目', firstSeen: now, lastSeen: now, origin: 'remote' }],
    'remote',
    ['新远端条目一', '新远端条目二'],
    now,
  );
  eq(
    withRemote.filter((e) => e.origin === 'remote').length,
    2,
    '题库：远端应整批替换（旧条目消失）',
  );
  ok(!withRemote.some((e) => e.title === '旧远端条目'), '题库：被删掉的远端条目不应残留');

  const split = splitByFreshness(
    [
      { title: '新的', firstSeen: now, lastSeen: now - DAY, origin: 'hot' },
      { title: '老的', firstSeen: now, lastSeen: now - 10 * DAY, origin: 'hot' },
    ],
    now,
    7,
  );
  eq(split.fresh.length, 1, '题库：新鲜度切分（新）');
  eq(split.stale.length, 1, '题库：新鲜度切分（老）');

  const seed = parseSeed(
    ['# 注释行', '正常标题一条', '正常标题一条', '<script>x</script>', 'https://evil.example.com/x', '  另一条标题  '].join('\n'),
  );
  eq(seed.length, 2, '种子：应去掉注释/HTML/URL/重复行');
  eq(seed[1], '另一条标题', '种子：应去掉首尾空格');
}

function testStaleThreshold(): void {
  const entry = prepareHot([HOT[0]])[0];
  const bili = '四千元冰柜被「仅退款」，商家跨千里发现商品仍在使用';
  const strict: Settings = { ...settings, threshold: 0.89 };

  ok(matchTitle(bili, [entry], strict).hit, '老条目：新鲜条目在 0.89 阈值应命中');
  ok(
    !matchTitle(bili, [{ ...entry, stale: true }], strict).hit,
    '老条目：同一条目标记 stale 后应被抬高的分数线挡住',
  );
}

function testUps(): void {
  // 双门槛：命中数 ≥2 且命中率 ≥30%
  ok(qualifies(2, 5), 'UP 库：2/5 入选');
  ok(qualifies(3, 10), 'UP 库：3/10 入选（正好 30%）');
  ok(!qualifies(2, 10), 'UP 库：2/10 落选（命中率不足）');
  ok(!qualifies(1, 2), 'UP 库：1/2 落选（命中数不足）');
  ok(!qualifies(0, 0), 'UP 库：空样本落选');

  // 脏数据一律丢弃，不抛错
  eq(parseUpsFile('not json').length, 0, 'UP 库：非 JSON 返回空');
  const parsed = parseUpsFile(JSON.stringify({
    generatedAt: '2026-11-05',
    threshold: 0.78,
    entries: [
      { mid: 123, name: 'A' },
      { mid: 0, name: 'B' },
      { mid: 'x', name: 'C' },
      { name: 'D' },
    ],
  }));
  eq(parsed.length, 1, 'UP 库：只保留合法 mid');
  eq(parsed[0].source, 'auto', 'UP 库：远端条目标记为 auto');

  // 合并规则：手动条目优先，远端整批替换 auto
  const merged = mergeUps(
    [
      { mid: 1, name: '手动', source: 'manual' as const },
      { mid: 2, name: '旧自动', source: 'auto' as const },
      { mid: 3, name: '手动同号', source: 'manual' as const },
    ],
    [
      { mid: 2, name: '新自动', source: 'auto' as const },
      { mid: 3, name: '远端同号', source: 'auto' as const },
    ],
  );
  eq(merged.length, 3, 'UP 库：合并后不重复');
  eq(merged.find((e) => e.mid === 1)?.source, 'manual', 'UP 库：手动条目保留');
  eq(merged.find((e) => e.mid === 2)?.name, '新自动', 'UP 库：auto 条目被远端整批替换');
  eq(merged.find((e) => e.mid === 3)?.name, '手动同号', 'UP 库：同 mid 时手动优先');
}

function testPrunerUp(): void {
  const feed = {
    data: {
      item: [
        { bvid: 'BV1', title: '正常视频', owner: { mid: 42 } },
        { bvid: 'BV2', title: '另一个正常视频', owner: { mid: 7 } },
      ],
    },
  };
  const removed = pruneFeed(feed, {
    match: () => ({ hit: false, zhihuTitle: '', score: 0, reason: 'none' }) as never,
    onHit: () => {},
    shouldDrop: (item) => Number((item as { owner?: { mid?: number } }).owner?.mid) === 42,
  });
  eq(removed, 1, 'UP 库：命中 mid 的卡片被摘掉');
  eq(feed.data.item.length, 1, 'UP 库：未命中的卡片保留');
  eq(feed.data.item[0].owner.mid, 7, 'UP 库：留下的是另一个 UP');
}

export async function run(): Promise<{ passed: number; failures: string[] }> {
  testNormalize();
  testDice();
  testMatch();
  testPruner();
  testUrlFilter();
  testPool();
  testStaleThreshold();
  testUps();
  testPrunerUp();
  await testHook();
  return { passed, failures };
}
