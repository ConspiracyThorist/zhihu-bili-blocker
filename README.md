# 知乎热榜屏蔽 B 站推荐

把「知乎热榜」当过滤字典：同步热榜标题，对 B 站首页推荐里的视频标题做模糊匹配，命中就在**渲染前**摘掉——不是先显示再消失。

同一套匹配内核出两个产物：**Chrome 扩展**（MV3）和**油猴脚本**（可发布到 GreasyFork）。

---

## 装哪个？

| | Chrome 扩展 | 油猴脚本 |
|---|---|---|
| 适合 | 日常主力，UI 完整 | 不想装扩展 / 已在用 Tampermonkey |
| 产物 | `dist/zhihu-bili-blocker.zip` | `dist/zhihu-bili-blocker.user.js` |
| 热榜更新 | 后台每 45 分钟 | 打开页面时，超过 30 分钟则刷新 |

两个都装也不会冲突：隐藏是幂等的，重复命中不会有多余副作用。

### 装扩展

1. 解压 `dist/zhihu-bili-blocker.zip`（或直接用 `dist/extension/` 目录）
2. 地址栏打开 `chrome://extensions`
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」，选中解压出的目录
5. 刷新 B 站首页

> 要求 Chrome 111+（用到 `world: "MAIN"` 的 content script）。当前用的是 Chrome 156，没问题。

### 装油猴脚本

