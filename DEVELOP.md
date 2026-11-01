# 开发说明

面向要改代码、跑测试或维护题库的人。普通用户请看 [README](README.md)。

## 目录结构

```
src/core/          与宿主无关：归一、相似度、判定、JSON 剪枝、URL 识别、fetch hook、DOM 扫描、题库池
src/extension/     扩展壳：background(取数+题库同步) / page(MAIN world) / content(桥+DOM) / popup
src/userscript/    油猴壳：同一个 core，换成 GM_* 适配 + 悬浮面板
tools/             build-seed 生成题库 / audit 题库体检 / bili-search wbi 签名搜索 / gh、gh-sync 仓库操作
tests/             单测 / 产物冒烟 / 浏览器端到端
assets/icons/      图标（scripts/make-icons.py 生成）
seed.txt           题库种子，由 GitHub Actions 每日刷新
reports/           题库体检报告
build.mjs          esbuild 双出口 + 打 zip（自带极简 zip 写入器，无三方依赖）
```

## 构建与测试

```bash
npm install --ignore-scripts   # esbuild 的原生二进制已在 @esbuild/win32-x64 里，装包脚本可跳过
npm run typecheck
npm test        # 44 条断言
npm run build   # 出 dist/extension、dist/zhihu-bili-blocker.zip、dist/zhihu-bili-blocker.user.js
npm run smoke   # 直接执行打包产物，验证桥 + hook + 剪枝接线
npm run e2e     # 25 项浏览器端到端，需要能正常启动 Chrome 的会话
```

`build.mjs` 走 esbuild 的 **CLI 二进制**而不是 JS API——JS API 靠管道和子进程通信，在受限环境（比如被沙箱限制 spawn 的会话）会 `EPERM`，CLI 模式用继承 stdio，在哪都能跑。

### E2E 的两个坑

1. Chrome 137+ 的正式版已不再理会 `--load-extension`，`e2e.mjs` 改用 `--enable-unsafe-extension-debugging` 启动 + CDP `Extensions.loadUnpacked` 加载扩展。
2. 伪造 B 站响应**必须**用 CDP 的 `Fetch` 域在协议层拦截。早期用「本地 HTTPS 服务器 + host-resolver-rules」，一旦系统配了代理或真站可达就会直接绕过去，测出来的结果是假的。

在受限沙箱里 Chrome 根本起不来（crashpad 的 OpenProcess 与 mojo 命名管道会被拒，直接 self-terminating），E2E 只能在普通桌面会话跑。

## 匹配原理

两层模型，共用同一个判定函数：

```
页面 window.fetch ──► [拦截层 page.js] 改 JSON 响应，摘掉命中项 ──► 页面解析（卡片从未出现）
浏览器渲染后     ──► [DOM 兜底 content.js] 扫卡片 → 隐藏最外层网格单元（防空洞）
                              └──────── 同一个 matchTitle() ────────┘
```

**拦截层（主路径）**：`page.js` 在 `document_start` 注入页面 MAIN world，包住页面的 `fetch` 与 `XMLHttpRequest`。检测到首页 feed 请求，等响应回来后解析 JSON，把命中项从数组里 splice 掉，再把改过的 JSON 交还页面。

**DOM 兜底**：SSR 首屏或接口没覆盖到的卡片，由隔离世界的 `content.js` 用 `MutationObserver` 扫描，命中则隐藏**最外层网格单元**而非卡片本身，避免 masonry 列里留下与卡片等高的空白洞。

### 四级判定（从严到宽）

| 级别 | 条件 | 用途 |
|---|---|---|
| `exact` | 归一后完全相同 | 最可靠 |
| `contain` | 互相包含，分数 = 长度比 | 加了前缀后缀的照搬 |
| `dice` | 字符 bigram 相似度 ≥ 阈值 | 等长改写 |
| `cover` | 短标题 bigram 被长标题覆盖的比例 ≥ 阈值 | **删减版**——对称 Dice 会被长度差压到 0.6 而漏判，覆盖率能给到 0.9 |

**归一**：全角转半角、小写、去 emoji、去标点，再剥掉「知乎 / 如何看待 / 为什么 / 高赞 / 【】」这类模板词。不剥的话每个标题都天然带 0.2~0.3 的虚高相似度，正是误伤主因。

**失败一定放行**：解析异常、列表没到、接口 401，全都原样返回原始响应。宁可不屏蔽，也不能白屏。

### 题库池

- 每次刷新把标题**并入**本地池，按归一标题去重，只更新 `lastSeen`
- 超过 `poolDays`（默认 30 天）没再出现就淘汰；总量超 `poolMax`（默认 800）按最旧踢
- 超过 7 天算「老条目」，匹配分数线自动 +0.05——池子变大后误伤几乎都来自旧标题
- 远端种子**整批替换**：作者删掉的条目，用户端下次同步就消失

**为什么上限是 800 不是 3000**：`reports/pool-audit.md` 显示，77 条题库里只有 15.6% 能在 B 站搜到同题视频，72.7% 完全搜不到。条目再多，有效密度不变，只增误伤。

## 题库工具

```bash
node tools/build-seed.mjs --days 60            # 生成种子：热榜 + 日报往期（默认合并已有文件）
node tools/run-audit.mjs --seed seed.txt       # 体检：拿每条标题去 B 站搜，统计命中率
```

`build-seed` 默认**合并**已有 `seed.txt` 而不是覆盖——GitHub Actions 的 runner 在境外拉不到知乎日报，不合并的话会把几百条历史冲成 30 条。

体检的结论（2026-11-01）：

| 指标 | 值 |
|---|---|
| 能在 B 站搜到同题视频 | 15.6% |
| 完全搜不到 | 72.7% |
| 日报（常青问题）命中率 | 17.0% |
| 热榜（时事）命中率 | 13.3% |

反直觉的是日报更高——搬运者做「知乎问答合集」时往往直接把问题原文当标题，而时事类必须改写才有点击。

## 发布题库源

`seed.txt` 改动推上去后，用户端从两个镜像按序拉取：

```
1. https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/seed.txt
2. https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/seed.txt
```

| 地址形态 | 实测 | 缓存 |
|---|---|---|
| `gh-proxy.com/` + raw | ✅ 200，约 1.7s，**内容最新**；约 1/3 请求会超时 | 无 |
| `fastly.jsdelivr.net/gh/...` | ✅ 200，约 1.7s | 边缘 12h，浏览器 7 天 |
| `cdn.jsdelivr.net` / `raw.githubusercontent.com` | ❌ ECONNRESET | — |

两个源互补：gh-proxy 快但抖，jsDelivr 稳但更新滞后 12 小时；任一成功即用。

`jsDelivr` 的 purge 接口清不掉 fastly 节点（返回 finished 但 `age` 照涨），别指望它。CI 里的 purge 步骤保留着，无害。

## 调试

在 B 站页面控制台执行 `__zbbDebug`：

| 字段 | 含义 |
|---|---|
| `accepted` | 收到几次题库消息 |
| `hotLen` | 当前字典大小 |
| `settled` | 就绪信号触发次数（>0 说明放行条件已满足） |
| `fetchSrc` | `window.fetch` 是否已被接管 |

## 仓库操作

本机 `github.com` 不通（`git push` 不可用），只有 `api.github.com` 可达，所以用这两个脚本代替 git：

```bash
node tools/gh.mjs whoami | list | get <path> | put <file> | runs | run <workflow>
node tools/gh-sync.mjs <本地目录> [owner/repo]   # 按 blob sha 增量同步整个目录
```

token 从 `D:\test\.github-token` 或环境变量 `GITHUB_TOKEN` 读取。
