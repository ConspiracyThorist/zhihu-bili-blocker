# 安全说明

本文件记录这个项目的信任边界、已做的防护，以及已知的残余风险。
发现安全问题请开 Issue（不要公开贴可利用细节）。

## 数据流

```
B 站页面 ──(只读 DOM / 改写自身 fetch 响应)──> 本地匹配 ──> 隐藏卡片
知乎接口 ──> 本地题库（chrome.storage.local / GM 存储）
CDN 上的 seed.txt / ups.json ──> 本地题库与 UP 库
手动拉黑 UP ──(仅 mid + 昵称)──> 投稿端点 ──> 审核队列 ──> CI ──> ups.json
```

**不会离开本机的数据**：浏览记录、B 站账号、知乎账号、屏蔽历史、个人 UP 库。
**会上行的数据**：仅当你手动点「屏蔽此 UP」时，该 UP 的 `mid` 与昵称（可在设置关闭）。

## 权限

| 权限 | 用途 | 是否可省 |
| --- | --- | --- |
| `storage` | 存题库、设置、记录 | 不可省 |
| `alarms` | 定时刷新 | 不可省 |
| `sidePanel` | 侧边栏展示设置页 | 可省（退化为弹窗） |

`host_permissions` 只包含：B 站、知乎接口、题库 CDN，以及**两个具体投稿端点**（不是整个 `*.workers.dev` / `*.fcapp.run` 通配）。
未申请 `cookies`、`tabs`、`webRequest`、`<all_urls>`。

## 端点防护

| 项 | 做法 |
| --- | --- |
| 公开提交口 | 只收 `{mid, name}`，mid 必须是正整数且在合理范围 |
| 限流 | 每 IP 每日 20 次（`RATE_LIMIT` 可调） |
| 队列上限 | 2000 条，满了返回 503，避免被刷爆存储 |
| 管理接口 | `GET /pending`、`DELETE /pending/:mid` 需要 Bearer 口令 |
| 口令比较 | 定长比较（`timingSafeEqual` / 手写常量时间比较），不用 `!==` |
| 默认令牌 | 32 字节随机十六进制，只存在端点环境变量与本地 `deploy-result.json` |

CORS 为 `*`：端点是公开的，扩展需要从任意页面调用；安全依赖限流与队列上限，而不是来源限制。

## 客户端防护

- 所有远端内容（题库标题、UP 昵称）只通过 `textContent` 渲染，**不拼 HTML**
- 浮窗样式与结构是静态模板，`innerHTML` 里没有插值
- 不使用 `eval` / `new Function` / `document.write`（测试脚本除外）
- 页面与内容脚本之间的 `postMessage` 校验 `event.source === window`
- 远端题库读取有 512 KB 上限，避免被塞巨大文件拖垮
- 匹配失败、解析异常一律放行，不会让页面白屏

## 已知残余风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 端点可被刷 | 公开 POST，理论上可用大量 IP 灌队列 | 限流 + 队列上限 2000 + 审核时才拉数据 |
| 昵称可伪造 | `name` 字段来自页面 DOM | 只用于展示，判定只看 mid 与作品匹配 |
| 客户端可被改 | 用户可改扩展代码伪造提交 | 审核在服务端（CI）完成，客户端只投票 |
| 词库内容可信度 | 远端 `seed.txt` 由本仓库 CI 产出 | 仓库只接受维护者提交 |
| DNS 污染 | 国内直连 `workers.dev` 不可用 | 主用国内端点，境外 Worker 作兜底 |

## 历史事件

- **2026-11-05**：`worker/deploy-result.json` 曾误提交到公开仓库，内含 Cloudflare 的 CI 口令。
  已删除、已将口令轮换作废、已加入同步与 git 忽略列表。旧口令在 commit 历史里仍可见，但已失效。

## 本地敏感文件

以下文件含口令，**不进仓库**（均在 `.gitignore` 与同步排除列表里）：

```
D:\test\.github-token             GitHub PAT
D:\test\.cf-token                 Cloudflare API Token
D:\test\.aliyun-ak                阿里云 AK/SK
worker/deploy-result.json         Cloudflare 部署结果 + 口令
worker-cn/deploy-result.json      阿里云部署结果 + 口令
```
