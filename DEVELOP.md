# 开发说明

写给要改代码、跑测试、或者维护题库的人。只是想用的话看 [README](README.md) 就够了。

## 🗂 目录

```
src/core/         与宿主无关：归一、相似度、判定、JSON 剪枝、URL 识别、fetch hook、DOM 扫描、题库池
src/extension/    扩展壳：background(取数+题库同步) / page(MAIN world) / content(桥+DOM+浮窗) / popup
src/userscript/   油猴壳：同一个 core，换成 GM_* 适配 + 同一套浮窗
tools/            build-seed 生成题库 / audit 题库体检 / bili-search wbi 签名搜索 / gh、gh-sync 仓库操作
tests/            单测 / 产物冒烟 / 浏览器端到端
assets/icons/     图标，由 scripts/make-icons.py 生成
seed.txt          题库种子，GitHub Actions 每天刷新
reports/          题库体检报告
build.mjs         esbuild 双出口 + 打 zip（自带极简 zip 写入器，没引三方依赖）
```

## 🏗 构建与测试

```bash
npm install --ignore-scripts   # esbuild 的原生二进制已在 @esbuild/win32-x64 里，装包脚本可跳过
npm run typecheck
npm test        # 44 条断言
npm run build   # 出 dist/extension、zip、user.js，并在根目录留一份 user.js
npm run smoke   # 直接执行打包产物，验证桥 + hook + 剪枝接线
npm run e2e     # 31 项浏览器端到端，需要能正常启动 Chrome 的会话
```

`build.mjs` 调用的是 esbuild 的 **CLI 二进制**，没用 JS API。JS API 靠管道和子进程通信，在受限环境（比如被沙箱限制 spawn 的会话）会直接 `EPERM`；CLI 模式走继承 stdio，哪儿都能跑。

构建时带 `--charset=utf8`。不带的话中文会被转义成 `\u5df2\u62e6\u622a` 这种，功能没影响，但脚本公开在 GreasyFork 上时没法读。

### 🕳 E2E 踩过的两个坑

第一个：Chrome 137+ 的正式版不再理会 `--load-extension`。`e2e.mjs` 换成 `--enable-unsafe-extension-debugging` 启动，再用 CDP 的 `Extensions.loadUnpacked` 把 `dist/extension` 装进去。

第二个更阴：伪造 B 站响应**必须**走 CDP 的 `Fetch` 域，在协议层拦。早期版本用「本地 HTTPS 服务器 + host-resolver-rules」，只要系统配了代理、或者真站刚好连得上，请求就绕过本地服务器了——测出来全是假的，而且看不出来。

还有个环境限制：受限沙箱里 Chrome 根本起不来（crashpad 的 OpenProcess 和 mojo 命名管道都会被拒，直接 self-terminating）。E2E 只能在普通桌面会话跑。

## 🧠 匹配原理

两层模型，共用一个判定函数：

```
页面 window.fetch ──► [拦截层 page.js] 改 JSON 响应，摘掉命中项 ──► 页面解析（卡片从未出现）
浏览器渲染后     ──► [DOM 兜底 content.js] 扫卡片 → 隐藏最外层网格单元（防空洞）
                              └──────── 同一个 matchTitle() ────────┘
```

**拦截层**是主路径。`page.js` 在 `document_start` 注入页面的 MAIN world，把 `fetch` 和 `XMLHttpRequest` 包起来。看到首页 feed 请求，等响应回来解析 JSON，命中项直接从数组里 splice 掉，再把改过的 JSON 交还给页面。

**DOM 兜底**管 SSR 首屏和接口没覆盖到的地方。隔离世界的 `content.js` 用 `MutationObserver` 扫卡片，命中就隐藏**最外层网格单元**——不是卡片本身，否则 masonry 列里会留一个和卡片等高的洞。

### 四级判定，从严到宽

