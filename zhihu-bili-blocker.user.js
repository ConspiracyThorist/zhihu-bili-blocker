// ==UserScript==
// @name         知乎热榜屏蔽B站推荐
// @name:en      Zhihu Hot List Blocker for Bilibili
// @namespace    zhihu-bili-blocker
// @version      1.0.0
// @description  把知乎热榜当过滤字典，在 B 站首页推荐里按标题模糊匹配，命中就在渲染前摘掉搬运视频
// @description:en  Block Bilibili home feed videos that copy Zhihu hot-list questions, matched by title before render
// @author       ConspiracyThorist
// @homepageURL  https://github.com/ConspiracyThorist/zhihu-bili-blocker
// @supportURL   https://github.com/ConspiracyThorist/zhihu-bili-blocker/issues
// @icon         https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/assets/icons/icon128.png
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.zhihu.com
// @connect      www.zhihu.com
// @connect      gh-proxy.com
// @connect      workers.dev
// @connect      fcapp.run
// @connect      fastly.jsdelivr.net
// @connect      raw.githubusercontent.com
// @license      MIT
// @noframes
// ==/UserScript==

"use strict";
(() => {
  // src/core/dice.ts
  function bigrams(s) {
    const map = /* @__PURE__ */ new Map();
    if (s.length < 2) {
      if (s.length === 1) map.set(s, 1);
      return map;
    }
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      map.set(g, (map.get(g) ?? 0) + 1);
    }
    return map;
  }
  function diceCoefficient(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const left = bigrams(a);
    const right = bigrams(b);
    let overlap = 0;
    let total = 0;
    for (const [g, n] of left) {
      total += n;
      const m = right.get(g);
      if (m) overlap += Math.min(n, m);
    }
    for (const n of right.values()) total += n;
    if (total === 0) return 0;
    return 2 * overlap / total;
  }
  function bigramCoverage(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const left = bigrams(a);
    const right = bigrams(b);
    let overlap = 0;
    let totalA = 0;
    let totalB = 0;
    for (const [g, n] of left) {
      totalA += n;
      const m = right.get(g);
      if (m) overlap += Math.min(n, m);
    }
    for (const n of right.values()) totalB += n;
    const denominator = Math.min(totalA, totalB);
    if (denominator === 0) return 0;
    return overlap / denominator;
  }

  // src/core/normalize.ts
  var TEMPLATE_WORDS = [
    "是一种什么样的体验",
    "是一种怎样的体验",
    "是一种什么体验",
    "是怎样的一种体验",
    "是一种什么感受",
    "如何看待",
    "怎样看待",
    "怎么看待",
    "如何评价",
    "怎么评价",
    "是怎样的体验",
    "是什么体验",
    "是什么意思",
    "有哪些",
    "为什么",
    "是什么",
    "高赞回答",
    "高赞",
    "神回复",
    "热榜",
    "搬运",
    "知乎",
    "问题"
  ].sort((a, b) => b.length - a.length);
  var EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
  var PUNCT_RE = /[\p{P}\p{S}\s]/gu;
  function toHalfWidth(input) {
    let out = "";
    for (const ch of input) {
      const code = ch.codePointAt(0);
      if (code === 12288) {
        out += " ";
      } else if (code >= 65281 && code <= 65374) {
        out += String.fromCodePoint(code - 65248);
      } else {
        out += ch;
      }
    }
    return out;
  }
  function normalize(input) {
    if (!input) return "";
    let s = toHalfWidth(input).toLowerCase();
    s = s.replace(EMOJI_RE, " ");
    s = s.replace(PUNCT_RE, "");
    for (const word of TEMPLATE_WORDS) {
      if (s.includes(word)) s = s.split(word).join("");
    }
    return s.trim();
  }

  // src/core/engine.ts
  var NO_HIT = { hit: false, score: 0, zhihuTitle: "", reason: "none" };
  function round(n) {
    return Math.round(n * 1e3) / 1e3;
  }
  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }
  function prepareHot(titles) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const raw of titles) {
      if (typeof raw !== "string") continue;
      const norm = normalize(raw);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push({ raw, norm });
    }
    return out;
  }
  function matchTitle(biliTitle, hot, settings) {
    if (!settings.enabled || hot.length === 0) return NO_HIT;
    const norm = normalize(biliTitle);
    if (!norm) return NO_HIT;
    for (const raw of settings.whitelist) {
      const nw = normalize(raw);
      if (!nw) continue;
      if (norm === nw || norm.includes(nw) || nw.includes(norm)) return NO_HIT;
    }
    const threshold = clamp(settings.threshold, 0.5, 0.98);
    const minLen = Math.max(2, settings.minLen);
    let best = NO_HIT;
    for (const entry of hot) {
      const entryThreshold = Math.min(0.98, threshold + (entry.stale ? 0.05 : 0));
      if (entry.norm === norm) {
        return { hit: true, score: 1, zhihuTitle: entry.raw, reason: "exact" };
      }
      if (norm.length >= 2 && entry.norm.length >= 2) {
        const shorter = norm.length <= entry.norm.length ? norm : entry.norm;
        const longer = shorter === norm ? entry.norm : norm;
        if (longer.includes(shorter)) {
          const ratio = shorter.length / longer.length;
          const need = shorter.length < minLen ? Math.max(0.95, entryThreshold) : Math.max(0.55, entryThreshold);
          if (ratio >= need && ratio > best.score) {
            best = { hit: true, score: round(ratio), zhihuTitle: entry.raw, reason: "contain" };
          }
        }
      }
      if (norm.length >= minLen) {
        const score = diceCoefficient(norm, entry.norm);
        if (score >= entryThreshold && score > best.score) {
          best = { hit: true, score: round(score), zhihuTitle: entry.raw, reason: "dice" };
        }
        const cover = bigramCoverage(norm, entry.norm);
        if (cover >= entryThreshold && cover > best.score) {
          best = { hit: true, score: round(cover), zhihuTitle: entry.raw, reason: "cover" };
        }
      }
    }
    return best;
  }

  // src/core/dom.ts
  var CARD_SELECTORS = [
    ".bili-video-card",
    ".bili-video-card.is-rcmd",
    ".feed-card",
    'div[class*="bili-video-card"]',
    ".recommended-container .bili-video-card"
  ];
  var TITLE_SELECTORS = [".bili-video-card__info--tit", 'h3[class*="tit"]', "a[title]"];
  var STYLE_ID = "zbb-style";
  function extractTitle(card) {
    for (const sel of TITLE_SELECTORS) {
      const el = card.querySelector(sel);
      if (!el) continue;
      const text = (el.getAttribute("title") ?? el.textContent ?? "").trim();
      if (text) return text;
    }
    return "";
  }
  function hideCard(card) {
    let target = card;
    for (let i = 0; i < 2; i += 1) {
      const parent = target.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      const cls = typeof parent.className === "string" ? parent.className : "";
      if (parent.childElementCount === 1 && !/container|col_|content|main|feed-content/i.test(cls)) {
        target = parent;
        continue;
      }
      break;
    }
    target.setAttribute("data-zbb", "1");
  }
  function ensureStyle(doc = document) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = '[data-zbb="1"]{display:none!important}';
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  var UP_STYLE_ID = "zbb-up-style";
  function cardOwner(card) {
    const link = card.querySelector('a[href*="space.bilibili.com"]');
    const href = link?.getAttribute("href") ?? "";
    const mid = Number(href.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? 0);
    if (!mid) return null;
    const name = card.querySelector('.bili-video-card__info--author, .up-name, [class*="author"]')?.textContent?.trim() ?? "";
    return { mid, name: name.slice(0, 40) };
  }
  function ensureUpStyle(doc) {
    if (doc.getElementById(UP_STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = UP_STYLE_ID;
    style.textContent = `
[data-zbb-up] {
  position: absolute; top: 6px; right: 6px; z-index: 20;
  padding: 3px 8px; border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.28);
  background: rgba(20,22,27,.82); color: #fff;
  font: 11px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  opacity: 0; transition: opacity .15s; backdrop-filter: blur(6px);
}
a:hover > [data-zbb-up], div:hover > [data-zbb-up], [data-zbb-up]:hover { opacity: 1; }
[data-zbb-up]:hover { border-color: #fb7299; color: #fb7299; }
.bili-video-card, .feed-card { position: relative; }
`;
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  function attachUpButton(card, owner, onBlock) {
    if (card.querySelector("[data-zbb-up]")) return;
    ensureUpStyle(card.ownerDocument ?? document);
    const btn = document.createElement("button");
    btn.setAttribute("data-zbb-up", "1");
    btn.textContent = "屏蔽此 UP";
    btn.title = `把 ${owner.name || owner.mid} 加入 UP 库，此后其视频不再出现在首页`;
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onBlock(owner);
    });
    card.appendChild(btn);
  }
  function startScanner(opts) {
    const seen = /* @__PURE__ */ new WeakSet();
    let timer = 0;
    let stopped = false;
    const scan = () => {
      if (stopped) return;
      const settings = opts.settings();
      if (!settings.enabled) return;
      const hot = opts.hot();
      if (hot.length === 0) return;
      ensureStyle();
      const cards = document.querySelectorAll(CARD_SELECTORS.join(","));
      cards.forEach((card) => {
        if (seen.has(card)) return;
        seen.add(card);
        if (opts.onCard?.(card) === true) return;
        const title = extractTitle(card);
        if (!title) return;
        const result = matchTitle(title, hot, settings);
        if (!result.hit) return;
        hideCard(card);
        opts.onHit(title, result);
      });
    };
    const schedule = () => {
      if (timer || stopped) return;
      timer = window.setTimeout(() => {
        timer = 0;
        scan();
      }, 120);
    };
    scan();
    const root = document.documentElement ?? document;
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    const interval = window.setInterval(scan, 1500);
    window.setTimeout(() => window.clearInterval(interval), 6e4);
    return {
      scan,
      stop: () => {
        stopped = true;
        observer.disconnect();
        window.clearInterval(interval);
        if (timer) window.clearTimeout(timer);
      }
    };
  }

  // src/core/pruner.ts
  var CARD_KEYS = ["bvid", "aid", "goto", "cid"];
  function looksLikeCard(el) {
    if (!el || typeof el !== "object" || Array.isArray(el)) return false;
    const obj = el;
    if (typeof obj.title !== "string" || obj.title.trim() === "") return false;
    return CARD_KEYS.some((k) => k in obj);
  }
  function pruneFeed(root, hooks) {
    let removed = 0;
    const maxDepth = 14;
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > maxDepth) return;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i -= 1) {
          const el = node[i];
          if (looksLikeCard(el)) {
            if (hooks.shouldDrop?.(el)) {
              node.splice(i, 1);
              removed += 1;
              continue;
            }
            const result = hooks.match(el.title);
            if (result.hit) {
              hooks.onHit(el.title, result);
              node.splice(i, 1);
              removed += 1;
              continue;
            }
          }
          walk(el, depth + 1);
        }
        return;
      }
      for (const key of Object.keys(node)) {
        walk(node[key], depth + 1);
      }
    };
    walk(root, 0);
    return removed;
  }

  // src/core/urlFilter.ts
  var FEED_PATHS = [/\/feed\/rcmd\b/, /\/top\/feed\b/, /\/index\/top\/feed\b/, /\/wbi\/index\/top\/feed\b/];
  var BILI_HOSTS = /* @__PURE__ */ new Set(["bilibili.com", "www.bilibili.com"]);
  function isFeedUrl(input, base = "https://www.bilibili.com/") {
    if (!input) return false;
    try {
      const url = new URL(input, base);
      const host = url.hostname.toLowerCase();
      if (!BILI_HOSTS.has(host) && !host.endsWith(".bilibili.com")) return false;
      return FEED_PATHS.some((re) => re.test(url.pathname));
    } catch {
      return false;
    }
  }

  // src/core/hook.ts
  function ownerMid(item) {
    const node = item;
    const mid = Number(node?.owner?.mid ?? node?.mid);
    return Number.isFinite(mid) ? mid : 0;
  }
  function installFeedHook(opts) {
    const { win: win2, ready, getState, onHit } = opts;
    const check = opts.checkUrl ?? ((u) => isFeedUrl(u, win2.location?.href));
    patchFetch(win2, check, ready, getState, onHit);
    patchXhr(win2, check, getState, onHit);
  }
  function patchFetch(win2, isFeed, ready, getState, onHit) {
    const nativeFetch = win2.fetch;
    if (typeof nativeFetch !== "function") return;
    const patched = function(...args) {
      const input = args[0];
      const pending = nativeFetch.apply(this, args);
      let url = "";
      try {
        if (typeof input === "string") url = input;
        else if (typeof Request !== "undefined" && input instanceof Request) url = input.url;
        else url = String(input);
      } catch {
        url = "";
      }
      if (!url || !isFeed(url)) return pending;
      return pending.then(async (res) => {
        if (!res || !res.ok) return res;
        try {
          await ready;
        } catch {
        }
        const state2 = getState();
        if (!state2.settings.enabled || state2.hot.length === 0) return res;
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType && !contentType.includes("json")) return res;
        const json = await res.clone().json();
        const removed = pruneFeed(json, {
          match: (title) => matchTitle(title, state2.hot, state2.settings),
          onHit,
          shouldDrop: (item) => {
            const ups = state2.blockedUps;
            return !!ups && ups.size > 0 && ups.has(ownerMid(item));
          }
        });
        if (removed === 0) return res;
        const headers = new Headers(res.headers);
        headers.delete("content-encoding");
        headers.delete("content-length");
        return new Response(JSON.stringify(json), {
          status: res.status,
          statusText: res.statusText,
          headers
        });
      }).catch(() => pending);
    };
    win2.fetch = patched;
  }
  function patchXhr(win2, isFeed, getState, onHit) {
    const XHR = win2.XMLHttpRequest;
    if (!XHR || !XHR.prototype) return;
    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;
    XHR.prototype.open = function(...args) {
      this.__zbbUrl = String(args[1]);
      return nativeOpen.apply(this, args);
    };
    XHR.prototype.send = function(...args) {
      const self = this;
      const url = self.__zbbUrl ?? "";
      if (url && isFeed(url)) {
        self.addEventListener("load", () => {
          try {
            if (self.status < 200 || self.status >= 300) return;
            const state2 = getState();
            if (!state2.settings.enabled || state2.hot.length === 0) return;
            const raw = self.responseType === "json" ? self.response : self.responseText;
            if (!raw) return;
            const json = typeof raw === "string" ? JSON.parse(raw) : raw;
            const removed = pruneFeed(json, {
              match: (title) => matchTitle(title, state2.hot, state2.settings),
              onHit,
              shouldDrop: (item) => {
                const ups = state2.blockedUps;
                return !!ups && ups.size > 0 && ups.has(ownerMid(item));
              }
            });
            if (removed === 0) return;
            const text = JSON.stringify(json);
            if (self.responseType === "" || self.responseType === "text") {
              Object.defineProperty(self, "responseText", { value: text, configurable: true });
            } else if (self.responseType === "json") {
              Object.defineProperty(self, "response", { value: json, configurable: true });
            }
          } catch {
          }
        });
      }
      return nativeSend.apply(this, args);
    };
  }

  // src/core/hotparse.ts
  function pickTitles(json) {
    const root = json;
    const data = root?.data ?? root?.items ?? root?.result;
    if (!Array.isArray(data)) return [];
    const out = [];
    for (const item of data) {
      const node = item;
      const title = node?.target?.title ?? node?.target?.title?.area?.title ?? node?.title ?? node?.name ?? "";
      if (typeof title === "string" && title.trim()) out.push(title.trim());
    }
    return out;
  }
  function parseRss(text) {
    try {
      const json = JSON.parse(text);
      const items = json.items ?? json.data;
      if (Array.isArray(items)) {
        return items.map((item) => item?.title).filter((t) => typeof t === "string" && t.trim() !== "").map((t) => t.trim());
      }
    } catch {
    }
    const out = [];
    const re = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const title = match[1].trim();
      if (title) out.push(title);
    }
    return out.length > 1 ? out.slice(1) : out;
  }

  // src/core/ups.ts
  function parseUpsFile(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const entries = json?.entries;
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const raw of entries) {
      const mid = Number(raw?.mid);
      if (!Number.isFinite(mid) || mid <= 0) continue;
      const name = String(raw?.name ?? "").slice(0, 60);
      out.push({ mid, name, source: "auto" });
    }
    return out;
  }
  function mergeUps(current, remote) {
    const manual = current.filter((e) => e.source === "manual");
    const byMid = /* @__PURE__ */ new Map();
    for (const entry of manual) byMid.set(entry.mid, entry);
    for (const entry of remote) {
      if (!byMid.has(entry.mid)) byMid.set(entry.mid, entry);
    }
    return [...byMid.values()];
  }

  // src/core/pool.ts
  var DAY = 24 * 60 * 60 * 1e3;
  function mergePool(current, incoming, now) {
    const byKey = /* @__PURE__ */ new Map();
    for (const entry of current) {
      const key = normalize(entry.title);
      if (key) byKey.set(key, entry);
    }
    for (const item of incoming) {
      const key = normalize(item.title);
      if (!key) continue;
      const existing = byKey.get(key);
      if (existing) {
        existing.lastSeen = Math.max(existing.lastSeen, now);
      } else {
        byKey.set(key, { title: item.title, firstSeen: now, lastSeen: now, origin: item.origin });
      }
    }
    return [...byKey.values()];
  }
  function prunePool(entries, now, opts = {}) {
    const maxAgeDays = opts.maxAgeDays ?? 30;
    const maxEntries = opts.maxEntries ?? 800;
    const cutoff = now - maxAgeDays * DAY;
    const alive = entries.filter((e) => e.lastSeen >= cutoff);
    if (alive.length <= maxEntries) return alive;
    return [...alive].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, maxEntries);
  }
  function replaceOrigin(entries, origin, incoming, now) {
    const kept = entries.filter((e) => e.origin !== origin);
    const added = incoming.map((title) => ({
      title,
      firstSeen: now,
      lastSeen: now,
      origin
    }));
    return mergePool(kept, added, now);
  }
  function splitByFreshness(entries, now, staleDays = 7) {
    const cutoff = now - staleDays * DAY;
    const fresh = [];
    const stale = [];
    for (const entry of entries) {
      if (entry.lastSeen >= cutoff) fresh.push(entry);
      else stale.push(entry);
    }
    return { fresh, stale };
  }
  function parseSeed(text, maxLines = 5e3, maxLength = 120) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const line of text.split(/\r?\n/)) {
      const title = line.trim();
      if (!title || title.startsWith("#")) continue;
      if (title.length > maxLength) continue;
      if (/[<>]/.test(title) || /^https?:\/\//i.test(title)) continue;
      const key = normalize(title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(title);
      if (out.length >= maxLines) break;
    }
    return out;
  }

  // src/core/types.ts
  var DEFAULT_SETTINGS = {
    enabled: true,
    // 默认落在「保守」：体检数据显示 1.00 分那批几乎都是原样照搬，
    // 而 0.85 以下开始出现改写，默认值宁可少拦也别误伤。
    threshold: 0.86,
    minLen: 8,
    whitelist: [],
    refreshMinutes: 45,
    // raw.githubusercontent 在国内多数网络访问不了，所以走两个镜像：
    //   gh-proxy 无缓存、能立刻拿到最新；jsDelivr 边缘缓存 12h，胜在稳定
    remoteSeedUrls: [
      "https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/data/seed.txt",
      "https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/seed.txt"
    ],
    poolDays: 30,
    poolMax: 800,
    rsshub: "",
    upBlockEnabled: true,
    remoteUpsUrls: [
      "https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/data/ups.json",
      "https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/ups.json"
    ],
    // 静默贡献：只在用户手动拉黑时上报 mid，不带任何标识
    contributeUps: true,
    upsEndpoints: [
      "https://zbb-ups-nwwblkigcf.cn-hangzhou.fcapp.run",
      // 国内，主用
      "https://zbb-ups.zbb-eaa69b.workers.dev"
      // 境外兜底
    ]
  };
  var MODES = [
    { id: "conservative", name: "保守", threshold: 0.86, hint: "只拦照搬" },
    { id: "standard", name: "标准", threshold: 0.78, hint: "多数搬运" },
    { id: "aggressive", name: "激进", threshold: 0.66, hint: "改写也拦" }
  ];
  function modeOf(threshold) {
    return MODES.find((m) => Math.abs(m.threshold - threshold) < 5e-3);
  }
  var KEYS = {
    settings: "zbb:settings",
    hot: "zbb:hot",
    records: "zbb:records",
    stats: "zbb:stats",
    ups: "zbb:ups",
    outbox: "zbb:outbox"
  };
  var RECORD_LIMIT = 50;

  // src/core/widget.ts
  var STYLE = `
:host { all: initial; }
.pill {
  position: fixed; right: 18px; top: 42%; z-index: 2147483640;
  display: flex; align-items: center; gap: 7px;
  padding: 7px 12px; border-radius: 999px;
  background: rgba(20, 22, 27, 0.72);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #d9dce2; font: 12px/1 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  cursor: grab; opacity: 0.62; transition: opacity .15s, border-color .15s;
  user-select: none; touch-action: none; white-space: nowrap;
}
.pill:hover { opacity: 1; border-color: rgba(255,255,255,.22); }
.pill.open { opacity: 1; }
.pill.dragging { transition: none; cursor: grabbing; opacity: 1; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #fb7299; flex: none; }
.pill b { font-weight: 600; color: #fff; font-variant-numeric: tabular-nums; }
.sep { color: #6b7280; }

.panel {
  position: fixed; left: 0; top: 0; z-index: 2147483641;
  width: 300px; max-height: 46vh; overflow: auto;
  padding: 10px 12px; border-radius: 12px;
  background: rgba(20, 22, 27, 0.96);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
  color: #e8eaed; font: 12px/1.55 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.panel[hidden] { display: none; }
.head { display: flex; justify-content: space-between; align-items: center; color: #8b929e; margin-bottom: 8px; }
.head-right { display: flex; align-items: center; gap: 10px; }
.open-panel {
  border: 0; background: none; padding: 0; cursor: pointer;
  color: #fb7299; font: inherit; font-size: 11px;
}
.open-panel:hover { text-decoration: underline; }
.item { padding: 6px 0; border-top: 1px solid rgba(255,255,255,.07); }
.item:first-of-type { border-top: 0; padding-top: 0; }
.t { color: #e8eaed; word-break: break-all; }
.m { display: flex; align-items: center; gap: 6px; margin-top: 2px; color: #8b929e; font-size: 11px; }
.z { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s { color: #fb7299; font-variant-numeric: tabular-nums; }
.a { border: 0; background: none; color: #8b929e; font: inherit; font-size: 11px; cursor: pointer; padding: 0 2px; }
.a:hover { color: #4ade80; }
.empty { color: #8b929e; text-align: center; padding: 12px 0; }
.settings { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.07); }
.srow { display: flex; align-items: center; justify-content: space-between; color: #8b929e; }
.cb { accent-color: #fb7299; cursor: pointer; }
.modes { display: flex; gap: 6px; margin-top: 8px; }
.chip {
  flex: 1; padding: 5px 0; border-radius: 7px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.1); background: #16181d;
  color: #b9bfc9; font: inherit; font-size: 11px;
}
.chip:hover { border-color: rgba(255,255,255,.24); }
.chip.active { border-color: #fb7299; color: #fb7299; background: rgba(251,114,153,.1); }

.adv { margin-top: 8px; }
.adv > summary {
  cursor: pointer; color: #8b929e; font-size: 11px; list-style: none;
  display: flex; justify-content: space-between; align-items: center;
}
.adv > summary::-webkit-details-marker { display: none; }
.adv > summary::after { content: '展开'; }
.adv[open] > summary::after { content: '收起'; }
.adv-body { margin-top: 6px; display: flex; flex-direction: column; gap: 8px; }
.adv-row { display: flex; justify-content: space-between; color: #8b929e; font-size: 11px; }
.adv-value { color: #e8eaed; font-variant-numeric: tabular-nums; }
.adv-range { width: 100%; accent-color: #fb7299; }
.adv-info { color: #8b929e; font-size: 11px; }
.adv-input {
  width: 100%; padding: 5px 7px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,.12); background: #14161a;
  color: #e8eaed; font: inherit; font-size: 11px;
}
.adv-input:focus { outline: none; border-color: #fb7299; }
.adv-actions { display: flex; gap: 6px; }
.adv-btn {
  flex: 1; padding: 5px 0; border-radius: 6px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.12); background: #16181d;
  color: #b9bfc9; font: inherit; font-size: 11px;
}
.adv-btn:hover { border-color: rgba(255,255,255,.26); }
.adv-btn:disabled { opacity: .55; cursor: default; }
`;
  function createWidget(opts) {
    const host = document.createElement("div");
    host.id = "zbb-widget";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style>
    <button class="pill" part="pill"><span class="dot"></span><span class="text"></span></button>
    <div class="panel" hidden></div>`;
    const pill = root.querySelector(".pill");
    const text = root.querySelector(".text");
    const panel = root.querySelector(".panel");
    const POS_KEY = "zbb:widget-pos";
    const clamp2 = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
    const applyPos = (x, y) => {
      pill.style.left = `${x}px`;
      pill.style.top = `${y}px`;
      pill.style.right = "auto";
      pill.style.transform = "none";
    };
    const placePanel = () => {
      const r = pill.getBoundingClientRect();
      const pw = panel.offsetWidth || 300;
      const ph = panel.offsetHeight || 200;
      const left = clamp2(r.right - pw, 8, window.innerWidth - pw - 8);
      let top = r.top - ph - 8;
      if (top < 8) top = clamp2(r.bottom + 8, 8, window.innerHeight - ph - 8);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    const savePos = () => {
      try {
        localStorage.setItem(
          POS_KEY,
          JSON.stringify({ x: parseFloat(pill.style.left), y: parseFloat(pill.style.top) })
        );
      } catch {
      }
    };
    const close = () => {
      panel.hidden = true;
      pill.classList.remove("open");
    };
    const renderPanel = () => {
      const records = opts.getRecords().slice(0, 5);
      panel.textContent = "";
      const head = document.createElement("div");
      head.className = "head";
      const left = document.createElement("span");
      left.textContent = "最近拦截";
      const rightWrap = document.createElement("span");
      rightWrap.className = "head-right";
      const right = document.createElement("span");
      right.textContent = `题库 ${opts.getPool()} 条`;
      rightWrap.append(right);
      if (opts.onOpenSettings) {
        const open = document.createElement("button");
        open.className = "open-panel";
        open.textContent = "设置 ↗";
        open.title = "在侧边栏打开设置页";
        open.addEventListener("click", (event) => {
          event.stopPropagation();
          opts.onOpenSettings?.();
          close();
        });
        rightWrap.append(open);
      }
      head.append(left, rightWrap);
      panel.append(head);
      if (records.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "还没有拦截记录";
        panel.append(empty);
      }
      for (const record of records) {
        const item = document.createElement("div");
        item.className = "item";
        const title = document.createElement("div");
        title.className = "t";
        title.textContent = record.biliTitle;
        const meta = document.createElement("div");
        meta.className = "m";
        const zhihu = document.createElement("span");
        zhihu.className = "z";
        zhihu.textContent = `← ${record.zhihuTitle}`;
        zhihu.title = record.zhihuTitle;
        const score = document.createElement("span");
        score.className = "s";
        score.textContent = record.score.toFixed(2);
        const allow = document.createElement("button");
        allow.className = "a";
        allow.textContent = "放行";
        allow.addEventListener("click", () => {
          opts.onAllow(record);
          renderPanel();
        });
        meta.append(zhihu, score, allow);
        item.append(title, meta);
        panel.append(item);
      }
      appendSettings();
    };
    const appendSettings = () => {
      const cfg = opts.settings;
      if (!cfg) return;
      const box = document.createElement("div");
      box.className = "settings";
      const row = document.createElement("div");
      row.className = "srow";
      const label = document.createElement("span");
      label.textContent = "总开关";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "cb";
      toggle.checked = cfg.getEnabled();
      toggle.addEventListener("change", () => {
        cfg.onToggle(toggle.checked);
        refresh();
      });
      row.append(label, toggle);
      const modes = document.createElement("div");
      modes.className = "modes";
      const current = modeOf(cfg.getThreshold());
      for (const mode of MODES) {
        const chip = document.createElement("button");
        chip.className = `chip${current?.id === mode.id ? " active" : ""}`;
        chip.textContent = mode.name;
        chip.title = `阈值 ${mode.threshold}`;
        chip.addEventListener("click", () => {
          cfg.onThreshold(mode.threshold);
          renderPanel();
        });
        modes.append(chip);
      }
      box.append(row, modes);
      const hasAdvanced = cfg.getPoolInfo || cfg.onRefresh || cfg.onSyncSeed || cfg.getSeedUrl;
      if (hasAdvanced) box.append(buildAdvanced(cfg));
      panel.append(box);
    };
    const buildAdvanced = (cfg) => {
      const details = document.createElement("details");
      details.className = "adv";
      const summary = document.createElement("summary");
      summary.textContent = "高级设置";
      details.append(summary);
      const body = document.createElement("div");
      body.className = "adv-body";
      const head = document.createElement("div");
      head.className = "adv-row";
      const label = document.createElement("span");
      label.textContent = "精确阈值";
      const value = document.createElement("span");
      value.className = "adv-value";
      value.textContent = cfg.getThreshold().toFixed(2);
      head.append(label, value);
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0.6";
      slider.max = "0.92";
      slider.step = "0.01";
      slider.value = String(cfg.getThreshold());
      slider.className = "adv-range";
      slider.addEventListener("input", () => {
        value.textContent = Number(slider.value).toFixed(2);
      });
      slider.addEventListener("change", () => {
        cfg.onThreshold(Number(slider.value));
        renderPanel();
      });
      body.append(head, slider);
      if (cfg.getPoolInfo) {
        const info = document.createElement("div");
        info.className = "adv-info";
        info.textContent = cfg.getPoolInfo();
        body.append(info);
      }
      if (cfg.getSeedUrl || cfg.onSyncSeed) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "adv-input";
        input.placeholder = "远端题库源（留空则不启用）";
        input.spellcheck = false;
        input.value = cfg.getSeedUrl?.() ?? "";
        input.addEventListener("change", () => cfg.onSeedUrl?.(input.value.trim()));
        body.append(input);
      }
      if (cfg.onRefresh || cfg.onSyncSeed) {
        const actions = document.createElement("div");
        actions.className = "adv-actions";
        for (const [text2, fn] of [
          ["刷新热榜", cfg.onRefresh],
          ["同步题库", cfg.onSyncSeed]
        ]) {
          if (!fn) continue;
          const btn = document.createElement("button");
          btn.className = "adv-btn";
          btn.textContent = text2;
          btn.addEventListener("click", () => {
            btn.disabled = true;
            btn.textContent = "请求中…";
            fn();
            window.setTimeout(() => {
              btn.disabled = false;
              btn.textContent = text2;
              renderPanel();
            }, 1500);
          });
          actions.append(btn);
        }
        body.append(actions);
      }
      details.append(body);
      return details;
    };
    const refresh = () => {
      text.textContent = "已拦截 ";
      const session = document.createElement("b");
      session.textContent = String(opts.getSession());
      text.append(session, " · 累计 ");
      const total = document.createElement("b");
      total.textContent = String(opts.getTotal());
      text.append(total);
      if (!panel.hidden) renderPanel();
    };
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    pill.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = pill.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      originX = rect.left;
      originY = rect.top;
      pill.classList.add("dragging");
      try {
        pill.setPointerCapture(event.pointerId);
      } catch {
      }
    });
    pill.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      moved = true;
      const w = pill.offsetWidth;
      const h = pill.offsetHeight;
      applyPos(
        clamp2(originX + dx, 4, window.innerWidth - w - 4),
        clamp2(originY + dy, 4, window.innerHeight - h - 4)
      );
      if (!panel.hidden) placePanel();
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      pill.classList.remove("dragging");
      if (moved) savePos();
    };
    pill.addEventListener("pointerup", endDrag);
    pill.addEventListener("pointercancel", endDrag);
    window.addEventListener("resize", () => {
      if (!pill.style.left) return;
      const w = pill.offsetWidth;
      const h = pill.offsetHeight;
      applyPos(
        clamp2(parseFloat(pill.style.left), 4, window.innerWidth - w - 4),
        clamp2(parseFloat(pill.style.top), 4, window.innerHeight - h - 4)
      );
      if (!panel.hidden) placePanel();
    });
    pill.addEventListener("click", (event) => {
      event.stopPropagation();
      if (moved) {
        moved = false;
        return;
      }
      if (panel.hidden) {
        renderPanel();
        panel.hidden = false;
        pill.classList.add("open");
        placePanel();
      } else {
        close();
      }
    });
    const onDocClick = (event) => {
      if (panel.hidden) return;
      const path = event.composedPath();
      if (!path.includes(host)) close();
    };
    document.addEventListener("click", onDocClick, true);
    document.documentElement.append(host);
    try {
      const saved = localStorage.getItem(POS_KEY);
      if (saved) {
        const pos = JSON.parse(saved);
        if (Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
          applyPos(
            clamp2(pos.x, 4, Math.max(4, window.innerWidth - 160)),
            clamp2(pos.y, 4, Math.max(4, window.innerHeight - 40))
          );
        }
      }
    } catch {
    }
    refresh();
    return {
      refresh,
      open: () => {
        renderPanel();
        panel.hidden = false;
        pill.classList.add("open");
        placePanel();
      },
      destroy: () => {
        document.removeEventListener("click", onDocClick, true);
        host.remove();
      }
    };
  }
  function mountWidget(opts) {
    try {
      return createWidget(opts);
    } catch {
      return { refresh: () => void 0, open: () => void 0, destroy: () => void 0 };
    }
  }

  // src/userscript/main.ts
  var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  var HOT_MAX_AGE = 30 * 60 * 1e3;
  var SEED_MAX_AGE = 20 * 60 * 60 * 1e3;
  var win = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
  function readJson(key, fallback) {
    try {
      const raw = GM_getValue(key, "");
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try {
      GM_setValue(key, JSON.stringify(value));
    } catch {
    }
  }
  var state = {
    settings: { ...DEFAULT_SETTINGS, ...readJson(KEYS.settings, {}) },
    fresh: [],
    stale: [],
    pool: readJson(KEYS.hot, null),
    records: readJson(KEYS.records, []),
    stats: readJson(KEYS.stats, { total: 0 }),
    ups: readJson(KEYS.ups, { entries: [], updatedAt: 0 })
  };
  function blockedMids() {
    if (!state.settings.upBlockEnabled) return /* @__PURE__ */ new Set();
    return new Set(state.ups.entries.map((entry) => entry.mid));
  }
  function submitUp(mid, name) {
    if (!state.settings.contributeUps) return;
    const endpoints = (state.settings.upsEndpoints ?? []).map((u) => u.trim().replace(/\/$/, "")).filter(Boolean);
    if (endpoints.length === 0) return;
    const attempt = (index) => {
      if (index >= endpoints.length) return;
      GM_xmlhttpRequest({
        method: "POST",
        url: `${endpoints[index]}/submit`,
        timeout: 8e3,
        headers: { "content-type": "application/json" },
        data: JSON.stringify({ mid, name }),
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) attempt(index + 1);
        },
        onerror: () => attempt(index + 1),
        ontimeout: () => attempt(index + 1)
      });
    };
    attempt(0);
  }
  function addUp(mid, name) {
    if (state.ups.entries.some((entry) => entry.mid === mid)) return;
    state.ups = {
      entries: [...state.ups.entries, { mid, name, source: "manual", addedAt: Date.now() }],
      updatedAt: Date.now()
    };
    writeJson(KEYS.ups, state.ups);
    submitUp(mid, name);
    widget?.refresh();
  }
  var sessionHits = 0;
  var widget = null;
  function poolEntries() {
    const raw = state.pool;
    return Array.isArray(raw?.entries) ? raw.entries : [];
  }
  function rebuild() {
    const split = splitByFreshness(poolEntries(), Date.now(), 7);
    state.fresh = prepareHot(split.fresh.map((e) => e.title));
    state.stale = prepareHot(split.stale.map((e) => e.title)).map((e) => ({ ...e, stale: true }));
  }
  function allEntries() {
    return [...state.fresh, ...state.stale];
  }
  function saveSettings() {
    writeJson(KEYS.settings, state.settings);
  }
  function savePool() {
    writeJson(KEYS.hot, state.pool);
  }
  function fmtTime(ts) {
    if (!ts) return "从未成功";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === (/* @__PURE__ */ new Date()).toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
  }
  function addRecord(record) {
    const dup = state.records.some(
      (r) => r.biliTitle === record.biliTitle && r.zhihuTitle === record.zhihuTitle
    );
    if (!dup) {
      state.records.unshift(record);
      state.records = state.records.slice(0, RECORD_LIMIT);
      sessionHits += 1;
      state.stats = { total: state.stats.total + 1 };
      writeJson(KEYS.records, state.records);
      writeJson(KEYS.stats, state.stats);
    }
    widget?.refresh();
  }
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: 12e3,
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "zh-CN,zh;q=0.9",
          "user-agent": UA
        },
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res.responseText);
          else reject(new Error(`HTTP ${res.status}`));
        },
        onerror: () => reject(new Error("网络错误")),
        ontimeout: () => reject(new Error("超时"))
      });
    });
  }
  function sources() {
    const list = [
      { name: "知乎热榜", url: "https://api.zhihu.com/topstory/hot-list?limit=50&reverse_order=0" },
      {
        name: "知乎热榜(登录态)",
        url: "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50"
      }
    ];
    const rsshub = state.settings.rsshub.trim().replace(/\/+$/, "");
    if (rsshub) list.push({ name: "RSSHub", url: `${rsshub}/zhihu/hotlist`, rss: true });
    return list;
  }
  async function refreshHot(force = false) {
    if (!force && state.pool?.updatedAt && Date.now() - state.pool.updatedAt < HOT_MAX_AGE) return;
    const errors = [];
    for (const source of sources()) {
      try {
        const text = await gmFetch(source.url);
        const titles = source.rss ? parseRss(text) : pickTitles(JSON.parse(text));
        if (titles.length >= 5) {
          const now = Date.now();
          const merged = mergePool(
            poolEntries(),
            titles.map((title) => ({ title, origin: "hot" })),
            now
          );
          state.pool = {
            ...state.pool ?? { entries: [], updatedAt: 0, source: "none", error: "" },
            entries: prunePool(merged, now, {
              maxAgeDays: state.settings.poolDays,
              maxEntries: state.settings.poolMax
            }),
            updatedAt: now,
            source: source.name,
            error: ""
          };
          savePool();
          rebuild();
          widget?.refresh();
          return;
        }
        errors.push(`${source.name}: 只拿到 ${titles.length} 条`);
      } catch (err) {
        errors.push(`${source.name}: ${err.message}`);
      }
    }
    state.pool = {
      ...state.pool ?? { entries: [], updatedAt: 0, source: "none", error: "" },
      error: errors.join(" | ")
    };
    savePool();
    widget?.refresh();
  }
  async function syncSeed(force = false) {
    const urls = (state.settings.remoteSeedUrls ?? []).filter(Boolean);
    if (!urls.length) return;
    if (!force && state.pool?.remote?.at && Date.now() - state.pool.remote.at < SEED_MAX_AGE) return;
    const errors = [];
    for (const url of urls) {
      try {
        const text = await gmFetch(url);
        const titles = parseSeed(text.slice(0, 512 * 1024));
        if (titles.length < 10) throw new Error(`只解析到 ${titles.length} 条`);
        const now = Date.now();
        const entries = replaceOrigin(poolEntries(), "remote", titles, now);
        state.pool = {
          ...state.pool ?? { entries: [], updatedAt: 0, source: "none", error: "" },
          entries: prunePool(entries, now, {
            maxAgeDays: state.settings.poolDays,
            maxEntries: state.settings.poolMax
          }),
          remote: { at: now, count: titles.length, error: "" }
        };
        savePool();
        rebuild();
        widget?.refresh();
        return;
      } catch (err) {
        errors.push(`${url}: ${err.message}`);
      }
    }
    state.pool = {
      ...state.pool ?? { entries: [], updatedAt: 0, source: "none", error: "" },
      remote: { at: 0, count: 0, error: errors.join(" | ") }
    };
    savePool();
    widget?.refresh();
  }
  var UPS_MAX_AGE = 20 * 60 * 60 * 1e3;
  async function syncUps(force = false) {
    const urls = (state.settings.remoteUpsUrls ?? []).filter(Boolean);
    if (!urls.length) return;
    if (!force && state.ups.updatedAt && Date.now() - state.ups.updatedAt < UPS_MAX_AGE) return;
    for (const url of urls) {
      try {
        const text = await gmFetch(url);
        const remote = parseUpsFile(text.slice(0, 512 * 1024));
        if (!remote.length) throw new Error("没有解析到条目");
        state.ups = { entries: mergeUps(state.ups.entries, remote), updatedAt: Date.now() };
        writeJson(KEYS.ups, state.ups);
        rebuild();
        widget?.refresh();
        return;
      } catch {
      }
    }
  }
  installFeedHook({
    win,
    ready: Promise.resolve(),
    getState: () => ({ settings: state.settings, hot: allEntries(), blockedUps: blockedMids() }),
    onHit: (biliTitle, result) => {
      addRecord({
        biliTitle,
        zhihuTitle: result.zhihuTitle,
        score: result.score,
        reason: result.reason === "none" ? "dice" : result.reason,
        layer: "net",
        at: Date.now()
      });
    }
  });
  startScanner({
    settings: () => state.settings,
    hot: () => allEntries(),
    onCard: (card) => {
      const owner = cardOwner(card);
      if (!owner) return false;
      const blocked = blockedMids();
      if (blocked.size > 0 && blocked.has(owner.mid)) {
        hideCard(card);
        return true;
      }
      attachUpButton(card, owner, (o) => {
        addUp(o.mid, o.name);
        hideCard(card);
      });
      return false;
    },
    onHit: (biliTitle, result) => {
      addRecord({
        biliTitle,
        zhihuTitle: result.zhihuTitle,
        score: result.score,
        reason: result.reason === "none" ? "dice" : result.reason,
        layer: "dom",
        at: Date.now()
      });
    }
  });
  function mountUi() {
    if (widget || !document.documentElement) return;
    widget = mountWidget({
      getSession: () => sessionHits,
      getTotal: () => state.stats.total,
      getPool: () => poolEntries().length,
      getRecords: () => state.records,
      onAllow: (record) => {
        if (!state.settings.whitelist.includes(record.biliTitle)) {
          state.settings = {
            ...state.settings,
            whitelist: [...state.settings.whitelist, record.biliTitle]
          };
          saveSettings();
        }
        state.records = state.records.filter((r) => r.biliTitle !== record.biliTitle);
        writeJson(KEYS.records, state.records);
        widget?.refresh();
      },
      settings: {
        getEnabled: () => state.settings.enabled,
        onToggle: (enabled) => {
          state.settings = { ...state.settings, enabled };
          saveSettings();
        },
        getThreshold: () => state.settings.threshold,
        onThreshold: (threshold) => {
          state.settings = { ...state.settings, threshold };
          saveSettings();
        },
        // 油猴版没有独立设置页，高级项都塞进浮窗
        getPoolInfo: () => {
          const pool = state.pool;
          if (!pool?.updatedAt) return "题库尚未同步";
          const remote = pool.remote?.count ? ` · 远端 ${pool.remote.count}` : "";
          return `题库 ${poolEntries().length} 条 · ${pool.source}${remote} · ${fmtTime(pool.updatedAt)}`;
        },
        getSeedUrl: () => state.settings.remoteSeedUrls[0] ?? "",
        onSeedUrl: (url) => {
          state.settings = { ...state.settings, remoteSeedUrls: url ? [url] : [] };
          saveSettings();
          void syncSeed(true);
        },
        onRefresh: () => void refreshHot(true),
        onSyncSeed: () => void syncSeed(true)
      }
    });
  }
  rebuild();
  if (document.documentElement) mountUi();
  else document.addEventListener("DOMContentLoaded", mountUi, { once: true });
  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("打开知乎屏蔽面板", () => {
      mountUi();
      widget?.open();
    });
  }
  void refreshHot().then(() => syncSeed()).then(() => syncUps());
})();
