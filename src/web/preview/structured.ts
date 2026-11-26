import YAML from 'yaml';
import { parse as parseToml } from 'smol-toml';

export type StructuredFormat = 'json' | 'jsonl' | 'yaml' | 'toml';

export interface StructuredPreviewData {
  format: StructuredFormat;
  value: unknown;
  formatted: string;
  itemCount: number;
}

const MAX_STRUCTURED_TEXT = 256 * 1024;
const MAX_JSONL_LINES = 500;

export function structuredFormatFor(extension: string, mime: string): StructuredFormat | undefined {
  const ext = extension.toLowerCase();
  if (ext === 'json' || mime === 'application/json' || mime.endsWith('+json')) return 'json';
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl';
  if (ext === 'yaml' || ext === 'yml' || mime === 'text/yaml' || mime === 'application/x-yaml') return 'yaml';
  if (ext === 'toml' || mime === 'application/toml') return 'toml';
  return undefined;
}

function countNodes(value: unknown, limit = 5000): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0 && count < limit) {
    const current = stack.pop();
    count++;
    if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
    } else if (current && typeof current === 'object') {
      const values = Object.values(current as Record<string, unknown>);
      for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
    }
  }
  return count;
}

export function parseStructuredText(
  text: string,
  format: StructuredFormat,
): StructuredPreviewData | undefined {
  if (!text.trim() || text.length > MAX_STRUCTURED_TEXT) return undefined;
  try {
    let value: unknown;
    if (format === 'json') {
      value = JSON.parse(text);
    } else if (format === 'jsonl') {
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (!lines.length) return undefined;
      value = lines.slice(0, MAX_JSONL_LINES).map((line) => JSON.parse(line));
    } else if (format === 'yaml') {
      value = YAML.parse(text);
      if (value === undefined || value === null || typeof value !== 'object') return undefined;
    } else {
      value = parseToml(text);
    }
    const formatted = JSON.stringify(value, null, 2);
    return {
      format,
      value,
      formatted,
      itemCount: countNodes(value),
    };
  } catch {
    return undefined;
  }
}
