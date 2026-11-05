# 国内云函数部署（阿里云）

`*.workers.dev` 在国内被 DNS 污染（实测解析到 Facebook 的 IP，真实 IP 也不可达），
所以客户端投稿要落到国内。这里用**阿里云函数计算 FC + OSS**：
一个 HTTP 端点收投稿，队列存在 OSS 的一个 JSON 文件里。

Cloudflare 那套**保留作备用**：客户端支持多个接收端，按顺序试，
国内通了就不打备用（见 `upsEndpoints`）。

---

## 一、准备账号（约 10 分钟）

1. 注册 <https://www.aliyun.com>，用支付宝或手机号
2. 完成**实名认证**（个人，扫脸）
3. 开通两个服务（都是免费额度内，不绑卡也能开）：
   - **函数计算 FC**：<https://fc.console.aliyun.com>
   - **对象存储 OSS**：<https://oss.console.aliyun.com>

> 不需要备案。FC 自带的公网域名（`*.fcapp.run`）可以直接 HTTPS 访问。

## 二、给一个最小权限的 AccessKey

1. 打开 RAM 控制台 → 用户 → 创建用户，勾选「OpenAPI 调用访问」
2. 生成 AccessKey，保存好 ID 和 Secret
3. 给这个用户挂两个系统策略：
   - `AliyunFCFullAccess`
   - `AliyunOSSFullAccess`

把两行写进文件（不要贴聊天里）：

```
D:\test\.aliyun-ak
第一行：AccessKeyId
第二行：AccessKeySecret
```

## 三、剩下的事我来做

有了 AK/SK，我会：

1. 建 OSS Bucket（就近地域，如 `oss-cn-hangzhou`），私有读
2. 打包 `worker-cn/src/index.ts`（含 ali-oss 依赖）
3. 创建 FC 3.0 函数（Node.js 20，通过 HTTP 触发器暴露）
4. 写入环境变量：`OSS_*`、`SUBMIT_TOKEN`（随机生成）
5. 拿到公网地址，做一次冒烟测试
6. 更新 `DEFAULT_SETTINGS.upsEndpoints`：国内地址在前，Cloudflare 地址在后
7. 告诉你两个值，填进仓库 Secrets：`UPS_ENDPOINT`、`UPS_TOKEN`

## 四、如果你想手工做

不想给 AK/SK 的话，也可以自己在控制台点：

<details>

1. OSS 建 Bucket，记下地域和名字
2. FC 控制台 → 创建函数 → 运行环境 `Node.js 20` → 上传代码（`worker-cn` 目录打 zip，含 `node_modules`）
3. 函数配置 → 环境变量：
   - `OSS_REGION`、`OSS_BUCKET`、`OSS_AK`、`OSS_SK`
   - `SUBMIT_TOKEN`：随便生成一个 32 字节十六进制串
4. 函数配置 → 触发器 → 创建 HTTP 触发器，认证方式选「无需认证」
5. 拿到形如 `https://xxx.cn-hangzhou.fcapp.run` 的地址
6. 验证：

```bash
curl -X POST https://xxx.cn-hangzhou.fcapp.run/submit \
  -H 'content-type: application/json' \
  -d '{"mid":85764029,"name":"测试"}'

curl https://xxx.cn-hangzhou.fcapp.run/pending \
  -H "authorization: Bearer <SUBMIT_TOKEN>"
```

</details>

## 五、接口

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/submit` | 无 | 入队，同 IP 每日 20 次 + 全局每小时 500 次 |
| GET | `/pending` | Bearer | 列出待审核 |
| DELETE | `/pending/:mid` | Bearer | 出队 |

## 六、成本

- FC：每月 100 万次调用 + 40 万 GB·秒，投稿量级远低于此
- OSS：队列文件几 KB，流量可忽略
- 实际花费：**0 元**，除非被刷

## 七、备用链路

`upsEndpoints` 是数组，按序尝试：

```ts
upsEndpoints: [
  'https://xxx.cn-hangzhou.fcapp.run',        // 国内，优先
  'https://zbb-ups.zbb-eaa69b.workers.dev',   // 境外兜底（国内不通，但 CI 能用）
],
```

国内端点不通时自动退到备用；两个都不通就把条目留在本地 outbox，下次再补发。

## 八、安全

- 端点公开，任何人可 POST。缓解：按 IP 每日限额 + 队列只收 mid，不含用户数据
- AK/SK 只存在函数环境变量里，不进代码、不进仓库
- 队列条目 60 天未被处理会被 CI 自然清掉（审核后出队）
