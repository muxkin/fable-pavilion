import { unzipSync } from 'fflate';
import { attachmentInfo } from '../shared/attachments';
import { attachmentMime } from '../shared/attachment-mime';
import type { AttachmentResource } from './AttachmentAccess';
import { detectedAttachmentSyntax, namedAttachmentSyntax, type AttachmentSyntax } from './attachment-syntax';
import { isArchiveExtension, parseArchive, type ParsedArchive } from './preview/archive';
import { parseNotebook, type ParsedNotebook } from './preview/notebook';
import { parsePptx, parseXlsx, type ParsedPresentation, type ParsedWorkbook } from './preview/ooxml';
import {
  parseStructuredText,
  structuredFormatFor,
  type StructuredPreviewData,
} from './preview/structured';

const TEXT_LIMIT = 256 * 1024;
const NOTEBOOK_LIMIT = 4 * 1024 * 1024;
const BINARY_LIMIT = 48 * 1024 * 1024;
const ROW_LIMIT = 250;
const COLUMN_LIMIT = 48;

async function readPrefix(file: AttachmentResource, limit: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (file.blob) {
    const bytes = new Uint8Array(await file.blob.slice(0, limit).arrayBuffer());
    signal.throwIfAborted();
    return { bytes, truncated: file.blob.size > limit };
  }
  if (file.size === 0) return { bytes: new Uint8Array(), truncated: false };
  // Private storage downloads can be on a separate origin. Read through the existing authorized endpoint.
  const url = file.url.startsWith('/') ? file.url : (file.downloadUrl ?? file.url);
  const response = await fetch(url, {
    signal,
    referrerPolicy: 'no-referrer',
    ...(url.startsWith('/local-files/') && { headers: { Range: `bytes=0-${limit}` } }),
  });
  if (!response.ok || !response.body) throw Error('文件读取失败，请重试');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(limit + 1);
  let length = 0;
  try {
    while (length < bytes.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, bytes.length - length);
      bytes.set(part, length);
      length += part.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  signal.throwIfAborted();
  return {
    bytes: bytes.subarray(0, Math.min(length, limit)),
    truncated: length > limit || file.size > limit,
  };
}

async function readFullBytes(file: AttachmentResource, limit: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (file.size > limit) return undefined;
  if (file.blob) {
    if (file.blob.size > limit) return undefined;
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    signal.throwIfAborted();
    return bytes;
  }
  const { bytes, truncated } = await readPrefix(file, limit, signal);
  return truncated ? undefined : bytes;
}

function decodeText(bytes: Uint8Array, truncated: boolean) {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated });
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

export function parseTable(text: string, separator: string, truncated: boolean) {
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false,
    clipped = false;
  const cell = () => {
    if (row.length < COLUMN_LIMIT) row.push(value);
    else clipped = true;
    value = '';
  };
  const line = () => {
    cell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    if (rows.length === ROW_LIMIT) {
      clipped = true;
      break;
    }
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && !value) quoted = true;
    else if (char === separator) cell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      line();
    } else value += char;
  }
  if (!truncated && rows.length < ROW_LIMIT && text && (quoted || !/[\r\n]$/.test(text))) line();
  return { rows, clipped: clipped || truncated };
}

export type AttachmentPreviewContent =
  | { kind: 'image' | 'video' | 'audio' }
  | { kind: 'svg'; text: string; truncated: boolean }
  | { kind: 'pdf'; bytes?: Uint8Array }
  | { kind: 'docx'; buffer: ArrayBuffer }
  | { kind: 'xlsx'; workbook: ParsedWorkbook }
  | { kind: 'pptx'; presentation: ParsedPresentation }
  | { kind: 'archive'; archive: ParsedArchive }
  | { kind: 'markdown'; text: string; truncated: boolean }
  | { kind: 'html'; text: string; truncated: boolean }
  | { kind: 'notebook'; notebook: ParsedNotebook; text: string; truncated: boolean }
  | { kind: 'unsupported'; reason: string }
  | {
      kind: 'text';
      text: string;
      truncated: boolean;
      syntax?: AttachmentSyntax;
      table?: ReturnType<typeof parseTable>;
      structured?: StructuredPreviewData;
    };

