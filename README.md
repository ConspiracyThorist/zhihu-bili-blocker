# zhihu-bili-blocker-seed

[知乎热榜屏蔽B站推荐](https://github.com/ConspiracyThorist/zhihu-bili-blocker-seed) 扩展的题库种子文件。

## 用法

扩展 popup 里「远端题库源」填：

```
https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker-seed@main/seed.txt
```

> 不要用 `raw.githubusercontent.com`——国内多数网络访问不了，jsDelivr 是 GitHub 的 CDN 镜像。

## 文件格式

纯文本，一行一条标题，`#` 开头是注释。

当前 230 条：知乎热榜 + 知乎日报往期（常青问题）。

## 更新

```bash
node tools/build-seed.mjs --days 60
```

生成后覆盖本文件提交即可。jsDelivr 缓存 7 天，急用时可以打 tag 或等一天。
