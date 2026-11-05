# 开发说明

面向需要修改代码、运行测试或维护题库的开发者。普通使用请参考 [README](README.md)。

## 📁 目录结构

```
src/core/          与宿主无关：归一、相似度、判定、JSON 剪枝、URL 识别、fetch hook、DOM 扫描、题库池
src/extension/     扩展壳：background(取数+题库同步) / page(MAIN world) / content(桥+DOM+浮窗) / popup
src/userscript/    油猴壳：复用 core，换成 GM_* 适配
server/cloudflare/ 投稿接收端（Workers + KV）
server/aliyun/     投稿接收端（FC + OSS，国内主用）
tools/             构建之外的脚本：题库生成/体检、UP 发现与审核、部署、仓库操作
tests/             单元测试、产物冒烟、端到端测试
assets/icons/      图标源文件，由 scripts/make-icons.py 生成
docs/              发布与部署文档，以及题库体检结论
seed.txt           题库种子，由 GitHub Actions 每日刷新
ups.json           UP 库，由 CI 生成并提交
```

`src/core` 不引用任何 `chrome.*` 或 `GM_*` API，两个宿主共用的逻辑全部集中在此。

## 🛠 环境与命令

```bash
npm install --ignore-scripts   # esbuild 原生二进制随 @esbuild/win32-x64 分发，可跳过安装脚本
npm run typecheck              # TypeScript 严格模式检查
npm test                       # 44 条单元测试
npm run build                  # 生成 dist/extension、zip 与 user.js
npm run smoke                  # 直接执行打包产物，验证桥接与剪枝
npm run e2e                    # 31 项浏览器端到端测试
```

### 构建说明

`build.mjs` 调用 esbuild 的 CLI 二进制，而非 JS API。JS API 通过管道与子进程通信，在受限环境（例如限制 spawn 的沙箱）中会返回 `EPERM`；CLI 模式使用继承 stdio，适应性更好。

构建需启用 `--charset=utf8`。否则中文字符会被转义为 `\uXXXX`，虽然不影响运行，但会显著降低脚本可读性。

### 测试说明

单元测试覆盖归一化、相似度计算、判定逻辑、JSON 剪枝、URL 识别、题库池与 hook 接线。产物冒烟直接执行构建结果，验证跨 world 通信链路。

端到端测试基于 headless Chrome 与 CDP，覆盖拦截层、DOM 兜底、浮窗、开关语义、接口降级、弹窗渲染、题库同步与定时器配置。

执行 E2E 前需注意：

1. **Chrome 137+ 已不支持 `--load-extension`**，需使用 `--enable-unsafe-extension-debugging` 启动，并通过 CDP `Extensions.loadUnpacked` 加载扩展。
2. **伪造响应必须使用 CDP `Fetch` 域**。若采用本地 HTTPS 服务器配合 `host-resolver-rules`，在系统配置代理或目标站点可达时请求会绕过本地服务，导致测试结果失真。
3. **受限沙箱无法启动 Chrome**。crashpad 的 `OpenProcess` 与 mojo 命名管道会被拒绝，进程会自行终止。E2E 需在常规桌面会话中运行。

## 🧠 架构

匹配分两层，共用同一个判定函数：

```
页面 window.fetch ──► [拦截层 page.js] 修改 JSON 响应，移除命中项 ──► 页面解析（卡片从未渲染）
浏览器渲染后     ──► [DOM 兜底 content.js] 扫描卡片 → 隐藏最外层网格单元（避免空洞）
                              └──────── matchTitle() ────────┘
```

**拦截层**为核心路径。`page.js` 在 `document_start` 注入页面 MAIN world，包装 `fetch` 与 `XMLHttpRequest`。识别到首页 feed 请求后解析响应 JSON，移除命中条目再返回，因发生在页面解析之前，卡片不会产生任何渲染。

**DOM 兜底层**处理 SSR 首屏与接口未覆盖的部分。`content.js` 运行于隔离世界，通过 `MutationObserver` 扫描卡片。隐藏对象为**最外层网格单元**，避免 masonry 布局中留下与卡片等高的空白。

### 侧边栏

浮窗面板里的「设置 ↗」通过 `content → background` 发 `OPEN_PANEL` 消息，background 调用 `chrome.sidePanel.open({ windowId })`。该 API 要求用户手势，从内容脚本的消息处理器里调用是允许的；失败时退回 `chrome.windows.create` 开一个小窗口，行为等价。

`manifest.json` 的 `side_panel.default_path` 指向 `popup.html`，所以工具栏弹窗和侧边栏共用同一个页面。`popup.css` 用 `@media (min-width: 380px)` 区分两种宽度：弹窗按 340px 排，侧边栏撑满并居中。

### UP 库

题库回答「这个问题被搬了」，UP 库回答「这个人一直在搬」。两套判定共用同一个 `matchTitle`。

自动发现走 CI（`.github/workflows/discover.yml`）：每周一增量、每月 1 日全量。增量只处理 `ups.json` 里 `scanned` 未记录的标题，结果**合并**进已有条目；全量重扫并重建。两种模式共用 `qualifies()` 判定：`tools/discover-ups.ts` 拿每条题库标题搜 B 站，对结果做匹配，按 mid 统计 `hits / total`，只有 `hits ≥ 2 且 rate ≥ 30%` 的 UP 才写入 `ups.json`。双门槛是刻意的——单条命中可能只是标题撞车，误封一个号比漏拦一百条视频代价大。

客户端把 `ups.json` 与本地手动条目合并（`core/ups.ts` 的 `mergeUps`：手动条目优先，auto 条目整批替换），拦截时两处一起查：

