# 知乎热榜屏蔽 B 站推荐

[![Release](https://img.shields.io/github/v/release/ConspiracyThorist/zhihu-bili-blocker?label=release)](https://github.com/ConspiracyThorist/zhihu-bili-blocker/releases)
[![License](https://img.shields.io/github/license/ConspiracyThorist/zhihu-bili-blocker)](LICENSE)
[![Chrome](https://img.shields.io/badge/Chrome-116%2B-blue)](https://www.google.com/chrome/)
[![Userscript](https://img.shields.io/badge/Userscript-Tampermonkey-orange)](https://www.tampermonkey.net/)

同步知乎热榜标题，与 B 站首页推荐流做模糊匹配，在**渲染前**移除搬运视频。提供 Chrome 扩展与油猴脚本两种形态。

## ✨ 特性

- **渲染前拦截**：在页面解析 feed JSON 之前移除命中项，卡片不会先出现再消失
- **只看标题**：不依赖 UP 主、分区、发布时间，换账号搬运同样生效
- **模糊匹配**：四级判定（精确 / 包含 / bigram 相似度 / 覆盖率），能识别加前后缀、删减、等长改写的搬运
- **本地题库**：热榜标题累积为本地词库，默认保留 30 天、上限 800 条，越界自动淘汰
- **远端同步**：每日从 CDN 拉取公共词库，首次安装即有 250+ 条可用
- **侧边栏设置**：浮窗里点「设置」，扩展页面在浏览器侧边栏展开，不遮挡页面内容
- **失败放行**：接口异常、解析失败、数据未就绪时原样返回，不影响正常浏览
- **纯本地运行**：不上传任何数据，权限仅 `storage`、`alarms` 与 `sidePanel`

## 🚀 安装

### Chrome 扩展

1. 从 [Releases](https://github.com/ConspiracyThorist/zhihu-bili-blocker/releases/latest) 下载 `zhihu-bili-blocker.zip` 并解压
2. 打开 `chrome://extensions`，启用「开发者模式」
3. 点击「加载已解压的扩展程序」，选择解压后的目录
4. 刷新 B 站首页

> 需要 Chrome 116 及以上（侧边栏 API 与 `world: "MAIN"` 注入都要求这个版本）。
>
> 下载缓慢时可在链接前加 `https://gh-proxy.com/` 走镜像。

### 油猴脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 点击下方链接，Tampermonkey 会自动弹出安装页

   ```
   https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/zhihu-bili-blocker.user.js
   ```

3. 刷新 B 站首页

备用地址（CDN 不可用时）：

```
https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/zhihu-bili-blocker.user.js
```

> 油猴脚本不随 Release 发布，仅在仓库中维护，源码见 [zhihu-bili-blocker.user.js](zhihu-bili-blocker.user.js)。

## 📖 使用

### 页面浮窗

右下角浮窗显示两个数值：**已拦截**（本次页面加载后拦截数）与**累计**（历史总数）。点击展开最近 5 条记录，可对单条执行「放行」。浮窗支持拖拽，位置会持久化。

展开面板右上角的「设置 ↗」会在浏览器侧边栏打开扩展页面，可以边刷 B 站边调参数，不用来回切换标签页。侧边栏不可用时（旧版本或被策略限制）会退化为一个独立小窗口。

### 扩展弹窗

| 控件 | 说明 |
| --- | --- |
| 总开关 | 关闭后立即恢复已隐藏的卡片，无需刷新 |
| 拦截强度 | 保守 / 标准 / 激进三档预设 |
| 统计 | 最近记录、累计拦截、题库条目数 |
| 最近拦截 | 显示「B 站标题 ← 知乎标题 + 匹配分数」，可加入白名单 |

刷新热榜、远端题库源等设置位于「高级设置」中。

### 拦截强度

| 档位 | 阈值 | 适用场景 |
| --- | --- | --- |
| 保守 | 0.86 | **默认**。只拦几乎原样照搬的，误伤率最低 |
| 标准 | 0.72 | 兼顾拦截率与误伤率 |
| 激进 | 0.66 | 拦截改写幅度较大的搬运，误伤率上升 |

需要精确控制时，可在「高级设置」中直接调整阈值。

## ❓ 常见问题

**看到搬运视频但未被拦截？**

先查看弹窗中的匹配分数。分数偏低说明标题相似度不足，可尝试切换至「激进」档位。若原标题被大幅改写，则超出当前匹配能力范围。

**正常视频被误拦截？**

点击「放行」加入白名单，或提高拦截强度档位。

**题库数量长时间不增长？**

知乎热榜每日更新约 20~30 条，30 天窗口的稳定容量为数百条。此外，仅约 15% 的词条能在 B 站找到对应视频，数量停滞属正常现象。

**弹窗显示「从未成功」或同步失败？**

通常为知乎接口偶发 403 或远端题库源不可达。点击刷新可查看具体错误，扩展会继续使用上一次成功的数据。

**B 站改版后完全失效？**

需更新选择器。相关逻辑集中在 `src/core/dom.ts`，通常为少量改动。

## 🔒 隐私

本扩展不上传任何数据。题库、配置与拦截记录均存储于浏览器本地。

网络请求仅涉及两个域名：B 站首页接口与知乎热榜接口。扩展权限仅申请 `storage` 与 `alarms`，未申请 `cookies`，无法读取账号信息。

## ⚠️ 限制

- 仅覆盖 B 站首页推荐流，不含热门榜、搜索结果与播放页侧栏
- 仅比对标题，不分析视频内容、UP 主与评论
- 中文短标题存在天然语义碰撞，无法保证零误伤，因此保留阈值与白名单双重兜底

## 🧭 工作原理

在页面解析推荐数据前修改 feed JSON，移除命中条目；接口未覆盖的首屏卡片由 DOM 层补充隐藏。

实现细节见 [DEVELOP.md](DEVELOP.md)。

## 🤝 贡献

欢迎提交 Issue 与 Pull Request。修改代码前建议先阅读 [DEVELOP.md](DEVELOP.md) 了解架构与测试方式。

## 📄 许可证

[MIT](LICENSE)