| 级别 | 条件 | 用途 |
|---|---|---|
| `exact` | 归一后完全相同 | 最可靠 |
| `contain` | 互相包含，分数 = 长度比 | 加了前缀后缀的照搬 |
| `dice` | 字符 bigram 相似度 ≥ 阈值 | 等长改写 |
| `cover` | 短标题 bigram 被长标题覆盖的比例 ≥ 阈值 | 删减版。对称 Dice 会被长度差压到 0.6 漏掉，覆盖率能到 0.9 |

**归一**要做的事：全角转半角、转小写、去 emoji、去标点，再剥掉「知乎 / 如何看待 / 为什么 / 高赞 / 【】」这类模板词。不剥的话每个标题天然带 0.2~0.3 的虚高相似度，误伤基本都从这儿来。

**失败一律放行**。解析异常、列表没到、接口 401，全都原样返回原始响应。宁可不屏蔽，也不能白屏。

### 题库池

- 每次刷新把标题**并进**本地池，按归一标题去重，只更新 `lastSeen`
- 超过 `poolDays`（默认 30 天）没再出现就淘汰；总量超 `poolMax`（默认 800）按最旧的踢
- 满 7 天算「老条目」，匹配分数线自动 +0.05。池子大了以后，误伤几乎都来自旧标题
- 远端种子**整批替换**。作者删掉的条目，用户端下次同步就消失

上限为什么定 800 而不是 3000：`reports/pool-audit.md` 里，77 条题库只有 15.6% 能在 B 站搜到同题视频，72.7% 完全搜不到。池子再大，有效密度不变，只多摊一份误伤风险。

## 🧰 题库工具

```bash
node tools/build-seed.mjs --days 60            # 生成种子：热榜 + 日报往期（默认合并已有文件）
node tools/run-audit.mjs --seed seed.txt       # 体检：拿每条标题去 B 站搜，统计命中率
```

`build-seed` 默认**合并**已有 `seed.txt`，不覆盖。因为 GitHub Actions 的 runner 在境外，拉不到知乎日报——不合并的话，一次 CI 就能把几百条历史冲成 30 条。

体检结论（2026-11-01）：

| 指标 | 值 |
|---|---|
| 能在 B 站搜到同题视频 | 15.6% |
| 完全搜不到 | 72.7% |
| 日报（常青问题）命中率 | 17.0% |
| 热榜（时事）命中率 | 13.3% |

日报反而更高，这点挺反直觉。原因是搬运者做「知乎问答合集」时，往往直接把问题原文当标题；时事类不改写没人点，改了就匹配不上。

## 🚚 发布题库源

`seed.txt` 推上去之后，用户端按顺序试两个镜像：

```
1. https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/seed.txt
2. https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/seed.txt
```

| 地址形态 | 实测 | 缓存 |
|---|---|---|
| `gh-proxy.com/` + raw | 200，约 1.7s，内容最新；约 1/3 请求超时 | 无 |
| `fastly.jsdelivr.net/gh/...` | 200，约 1.7s | 边缘 12h，浏览器 7 天 |
| `cdn.jsdelivr.net` / `raw.githubusercontent.com` | ECONNRESET | — |

两个源互补：gh-proxy 快但抖，jsDelivr 稳但慢 12 小时。任一成功就算数。

jsDelivr 的 purge 接口清不掉 fastly 节点——返回 finished，`age` 照涨。别指望它。CI 里的 purge 步骤留着，反正无害。

## 🐞 调试

在 B 站页面控制台敲 `__zbbDebug`：

| 字段 | 含义 |
|---|---|
| `accepted` | 收到几次题库消息 |
| `hotLen` | 当前字典大小 |
| `settled` | 就绪信号触发次数（>0 说明放行条件已满足） |
| `fetchSrc` | `window.fetch` 是否已被接管 |

## 🐙 仓库操作

本机 `github.com` 不通，`git push` 用不了；只有 `api.github.com` 可达。所以用这两个脚本代替 git：

```bash
node tools/gh.mjs whoami | list | get <path> | put <file> | runs | run <workflow>
node tools/gh-sync.mjs <本地目录> [owner/repo]   # 按 blob sha 增量同步整个目录
```

token 从 `D:\test\.github-token` 或环境变量 `GITHUB_TOKEN` 读。
