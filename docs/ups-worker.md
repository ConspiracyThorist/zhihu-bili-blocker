# 投稿后端部署（Cloudflare Worker）

用户点「屏蔽此 UP」时，扩展会静默把 `{mid, name}` 发到这里排队。
这里不做判断，只排队；校验在 CI（`.github/workflows/up-review.yml`）。

## 一、准备

需要一个 Cloudflare 账号（免费额度足够：每天 10 万次请求、KV 1 GB）。

```bash
npm install -g wrangler
wrangler login
```

## 二、建 KV 命名空间

```bash
cd worker
wrangler kv namespace create UPS_QUEUE
```

输出里会有一行 `id = "xxxxxxxx"`，把它填进 `wrangler.toml` 的 `id` 字段（替换 `REPLACE_WITH_KV_ID`）。

## 三、设置口令

```bash
# 生成一个随机串，CI 和 Worker 用同一个
openssl rand -hex 32
wrangler secret put SUBMIT_TOKEN
```

## 四、部署

```bash
wrangler deploy
```

成功后拿到形如 `https://zbb-ups.<你的子域>.workers.dev` 的地址。

## 五、接回仓库

1. **扩展端**：把地址填进 `src/core/types.ts` 的 `DEFAULT_SETTINGS.upsEndpoint`
2. **CI 端**：仓库 → Settings → Secrets and variables → Actions，加两个 secret：

| Secret | 值 |
| --- | --- |
| `UPS_ENDPOINT` | `https://zbb-ups.<子域>.workers.dev` |
| `UPS_TOKEN` | 第三步生成的随机串 |

3. 手动跑一次 `up-review` 工作流验证：

```bash
gh workflow run up-review
```

## 六、验证

```bash
# 投稿（模拟客户端）
curl -X POST https://zbb-ups.<子域>.workers.dev/submit \
  -H 'content-type: application/json' \
  -d '{"mid":123456,"name":"测试"}'

# 看队列（需要 token）
curl https://zbb-ups.<子域>.workers.dev/pending \
  -H "authorization: Bearer <token>"
```

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/submit` | 无 | 入队，同 IP 每天限 20 次 |
| GET | `/pending` | Bearer | 列出待审核，按提交次数降序 |
| DELETE | `/pending/:mid` | Bearer | 处理完出队 |

队列条目 60 天后自动过期；同一 IP 的每日计数 48 小时后过期。

## 没有部署也能用

`upsEndpoint` 留空时，扩展不会发送任何请求，手动屏蔽仍只写入本地库。
投稿功能整体降级，不影响屏蔽效果。
