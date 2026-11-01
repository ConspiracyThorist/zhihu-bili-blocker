import { readFile } from 'node:fs/promises';

const TOKEN = (await readFile('D:\\test\\.github-token', 'utf8')).trim();
const OWNER = 'ConspiracyThorist';
const REPO = 'zhihu-bili-blocker';
const VERSION = 'v1.1.0';

const H = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'zbb-release',
  'content-type': 'application/json',
};

const BODY = `## 知乎热榜屏蔽 B 站推荐 ${VERSION}

把「知乎热榜」当过滤字典，在 B 站首页推荐里按标题做模糊匹配，命中就在**渲染前**摘掉——不是先显示再消失。

### 装哪个

- **Chrome 扩展**（推荐）：下载 \`zhihu-bili-blocker.zip\`，解压后在 \`chrome://extensions\` 开启开发者模式，「加载已解压的扩展程序」
- **油猴脚本**：下载 \`zhihu-bili-blocker.user.js\`，Tampermonkey 会自动提示安装

### 这版有什么

- **三档拦截强度**：保守 / 标准 / 激进，不用理解阈值也能选；精确滑杆收进「高级设置」
- **右下角浮窗**：只显示「已拦截 / 累计」两个数，点开看最近 5 条，可就地放行
- **题库池**：本地累积 30 天、上限 800 条，超过 7 天的条目自动抬高分数线
- **远端题库**：每天同步一次，装了就有 250+ 条起步
- **失败放行**：接口 401、解析异常、列表未就绪，一律原样放行，不会白屏

### 覆盖范围

只处理 B 站**首页推荐**，不含热门榜、搜索结果、播放页侧栏。
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

// 上传附件（走 uploads.github.com，若被墙则回退到仓库内文件）
const assets = await api('GET', `/repos/${OWNER}/${REPO}/releases/${release.id}/assets`);
const uploaded = new Set((assets.json ?? []).map((a) => a.name));

for (const [local, name, type] of [
  ['dist/zhihu-bili-blocker.zip', 'zhihu-bili-blocker.zip', 'application/zip'],
  ['dist/zhihu-bili-blocker.user.js', 'zhihu-bili-blocker.user.js', 'text/javascript'],
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
