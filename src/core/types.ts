/**
 * 与宿主无关的公共类型。
 * 扩展（chrome.*）与油猴（GM_*）两个壳共用这里的定义，保证"一套核心两个壳"。
 */
import type { PoolEntry } from './pool';

/** 拦截发生在哪一层：net = 改接口响应（主路径），dom = 兜底隐藏 */
export type HitLayer = 'net' | 'dom';

/** 命中理由，便于在记录里解释"为什么屏蔽它" */
export type HitReason = 'exact' | 'contain' | 'dice' | 'cover' | 'none';

export interface MatchResult {
  hit: boolean;
  score: number;
  /** 命中的知乎热榜标题原文 */
  zhihuTitle: string;
  reason: HitReason;
}

export interface Settings {
  enabled: boolean;
  /** 相似度阈值，默认 0.72（宁可多屏蔽） */
  threshold: number;
  /** 参与相似度匹配的最短长度，短标题只走强包含，避免误伤 */
  minLen: number;
  /** 白名单关键词，命中则永不屏蔽 */
  whitelist: string[];
  /** 可选：热榜刷新间隔（分钟），默认 45 */
  refreshMinutes: number;
  /** 远端题库源，按序尝试，留空则不启用 */
  remoteSeedUrls: string[];
  /** 题库保留天数 */
  poolDays: number;
  /** 题库条目上限（体检数据显示 3/4 条目无对应视频，所以不追求大池） */
  poolMax: number;
  /** 可选的第三方 RSSHub 实例，留空则不启用 */
  rsshub: string;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  threshold: 0.72,
  minLen: 8,
  whitelist: [],
  refreshMinutes: 45,
  // raw.githubusercontent 在国内多数网络访问不了，所以走两个镜像：
  //   gh-proxy 无缓存、能立刻拿到最新；jsDelivr 边缘缓存 12h，胜在稳定
  remoteSeedUrls: [
    'https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker-seed/main/seed.txt',
    'https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker-seed@main/seed.txt',
  ],
  poolDays: 30,
  poolMax: 800,
  rsshub: '',
};

export interface RemoteMeta {
  /** 上次同步成功时间 */
  at: number;
  /** 条目数 */
  count: number;
  /** 上次失败原因 */
  error: string;
}

export interface HotPool {
  entries: PoolEntry[];
  /** 上次成功更新时间（毫秒），0 表示从未成功 */
  updatedAt: number;
  source: string;
  /** 本轮失败原因，成功后清空 */
  error: string;
  remote?: RemoteMeta;
}

export interface HitRecord {
  biliTitle: string;
  zhihuTitle: string;
  score: number;
  reason: Exclude<HitReason, 'none'>;
  layer: HitLayer;
  at: number;
}

export const KEYS = {
  settings: 'zbb:settings',
  hot: 'zbb:hot',
  records: 'zbb:records',
} as const;

export const RECORD_LIMIT = 50;
export const REFRESH_MINUTES = 45;
export const FETCH_TIMEOUT_MS = 12_000;
