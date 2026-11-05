import { readFile } from 'node:fs/promises';

const TOKEN = (await readFile(new URL('../.local/github-token', import.meta.url), 'utf8')).trim();
const OWNER = 'ConspiracyThorist';
const REPO = 'zhihu-bili-blocker';
const VERSION = 'v1.1.0';
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

const BODY = `同步知乎热榜标题，与 B 站首页推荐流做模糊匹配，在**渲染前**移除搬运视频。

## 📥 下载

[zhihu-bili-blocker.zip](${DL}/zhihu-bili-blocker.zip) — Chrome 扩展。解压后在 \`chrome://extensions\` 启用「开发者模式」，点击「加载已解压的扩展程序」。

油猴脚本不随 Release 发布，安装地址：

https://fastly.jsdelivr.net/gh/${OWNER}/${REPO}@main/zhihu-bili-blocker.user.js

> 下载缓慢时可在链接前加 \`https://gh-proxy.com/\` 走镜像。

## ✨ 本版内容

- 三档拦截强度（保守 / 标准 / 激进），精确阈值位于「高级设置」
- 页面浮窗显示「已拦截 / 累计」，可展开最近 5 条并执行放行，支持拖拽与位置持久化
- 本地题库保留 30 天、上限 800 条；超过 7 天的条目匹配阈值自动提高 0.05
- 远端题库每日同步，首次安装即可使用 250+ 条
- 接口异常时一律放行，不影响页面正常渲染

## 🎯 覆盖范围

仅处理 B 站首页推荐流，不含热门榜、搜索结果与播放页侧栏。

## 🛠 源码

https://github.com/${OWNER}/${REPO}

## 📄 许可证

[MIT](https://github.com/${OWNER}/${REPO}/blob/main/LICENSE)
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
