import type { MatchResult } from './types';

export interface PruneHooks {
  match: (title: string) => MatchResult;
  onHit: (title: string, result: MatchResult) => void;
  /** UP 库命中：返回 true 则整条移除，不再走标题匹配 */
  shouldDrop?: (item: unknown) => boolean;
}

/** B 站 feed 卡片一定带的字段，用来避免误剪评论区之类的无关数组 */
const CARD_KEYS = ['bvid', 'aid', 'goto', 'cid'];

function looksLikeCard(el: unknown): el is { title: string } {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return false;
  const obj = el as Record<string, unknown>;
  if (typeof obj.title !== 'string' || obj.title.trim() === '') return false;
  return CARD_KEYS.some((k) => k in obj);
}

/**
 * 通用 JSON 剪枝：递归找"元素长得像视频卡片"的数组，命中则原地 splice 掉。
 *
 * 不做路径硬编码（data.item[].title），是因为 B 站换字段/换层级很常见；
 * 按"元素形状"识别，改层级不用改代码。解析失败由调用方原样放行。
 */
export function pruneFeed(root: unknown, hooks: PruneHooks): number {
  let removed = 0;
  const maxDepth = 14;

  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > maxDepth) return;

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

    for (const key of Object.keys(node as Record<string, unknown>)) {
      walk((node as Record<string, unknown>)[key], depth + 1);
    }
  };

  walk(root, 0);
  return removed;
}
