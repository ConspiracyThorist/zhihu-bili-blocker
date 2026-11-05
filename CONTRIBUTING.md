# 贡献指南

欢迎 Issue 与 PR。改动前建议先读 [DEVELOP.md](DEVELOP.md)，了解架构与测试方式。

## 本地开发

```bash
npm install --ignore-scripts
npm run typecheck
npm test
npm run build
```

改完代码提交前跑一遍 `npm run check`（类型检查 + 单测 + 构建 + 冒烟）。

端到端测试需要能启动 Chrome 的桌面会话：

```bash
npm run e2e
```

## 提交 PR

- 一个 PR 只做一件事，避免把重构和功能混在一起
- 修 bug 请附上复现步骤；改匹配逻辑请说明依据（最好有真实标题样例）
- 调整阈值、门槛这类数值时，请附带数据，不要凭感觉

## 报告问题

请说明：浏览器版本、扩展/脚本版本、B 站页面（首页/搜索/播放页）、期望行为与实际行为。
能附上 `__zbbDebug` 的输出更好（B 站页面控制台执行）。

## 安全

安全问题不要开公开 Issue，见 [SECURITY.md](SECURITY.md)。
