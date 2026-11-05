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
  /** UP 库拦截开关（按 UP 整号屏蔽） */
  upBlockEnabled: boolean;
  /** 远端 UP 库地址，按序尝试 */
  remoteUpsUrls: string[];
  /** 手动屏蔽 UP 时是否匿名贡献到公共库 */
  contributeUps: boolean;
  /** 投稿接收端，按序尝试；第一个不通就走下一个（国内云函数优先，境外 Worker 兜底） */
  upsEndpoints: string[];
}

export const DEFAULT_SETTINGS: Settings = {
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
    'https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/data/seed.txt',
    'https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/seed.txt',
  ],
  poolDays: 30,
  poolMax: 800,
  rsshub: '',
  upBlockEnabled: true,
  remoteUpsUrls: [
    'https://gh-proxy.com/https://raw.githubusercontent.com/ConspiracyThorist/zhihu-bili-blocker/main/data/ups.json',
    'https://fastly.jsdelivr.net/gh/ConspiracyThorist/zhihu-bili-blocker@main/ups.json',
  ],
  // 静默贡献：只在用户手动拉黑时上报 mid，不带任何标识
  contributeUps: true,
  // 只保留国内端点：Cloudflare 的 workers.dev 在国内被 DNS 污染，留着只会白等超时。
  upsEndpoints: ['https://zbb-ups-nwwblkigcf.cn-hangzhou.fcapp.run'],
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

/** 拦截强度预设：主界面只让人选档位，精确阈值收进高级设置 */
export interface Mode {
  id: 'conservative' | 'standard' | 'aggressive';
  name: string;
  threshold: number;
  hint: string;
}

/**
 * 三档阈值来自 2026-11-02 的 259 条题库实验（tools/tune.ts）：
 * 分数分布上 1.00 有 43 条（纯照搬），0.85~0.96 是 6 条小改写，
 * 0.78~0.83 是 5 条明确改写，0.70 以下开始和无关内容混在一起。
 * 所以保守卡在 0.86（只覆盖原样与小改写），标准落在 0.78（明确改写仍能认），
 * 激进到 0.66（能多抓 15 条，代价是误伤率上升）。
 */
export const MODES: Mode[] = [
  { id: 'conservative', name: '保守', threshold: 0.86, hint: '只拦照搬' },
  { id: 'standard', name: '标准', threshold: 0.78, hint: '多数搬运' },
  { id: 'aggressive', name: '激进', threshold: 0.66, hint: '改写也拦' },
];

/** 命中它的阈值会被认成哪个档位；不在预设里就是自定义 */
export function modeOf(threshold: number): Mode | undefined {
  return MODES.find((m) => Math.abs(m.threshold - threshold) < 0.005);
}

/** 累计拦截计数（记录只留最近 50 条，总数单独记） */
export interface Stats {
  total: number;
}

export const KEYS = {
  settings: 'zbb:settings',
  hot: 'zbb:hot',
  records: 'zbb:records',
  stats: 'zbb:stats',
  ups: 'zbb:ups',
  outbox: 'zbb:outbox',
} as const;

export const RECORD_LIMIT = 50;
export const REFRESH_MINUTES = 45;
export const FETCH_TIMEOUT_MS = 12_000;