- 接口层：`pruneFeed` 的 `shouldDrop` 用 `owner.mid` 判
- DOM 层：`startScanner` 的 `onCard` 用卡片里的空间链接判

页面上的「屏蔽此 UP」按钮由 `core/dom.ts` 的 `attachUpButton` 注入，扩展与油猴共用。

### 投稿链路

用户手动拉黑时，除了写本地库，还会进一条匿名投稿：

1. 扩展把 `{mid, name}` 写进 `zbb:outbox`（断网也不丢，下次启动或定时任务补发）
2. 发到投稿端点（`server/aliyun/src/index.ts` 国内主用、`server/cloudflare/src/index.ts` 兜底）入队，同 IP 每日 20 次 + 全局每小时 500 次
3. CI 每 6 小时（`up-review.yml`）拉队列，用 `userVideos(mid)` 拿该 UP 最近 50 条投稿，
   逐条与题库匹配，算命中率
4. 命中 ≥2 且命中率 ≥30% 才并入 `ups.json`，否则丢弃并出队

判定标准与自动发现完全一致，只是样本从「按标题搜得到的视频」换成「这个 UP 自己的作品」，
后者更直接，而且每个 UP 只花 1 次请求。

部署步骤见 [docs/ups-worker.md](docs/ups-worker.md)。`upsEndpoint` 留空时整条链路静默降级。

### 判定规则

| 级别 | 条件 | 适用场景 |
| --- | --- | --- |
| `exact` | 归一化后完全相同 | 直接搬运 |
| `contain` | 互相包含，得分为长度比 | 添加前后缀的搬运 |
| `dice` | 字符 bigram 相似度 ≥ 阈值 | 等长改写 |
| `cover` | 短标题 bigram 被长标题覆盖的比例 ≥ 阈值 | 删减版标题 |

`cover` 用于解决删减场景：对称 Dice 会被长度差显著拉低（实测约 0.58），低于默认阈值而漏判；覆盖率在同一组样本上可达 0.9。

归一化流程包括：全角转半角、转小写、移除 emoji 与标点，并剥离「知乎」「如何看待」「为什么」「高赞」等模板词。若不移除，任意标题之间会存在 0.2~0.3 的虚高相似度，是误伤的主要来源。

**异常一律放行**：解析失败、数据未就绪、接口返回 401 时均返回原始响应，避免影响页面正常渲染。

### 题库池

- 每次刷新将标题合并入本地池，按归一化标题去重，仅更新 `lastSeen`
- 超过 `poolDays`（默认 30 天）未出现的条目被淘汰；总量超过 `poolMax`（默认 800）时按最旧优先移除
- 超过 7 天的条目定义为旧条目，匹配阈值自动提高 0.05
- 远端种子采用整批替换，确保作者侧删除的条目在客户端同步后消失

容量上限设为 800 而非更大规模，依据来自 `docs/pool-audit.md`：77 条题库中仅 15.6% 能在 B 站检索到同题视频，72.7% 完全检索不到。扩大规模不会提升有效密度，只会增加误伤概率。

## 🧰 题库工具

```bash
node tools/build-seed.mjs --days 60            # 生成种子：热榜 + 日报往期，默认合并已有文件
node tools/run-audit.mjs --seed seed.txt       # 体检：以每条标题检索 B 站并统计命中率
```

`build-seed` 默认采用合并策略而非覆盖。GitHub Actions 运行环境无法访问知乎日报接口，若直接覆盖会将数百条历史条目替换为 30 条。

体检结果（2026-11-01）：

| 指标 | 数值 |
| --- | --- |
| 能在 B 站检索到同题视频 | 15.6% |
| 完全无法检索 | 72.7% |
| 日报（常青问题）命中率 | 17.0% |
| 热榜（时事）命中率 | 13.3% |

日报类命中率高于热榜。搬运者制作「知乎问答合集」类内容时常直接使用问题原文作为标题；时事类标题需改写才有传播力，改写后反而难以匹配。

## 🚚 题库发布

`seed.txt` 更新后，客户端按顺序尝试两个镜像源：

```
1. https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/seed.txt
2. https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/seed.txt
```

| 地址 | 实测 | 缓存策略 |
| --- | --- | --- |
| `gh-proxy.com/` + raw | 200，约 1.7s，内容最新；约 1/3 请求超时 | 无缓存 |
| `fastly.jsdelivr.net/gh/...` | 200，约 1.7s | 边缘 12h，浏览器 7 天 |
| `cdn.jsdelivr.net` / `raw.githubusercontent.com` | 连接被重置 | — |

两个源互补：gh-proxy 更新及时但稳定性较差，jsDelivr 稳定但存在约 12 小时延迟。

jsDelivr 的 purge 接口无法清除 fastly 节点缓存（返回 `finished` 但 `age` 持续增长），CI 中的 purge 步骤仅作保留，无实际效果。

## 🐞 调试

在 B 站页面控制台执行 `__zbbDebug`：

| 字段 | 含义 |
| --- | --- |
| `accepted` | 收到题库消息的次数 |
| `hotLen` | 当前词库条目数 |
| `settled` | 就绪信号触发次数（大于 0 表示放行条件已满足） |
| `fetchSrc` | `window.fetch` 是否已被接管 |

## 🐙 仓库操作

当前环境无法访问 `github.com`（`git push` 不可用），仅 `api.github.com` 可达，因此使用以下脚本替代 git：

```bash
node tools/gh.mjs whoami | list | get <path> | put <file> | runs | run <workflow>
node tools/gh-sync.mjs <本地目录> [owner/repo]   # 按 blob sha 增量同步
```

Token 从 `D:\test\.github-token` 或环境变量 `GITHUB_TOKEN` 读取。

## 📄 许可证

[MIT](LICENSE)
