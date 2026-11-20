type WritingOption = { label?: string; text: string };
type WritingMetadata = {
  title?: string;
  subject?: string;
  recipient?: string;
  cc?: string;
  bcc?: string;
};
type WritingBlock = { kind: 'writing'; metadata: WritingMetadata; options: WritingOption[] };
export type WritingPart = { kind: 'markdown'; text: string } | WritingBlock;

const opener = /^ {0,3}:::writing\{(.*)\}[ \t]*$/;
const closer = /^ {0,3}:::[ \t]*$/;
const tone = /^---tone[ \t]+(\S[^\r\n]*)$/;

function metadata(value: string): WritingMetadata | undefined {
  const attribute = /\s*([a-z][a-z0-9_-]*)="((?:[^"\\]|\\.)*)"/iy;
  const fields = new Map<string, string>();
  while (attribute.lastIndex < value.trimEnd().length) {
    const entry = attribute.exec(value);
    if (
      !entry ||
      fields.has(entry[1]) ||
      (value[attribute.lastIndex] && !/\s/.test(value[attribute.lastIndex]))
    ) {
      return undefined;
    }
    fields.set(entry[1], entry[2].replace(/\\(["\\])/g, '$1'));
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(fields.get('variant') ?? '')) return undefined;
  return {
    title: fields.get('title'),
    subject: fields.get('subject'),
    recipient: fields.get('recipient'),
    cc: fields.get('cc'),
    bcc: fields.get('bcc'),
  };
}

type Fence = { character: string; length: number };
function nextFence(line: string, active?: Fence): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (active) {
    return match?.[1][0] === active.character && match[1].length >= active.length && !match[2].trim()
      ? undefined
      : active;
  }
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return undefined;
  return { character: match[1][0], length: match[1].length };
}

function bodyText(lines: string[]) {
  return lines.join('\n').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
}

function options(lines: string[], tones: { index: number; label: string }[]): WritingOption[] {
  if (tones.length < 2 || tones.length > 3 || lines.slice(0, tones[0].index).some((line) => line.trim())) {
    return [{ text: bodyText(lines) }];
  }
  const drafts = tones.map(({ index, label }, position) => ({
    label,
    text: bodyText(lines.slice(index + 1, tones[position + 1]?.index)),
  }));
  return drafts.every(({ text }) => text.trim()) ? drafts : [{ text: bodyText(lines) }];
}

export function splitWritingBlocks(source: string): WritingPart[] {
  if (!source.includes(':::writing{')) return [{ kind: 'markdown', text: source }];
  const lines = source.split(/\r\n|\n|\r/);
  const parts: WritingPart[] = [];
  let fence: Fence | undefined;
  let block:
    { index: number; metadata: WritingMetadata; tones: { index: number; label: string }[] } | undefined;
  let start = 0;
  for (const [index, line] of lines.entries()) {
    const previousFence = fence;
    fence = nextFence(line, fence);
    if (fence || previousFence) continue;
    const match = opener.exec(line);
    if (match) {
      const fields = metadata(match[1]);
      if (fields) block = { index, metadata: fields, tones: [] };
    } else if (block && closer.test(line)) {
      const body = lines.slice(block.index + 1, index);
      if (body.some((line) => line.trim())) {
        if (start < block.index)
          parts.push({ kind: 'markdown', text: lines.slice(start, block.index).join('\n') });
        parts.push({ kind: 'writing', metadata: block.metadata, options: options(body, block.tones) });
        start = index + 1;
      }
      block = undefined;
    } else if (block) {
      const marker = tone.exec(line);
      if (marker) block.tones.push({ index: index - block.index - 1, label: marker[1].trim() });
    }
  }
  if (!parts.length) return [{ kind: 'markdown', text: source }];
  if (start < lines.length) parts.push({ kind: 'markdown', text: lines.slice(start).join('\n') });
  return parts;
}
