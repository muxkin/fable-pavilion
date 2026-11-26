export interface NotebookOutput {
  kind: 'text' | 'html' | 'image' | 'error';
  text?: string;
  html?: string;
  mime?: string;
  dataUrl?: string;
  name?: string;
}

export interface NotebookCell {
  index: number;
  cellType: 'markdown' | 'code' | 'raw';
  executionCount: number | null;
  source: string;
  outputs: NotebookOutput[];
}

export interface ParsedNotebook {
  language: string;
  kernelName: string;
  cells: NotebookCell[];
  truncated: boolean;
}

const MAX_CELLS = 200;
const MAX_OUTPUT_TEXT = 32 * 1024;
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;

function joinLines(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item : '')).join('');
  return '';
}

function cleanText(text: string): string {
  const stripped = text.replace(ANSI_PATTERN, '');
  return stripped.length > MAX_OUTPUT_TEXT ? `${stripped.slice(0, MAX_OUTPUT_TEXT)}\n…（输出过长已截断）` : stripped;
}

function parseOutputs(rawOutputs: unknown): NotebookOutput[] {
  if (!Array.isArray(rawOutputs)) return [];
  const outputs: NotebookOutput[] = [];
  for (const item of rawOutputs.slice(0, 24)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const type = String(record.output_type ?? '');
    if (type === 'stream') {
      const text = cleanText(joinLines(record.text));
      if (text) outputs.push({ kind: 'text', text, name: String(record.name ?? 'stdout') });
      continue;
    }
    if (type === 'error') {
      const trace = Array.isArray(record.traceback)
        ? cleanText(record.traceback.map((line) => String(line ?? '')).join('\n'))
        : cleanText(`${String(record.ename ?? 'Error')}: ${String(record.evalue ?? '')}`);
      outputs.push({ kind: 'error', text: trace });
      continue;
    }
    if (type === 'execute_result' || type === 'display_data') {
      const data = record.data;
      if (!data || typeof data !== 'object') continue;
      const mimeMap = data as Record<string, unknown>;
      const imageMime = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].find(
        (key) => mimeMap[key] !== undefined,
      );
      if (imageMime) {
        const b64 = joinLines(mimeMap[imageMime]).replace(/\s+/g, '');
        if (b64) {
          outputs.push({
            kind: 'image',
            mime: imageMime,
            dataUrl: `data:${imageMime};base64,${b64}`,
          });
          continue;
        }
      }
      if (mimeMap['image/svg+xml'] !== undefined) {
        const svg = joinLines(mimeMap['image/svg+xml']);
        if (svg.trim()) {
          const encoded = btoa(unescape(encodeURIComponent(svg)));
          outputs.push({
            kind: 'image',
            mime: 'image/svg+xml',
            dataUrl: `data:image/svg+xml;base64,${encoded}`,
          });
          continue;
        }
      }
      if (mimeMap['text/html'] !== undefined) {
        const html = joinLines(mimeMap['text/html']);
        if (html.trim()) {
          outputs.push({ kind: 'html', html });
          continue;
        }
      }
      if (mimeMap['text/plain'] !== undefined) {
        const text = cleanText(joinLines(mimeMap['text/plain']));
        if (text) outputs.push({ kind: 'text', text });
      }
    }
  }
  return outputs;
}

export function parseNotebook(text: string): ParsedNotebook | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const doc = raw as Record<string, unknown>;
  if (!Array.isArray(doc.cells)) return undefined;
  const metadata = (doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {}) as Record<
    string,
    unknown
  >;
  const kernelspec = (
    metadata.kernelspec && typeof metadata.kernelspec === 'object' ? metadata.kernelspec : {}
  ) as Record<string, unknown>;
  const languageInfo = (
    metadata.language_info && typeof metadata.language_info === 'object' ? metadata.language_info : {}
  ) as Record<string, unknown>;
  const language = String(languageInfo.name ?? kernelspec.language ?? 'python').toLowerCase();
  const kernelName = String(kernelspec.display_name ?? kernelspec.name ?? language);
  const truncated = doc.cells.length > MAX_CELLS;
  const cells: NotebookCell[] = doc.cells.slice(0, MAX_CELLS).map((cell, index) => {
    const rec = (cell && typeof cell === 'object' ? cell : {}) as Record<string, unknown>;
    const rawType = String(rec.cell_type ?? 'raw');
    const cellType = rawType === 'markdown' || rawType === 'code' ? rawType : 'raw';
    const exec = typeof rec.execution_count === 'number' ? rec.execution_count : null;
    return {
      index,
      cellType,
      executionCount: exec,
      source: joinLines(rec.source),
      outputs: cellType === 'code' ? parseOutputs(rec.outputs) : [],
    };
  });
  return { language, kernelName, cells, truncated };
}