1. 装 [Tampermonkey](https://www.tampermonkey.net/)
2. 打开 Tampermonkey 面板 →「添加新脚本」，把 `dist/zhihu-bili-blocker.user.js` 全文粘进去保存；或直接把该文件拖进浏览器
3. 刷新 B 站首页，右下角出现「知」按钮

### 发布到油叉（GreasyFork）

元信息块已经在构建时生成好了（`@name` / `@namespace` / `@version` / `@match` / `@grant` / `@connect` / `@license MIT`）。发布步骤：

1. 登录 GreasyFork →「发布脚本」
2. 脚本代码粘贴 `dist/zhihu-bili-blocker.user.js` 全文
3. 描述里可写：屏蔽首页推荐中「搬运知乎问题」的视频；热榜本地缓存，不上传任何数据
4. 首次发布后记得把 `@namespace` 保持为 `zhihu-bili-blocker`，后续更新才会被识别为同一脚本

---

## 怎么用

点扩展图标（或油猴右下角「知」）打开面板：

- **总开关**：关掉即刻生效，已隐藏的卡片会立刻恢复
- **相似度阈值**：默认 `0.72`。往左更严（少误伤），往右更宽（多拦截）
- **立即刷新热榜**：手动拉一次，失败时会显示上次成功时间
- **最近屏蔽**：列出「B 站标题 ← 对应知乎标题 + 分数」，点「放行」把它加进白名单，以后不再屏蔽

### 阈值怎么调

| 现象 | 动作 |
|---|---|
| 明显是搬运的还在 | 调低到 0.68~0.70 |
| 误伤了正常视频 | 调高到 0.78~0.82，或直接点「放行」 |
| 只想杀原样照搬的 | 0.85 以上 |

改动立刻对后续加载生效，不用重装。

---

## 原理

两层模型，共用同一个判定函数：

```
页面 window.fetch ──► [拦截层 page.js] 改 JSON 响应，摘掉命中项 ──► 页面解析（卡片从未出现）
浏览器渲染后     ──► [DOM 兜底 content.js] 扫卡片 → 隐藏最外层网格单元（防空洞）
                              └──────── 同一个 matchTitle() ────────┘
```

1. **拦截层（主路径）**：`page.js` 在 `document_start` 注入页面 MAIN world，包住页面的 `fetch`（以及 `XMLHttpRequest`）。检测到首页 feed 请求，等响应回来后解析 JSON，把命中的卡片从数组里 `splice` 掉，再把改过的 JSON 交还给页面。因为发生在页面解析之前，卡片从头到尾不会出现。
2. **DOM 兜底**：SSR 首屏或接口没覆盖到的卡片，由隔离世界的 `content.js` 用 `MutationObserver` 扫描，命中则隐藏——隐藏的是最外层网格单元而非卡片本身，避免 masonry 列里留下与卡片等高的空白洞。
3. **匹配**：命中三级，从严到宽
   - `exact`：归一后完全相同
   - `contain`：互相包含，用长度比做分数
   - `dice`：字符 bigram 相似度 ≥ 阈值
   - `cover`：短标题的 bigram 有多大比例出现在长标题里（专治「B 站标题是知乎原题的删减版」——这种场景对称 Dice 会被长度差压到 0.6 而漏判）
4. **归一**：全角转半角、小写、去 emoji、去标点，再剥掉「知乎 / 如何看待 / 为什么 / 高赞 / 【】」这类模板词。不剥的话每个标题都天然带 0.2~0.3 的虚高相似度，正是误伤主因。

**失败一定放行**：解析异常、列表没到、接口 401，全都原样返回原始响应。宁可不屏蔽，也不能白屏。

### 题库是怎么长的

不是「每次拉 30 条热榜就替换」——那样只覆盖今天，而搬运视频通常滞后热榜 1~3 天。实际做法：

- 每次刷新把拉到的标题**并入**本地池，按归一标题去重，只更新 `lastSeen`
- 超过 `poolDays`（默认 30 天）没再出现的条目淘汰；总量超 `poolMax`（默认 800）按最旧踢
- 超过 7 天的条目算「老条目」，匹配分数线自动 +0.05——池子变大后误伤几乎都来自旧标题
- 远端种子文件**整批替换**：作者删掉的条目，用户端下次同步就消失

**为什么上限是 800 不是 3000**：2026-11-01 做了题库体检（`reports/pool-audit.md`），77 条题库里只有 15.6% 能在 B 站搜到同题视频，72.7% 完全搜不到。条目再多，有效密度不变，只增误伤。

---

## 验证情况

| 层 | 结果 |
|---|---|
| TypeScript 严格模式 | 0 error |
| 单元测试 | 44 条断言：归一 / Dice / 覆盖率 / 判定 / 剪枝 / URL / hook / **题库池** / **老条目阈值** |
| 产物冒烟 | 8 项，直接执行 `dist` 里的 `page.js`，验证桥 + 拦截 + 回报 |
| 浏览器端到端 | **25 项**，headless Chrome + CDP 协议层伪造响应 |

E2E 覆盖：拦截层 3 条摘到 1 条、DOM 隐藏与防留白、命中记录落库、关开关恢复、401 降级不白屏、popup 渲染、定时器周期跟随配置、远端题库同步与整批替换。

两个只有真浏览器能抓到的问题，都已修：

1. **首屏竞态**：content 侧读完 storage 前先回了一个空列表，MAIN 侧据此判定"就绪"，首屏请求就带着空字典放行了（表现为"DOM 兜底生效、拦截层不生效"）。现在空列表不算就绪。
2. **同步假成功**：`SYNC_SEED` 无论成败都回 `ok: true`，popup 上看着成功、池子其实是空的。现在按 `remote.error` 判定。

> E2E 早期用「本地 HTTPS 服务器 + host-resolver-rules」伪造 B 站，后来发现系统代理或真站可达时会直接绕过去，改成了 CDP 的 `Fetch` 域在协议层伪造响应，不再依赖 DNS/TLS。

---

## 目录

```
src/core/          与宿主无关：归一、相似度、判定、JSON 剪枝、URL 识别、fetch hook、DOM 扫描、题库池
src/extension/     扩展壳：background(取数+题库同步) / page(MAIN world) / content(桥+DOM) / popup
src/userscript/    油猴壳：同一个 core，换成 GM_* 适配 + 悬浮面板
tools/             build-seed.mjs 生成题库种子 / audit.ts 题库体检 / bili-search.mjs wbi 签名搜索
seed.txt           题库种子（230 条），可直接传 Gitee / GitHub
reports/           体检报告（pool-audit.md）
tests/             单测(44 条) / 产物冒烟(8 项) / 浏览器端到端(25 项)
build.mjs          esbuild 双出口 + 打 zip（自带极简 zip 写入器，无三方依赖）
```

---

## 开发

```bash
npm install --ignore-scripts   # esbuild 的原生二进制已在 @esbuild/win32-x64 里，装包脚本可以跳过
npm run typecheck
npm test        # 44 条断言
npm run build   # 出 dist/extension、dist/zhihu-bili-blocker.zip、dist/zhihu-bili-blocker.user.js
npm run smoke   # 直接执行打包产物，验证桥 + hook + 剪枝接线

node tools/build-seed.mjs --days 60   # 生成题库种子：热榜 + 日报往期
node tools/run-audit.mjs --seed seed.txt   # 题库体检：拿每条标题去 B 站搜，统计命中率
```

`npm run e2e` 是 25 项浏览器端到端，需要能正常启动 Chrome 的会话。

> Chrome 137+ 的正式版已不再理会 `--load-extension`，`e2e.mjs` 改用 `--enable-unsafe-extension-debugging` 启动 + CDP `Extensions.loadUnpacked` 加载扩展。
> 在受限沙箱里 Chrome 起不来（crashpad 的 OpenProcess 与 mojo 命名管道会被拒），会直接 self-terminating。

`build.mjs` 走 esbuild 的 CLI 二进制而不是 JS API——JS API 靠管道和子进程通信，在受限环境（比如被沙箱限制 spawn 的会话）会 `EPERM`，CLI 模式用继承 stdio，在哪都能跑。

### 发布题库源

`seed.txt` 传到仓库后，把地址填进 popup 的「远端题库源」。**默认已经配好两个源**（按序尝试）：

```
1. https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/seed.txt
2. https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/seed.txt
```

国内网络实测：

| 地址形态 | 实测 | 缓存 |
|---|---|---|
| `gh-proxy.com/` + raw 地址 | ✅ 200，3.8s，**内容最新** | 无 |
| `fastly.jsdelivr.net/gh/...@main/...` | ✅ 200，3s | 边缘 12h，浏览器 7 天 |
| `cdn.jsdelivr.net/...` | ❌ ECONNRESET | — |
| `raw.githubusercontent.com/...` | ❌ ECONNRESET | — |
| `gitee.com/.../raw/...` | ✅ 200，76ms | 无 |

**仓库放 GitHub 没问题，分发走镜像。** 两个源是互补的：gh-proxy 能立刻拿到更新，jsDelivr 更稳但更新有 12 小时延迟；任一成功即用。

> 本机 `github.com` 被墙（`git push` 不可用），但 `api.github.com` 可达，所以题库是通过 REST API 上传的。`tools/build-seed.mjs` 现在默认**合并**已有文件——GitHub Actions 的 runner 拉不到知乎日报，不合并的话会把几百条历史冲成 30 条。


---

## 排错

| 症状 | 排查 |
|---|---|
| 面板显示「从未成功」 | 知乎接口偶发 403；点「刷新热榜」看错误详情。扩展会保留上一次成功的池子继续用 |
| 「同步题库」点了没反应 | 看面板红字：多半是地址不通或文件格式不对（要求一行一条、≥10 条）。也可在 popup 里看「远端题库源」那行的时间 |
| 题库一直不涨 | 正常。热榜每天只换 20~30 条，30 天窗口的稳态大约是几百条；体检显示其中只有 15% 左右能在 B 站搜到对应视频 |
| 明明有搬运没屏蔽 | 阈值调低到 0.68；或那条视频标题被大幅改写（体检里占 11.7%），属于字面匹配的上限，需要语义检索 |
| 正常视频被误伤 | 点「放行」加入白名单；或把阈值调到 0.8 以上 |
| B 站改版后完全失效 | 选择器在 `src/core/dom.ts` 的 `CARD_SELECTORS` 集中管理；接口路径规则在 `src/core/urlFilter.ts`，改完 `npm run build` 即可 |
| 想确认 hook 装没装上 | 在 B 站页面控制台输入 `__zbbDebug`：`accepted` 是收到几次题库消息，`hotLen` 是当前字典大小，`settled` 是就绪信号触发次数，`fetchSrc` 能看到 `window.fetch` 是否已被接管 |
| 首页白屏 | 不该发生：任何异常都会原样放行。若真遇到，先关总开关确认是不是本插件，再在控制台看是否有报错 |

已知限制：

- 只覆盖**首页推荐**（`/feed/rcmd`），不含热门、搜索、播放页侧栏
- 只匹配标题，不看视频内容、UP 主
- 热榜接口无登录态时返回 30 条；在浏览器里登录知乎后第二个数据源可拿到更多
- 不算「绝对不误伤」的算法：中文短标题天然存在语义碰撞，所以保留了阈值 + 白名单两道人肉兜底