/** The transport only supplies authorized file bytes. Each viewer dispatches on this contract. */
export async function attachmentPreviewContent(
  file: AttachmentResource,
  path: string,
  signal: AbortSignal,
): Promise<AttachmentPreviewContent> {
  signal.throwIfAborted();
  const mime = file.mime.split(';')[0].trim().toLowerCase();
  const info = attachmentInfo(path, file.name);
  const ext = info.extension.toLowerCase();

  // SVG supports both safe vector canvas preview and source view.
  if (mime === 'image/svg+xml' || ext === 'svg') {
    const { bytes, truncated } = await readPrefix(file, TEXT_LIMIT, signal);
    const text = decodeText(bytes, truncated);
    if (text !== undefined) return { kind: 'svg', text, truncated };
    return { kind: 'image' };
  }

  for (const kind of ['image', 'video', 'audio'] as const) if (mime.startsWith(`${kind}/`)) return { kind };
  if (info.media === 'image') return { kind: 'image' };
  if (info.media === 'video') return { kind: 'video' };
  if (info.media === 'audio') return { kind: 'audio' };

  // PDF (inline Canvas rendering via lazy pdfjs-dist, with fallback link if > 48 MB)
  if (mime === 'application/pdf' || ext === 'pdf') {
    const bytes = await readFullBytes(file, BINARY_LIMIT, signal);
    return { kind: 'pdf', bytes };
  }

  // Word (.docx)
  if (
    ext === 'docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const bytes = await readFullBytes(file, BINARY_LIMIT, signal);
    if (!bytes) return { kind: 'unsupported', reason: 'Word 文档超过 48 MB，请下载后本地查看。' };
    try {
      const entries = unzipSync(bytes, {
        filter: (entry) => entry.name === 'word/document.xml',
      });
      if (!entries['word/document.xml']) {
        return { kind: 'unsupported', reason: '无法解析 Word 文档结构，请下载查看。' };
      }
    } catch {
      return { kind: 'unsupported', reason: 'Word 文档格式无效或已损坏，请下载查看。' };
    }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return { kind: 'docx', buffer };
  }

  // Excel (.xlsx)
  if (
    ext === 'xlsx' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    const bytes = await readFullBytes(file, BINARY_LIMIT, signal);
    if (!bytes) return { kind: 'unsupported', reason: 'Excel 文档超过 48 MB，请下载后本地查看。' };
    try {
      return { kind: 'xlsx', workbook: parseXlsx(bytes) };
    } catch (err) {
      return { kind: 'unsupported', reason: err instanceof Error ? err.message : '无法解析 Excel 文档。' };
    }
  }

  // PowerPoint (.pptx)
  if (
    ext === 'pptx' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    const bytes = await readFullBytes(file, BINARY_LIMIT, signal);
    if (!bytes) return { kind: 'unsupported', reason: 'PPT 文档超过 48 MB，请下载后本地查看。' };
    try {
      return { kind: 'pptx', presentation: parsePptx(bytes) };
    } catch (err) {
      return { kind: 'unsupported', reason: err instanceof Error ? err.message : '无法解析演示文稿。' };
    }
  }

  // Archives (.zip / .tar / .tar.gz / .tgz / .gz)
  if (
    isArchiveExtension(ext) ||
    mime === 'application/zip' ||
    mime === 'application/gzip' ||
    mime === 'application/x-gzip' ||
    mime === 'application/x-tar'
  ) {
    const bytes = await readFullBytes(file, BINARY_LIMIT, signal);
    if (!bytes) return { kind: 'unsupported', reason: '压缩包超过 48 MB，请下载后本地查看。' };
    try {
      return { kind: 'archive', archive: parseArchive(bytes, info.name, ext) };
    } catch (err) {
      return { kind: 'unsupported', reason: err instanceof Error ? err.message : '无法解析压缩包。' };
    }
  }

  // Jupyter Notebook (.ipynb)
  if (ext === 'ipynb') {
    const { bytes, truncated } = await readPrefix(file, NOTEBOOK_LIMIT, signal);
    const text = decodeText(bytes, truncated);
    if (text !== undefined) {
      const notebook = !truncated ? parseNotebook(text) : undefined;
      if (notebook) return { kind: 'notebook', notebook, text, truncated };
      return {
        kind: 'text',
        text: text.slice(0, TEXT_LIMIT),
        truncated: truncated || text.length > TEXT_LIMIT,
        syntax: { language: 'json', label: 'JSON' },
      };
    }
    return { kind: 'unsupported', reason: '无法解析 Jupyter 笔记本文件。' };
  }

  // Markdown (.md / .markdown)
  if (ext === 'md' || ext === 'markdown' || mime === 'text/markdown') {
    const { bytes, truncated } = await readPrefix(file, TEXT_LIMIT, signal);
    const text = decodeText(bytes, truncated);
    if (text !== undefined) return { kind: 'markdown', text, truncated };
    return { kind: 'unsupported', reason: 'Markdown 文件编码无法识别。' };
  }

  // HTML (.html / .htm)
  if (ext === 'html' || ext === 'htm' || mime === 'text/html') {
    const { bytes, truncated } = await readPrefix(file, TEXT_LIMIT, signal);
    const text = decodeText(bytes, truncated);
    if (text !== undefined) return { kind: 'html', text, truncated };
    return { kind: 'unsupported', reason: 'HTML 文件编码无法识别。' };
  }

  const hint = namedAttachmentSyntax(info.name, info.extension);
  const textCandidate =
    hint ||
    (info.previewable && ext !== 'pdf') ||
    mime.startsWith('text/') ||
    /(?:[+/])(?:json|xml|x-yaml|yaml|javascript)$/.test(mime) ||
    info.kind === '文件';
  if (textCandidate) {
    const { bytes, truncated } = await readPrefix(file, TEXT_LIMIT, signal);
    const signature = attachmentMime('', bytes.subarray(0, 4096));
    if (signature.startsWith('image/')) return { kind: 'image' };
    if (signature === 'application/pdf') {
      const full = await readFullBytes(file, BINARY_LIMIT, signal);
      return { kind: 'pdf', bytes: full };
    }
    // A UTF-16 BOM can also match the loose MPEG frame signature.
    const text = decodeText(bytes, truncated);
    if (text === undefined) return { kind: 'unsupported', reason: '文件编码无法识别，或内容不是文本。' };
    const delimiter =
      ext === 'tsv' || mime === 'text/tab-separated-values'
        ? '\t'
        : ext === 'csv' || mime === 'text/csv'
          ? ','
          : undefined;
    const structuredFormat = !truncated ? structuredFormatFor(ext, mime) : undefined;
    const structured = structuredFormat ? parseStructuredText(text, structuredFormat) : undefined;
    return {
      kind: 'text',
      text,
      truncated,
      syntax: hint ?? detectedAttachmentSyntax(text, mime),
      table: delimiter ? parseTable(text, delimiter, truncated) : undefined,
      structured,
    };
  }
  if (mime === 'application/octet-stream') {
    const { bytes } = await readPrefix(file, 32, signal);
    if (attachmentMime('', bytes).startsWith('image/')) return { kind: 'image' };
  }
  return { kind: 'unsupported', reason: '这种文件暂时无法在这里预览，可点击下载查看。' };
}
