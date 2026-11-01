/**
 * 热榜响应解析：两个壳共用，避免扩展和油猴各写一套 JSON 路径。
 */
export function pickTitles(json: unknown): string[] {
  const root = json as Record<string, unknown> | null;
  const data = root?.data ?? root?.items ?? root?.result;
  if (!Array.isArray(data)) return [];

  const out: string[] = [];
  for (const item of data) {
    const node = item as Record<string, any>;
    const title =
      node?.target?.title ?? node?.target?.title?.area?.title ?? node?.title ?? node?.name ?? '';
    if (typeof title === 'string' && title.trim()) out.push(title.trim());
  }
  return out;
}

/** RSSHub 的 xml/json 两种形态都接一下 */
export function parseRss(text: string): string[] {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const items = (json.items ?? json.data) as Array<{ title?: unknown }> | undefined;
    if (Array.isArray(items)) {
      return items
        .map((item) => item?.title)
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        .map((t) => t.trim());
    }
  } catch {
    /* 不是 JSON，按 XML 继续 */
  }

  const out: string[] = [];
  const re = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const title = match[1].trim();
    if (title) out.push(title);
  }
  // 第一条一般是频道名
  return out.length > 1 ? out.slice(1) : out;
}
