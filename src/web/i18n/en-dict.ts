import dict from './en-dict.json';
import { translatePatternZhToEn } from './en-patterns';

export const EN_EXACT: Readonly<Record<string, string>> = dict;

// Build a whitespace-collapsed index so Prettier-wrapped JSX/Vue text nodes match reliably.
const normalizedIndex = new Map<string, string>();
for (const [k, v] of Object.entries(EN_EXACT)) {
  const collapsed = k.replace(/\s+/g, ' ').trim();
  if (!normalizedIndex.has(collapsed)) normalizedIndex.set(collapsed, v);
  const compactCjk = collapsed.replace(/([\u4e00-\u9fff，。、；：！？（）「」])\s+([\u4e00-\u9fff，。、；：！？（）「」])/g, '$1$2');
  if (compactCjk !== collapsed && !normalizedIndex.has(compactCjk)) normalizedIndex.set(compactCjk, v);
}

function lookupExact(s: string): string | undefined {
  const direct = EN_EXACT[s];
  if (direct !== undefined) return direct;
  const collapsed = s.replace(/\s+/g, ' ').trim();
  const byCollapsed = normalizedIndex.get(collapsed);
  if (byCollapsed !== undefined) return byCollapsed;
  const compact = collapsed.replace(/([\u4e00-\u9fff，。、；：！？（）「」])\s+([\u4e00-\u9fff，。、；：！？（）「」])/g, '$1$2');
  return normalizedIndex.get(compact);
}

export function translateZhToEn(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const exact = lookupExact(trimmed);
  if (exact !== undefined) return raw.replace(trimmed, exact);
  const collapsed = trimmed.replace(/\s+/g, ' ');
  const pattern = translatePatternZhToEn(collapsed, lookupExact);
  if (pattern !== null) return raw.replace(trimmed, pattern);
  return null;
}
