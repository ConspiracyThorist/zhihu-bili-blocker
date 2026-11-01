import { readFile } from 'node:fs/promises';

const TOKEN = (await readFile('D:\\test\\.github-token', 'utf8')).trim();
const OWNER = 'ConspiracyThorist';
const REPO = 'zhihu-bili-blocker';
const VERSION = 'v1.0.0';
const DL = `https://github.com/${OWNER}/${REPO}/releases/download/${VERSION}`;
/** 只改 Release 正文，不重建、不传附件 */
const NOTES_ONLY = process.argv.includes('--notes');

const H = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'zbb-release',
  'content-type': 'application/json',
};

const BODY = `B 站首页有一类视频，标题直接就是知乎的问题。这个扩展把热榜标题当字典，推荐流里出现长得像的，在渲染前摘掉——卡片压根不出现。

## 📥 装哪个

[zhihu-bili-blocker.zip](${DL}/zhihu-bili-blocker.zip) — Chrome 扩展。解压后在 \`chrome://extensions\` 打开开发者模式，点「加载已解压的扩展程序」。

油猴脚本不放 Release，直接点这条装：

https://fastly.jsdelivr.net/gh/${OWNER}/${REPO}@main/zhihu-bili-blocker.user.js

下载卡住的话，链接前面加 \`https://gh-proxy.com/\` 走镜像。

## ✨ 这版有什么

- 三档强度：保守 / 标准 / 激进。不用懂阈值也能选，想抠数字再展开高级设置
- 右下角一个小胶囊，露「已拦截 / 累计」两个数。点开看最近 5 条，能就地放行；拖着能挪，位置会记住
- 题库本地攒 30 天，最多 800 条。满 7 天的条目自动抬高分数线
- 远端题库每天同步，装完就有 250+ 条打底
- 失败一律放行。接口 401、解析出错、列表没到，原样返回，不会白屏

## 🎯 只管首页

热门榜、搜索结果、播放页侧栏都不处理。

## 🛠 源码

https://github.com/${OWNER}/${REPO}
`;

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

const existing = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${VERSION}`);
let release = existing.status === 200 ? existing.json : null;

if (!release) {
  const created = await api('POST', `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: VERSION,
    // 标题只写版本号，不要重复项目名——GitHub 上已经显示仓库名了
    name: VERSION,
    body: BODY,
    target_commitish: 'main',
    draft: false,
    prerelease: false,
  });
  if (created.status !== 201) {
    console.error('创建 Release 失败：', created.status, created.json?.message ?? '');
    process.exit(1);
  }
  release = created.json;
  console.log('✓ 已创建 Release', release.html_url);
} else {
  console.log('Release 已存在：', release.html_url);
}

if (NOTES_ONLY) {
  const patched = await api('PATCH', `/repos/${OWNER}/${REPO}/releases/${release.id}`, { body: BODY });
  console.log(patched.status === 200 ? '✓ 正文已更新' : `✗ 更新失败：${patched.status}`);
  process.exit(patched.status === 200 ? 0 : 1);
}

// 附件只放扩展 zip。油猴脚本不进 Release，它作为仓库根目录的文件存在。
const assets = await api('GET', `/repos/${OWNER}/${REPO}/releases/${release.id}/assets`);
const uploaded = new Set((assets.json ?? []).map((a) => a.name));

for (const [local, name, type] of [
  ['dist/zhihu-bili-blocker.zip', 'zhihu-bili-blocker.zip', 'application/zip'],
]) {
  if (uploaded.has(name)) {
    console.log(`- ${name} 已存在，跳过`);
    continue;
  }
  const data = await readFile(local);
  try {
    const res = await fetch(
      `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { ...H, 'content-type': type, 'content-length': String(data.length) },
        body: data,
        signal: AbortSignal.timeout(60000),
      },
    );
    const text = await res.text();
    console.log(res.ok ? `✓ 上传 ${name}（${data.length} 字节）` : `✗ ${name} → ${res.status} ${text.slice(0, 120)}`);
  } catch (err) {
    console.log(`✗ ${name} 上传异常：${err.cause?.code ?? err.message}`);
  }
}

const final = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${VERSION}`);
console.log('\nRelease:', final.json?.html_url);
for (const a of final.json?.assets ?? []) {
  console.log(`  附件 ${a.name}  ${a.size} 字节  ${a.browser_download_url}`);
}
