import { unzipSync } from 'fflate';
import { attachmentMime } from '../../shared/attachment-mime';

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<XmlNode | string>;
}

const MAX_OOXML_BYTES = 32 * 1024 * 1024;
const MAX_OOXML_UNCOMPRESSED = 64 * 1024 * 1024;
const MAX_XLSX_SHEETS = 24;
const MAX_XLSX_ROWS = 400;
const MAX_XLSX_COLS = 64;
const MAX_PPTX_SLIDES = 120;

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function localName(name: string): string {
  const idx = name.indexOf(':');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/** Lightweight pure-TS XML parser for OOXML parts (works identically in browser & Node tests). */
function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const tokenRe = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^<>]*?)?)(\/?)>|([^<]+)/g;
  const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(xml))) {
    const parent = stack[stack.length - 1];
    if (match[1] !== undefined) {
      parent.children.push(match[1]);
      continue;
    }
    if (match[6] !== undefined) {
      parent.children.push(decodeXmlEntities(match[6]));
      continue;
    }
    if (!match[3]) continue;
    const isClose = match[2] === '/';
    const tag = localName(match[3]);
    const rawAttrs = match[4] ?? '';
    const selfClosing = match[5] === '/';
    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    let aMatch: RegExpExecArray | null;
    while ((aMatch = attrRe.exec(rawAttrs))) {
      attrs[localName(aMatch[1])] = decodeXmlEntities(aMatch[2] ?? aMatch[3] ?? '');
    }
    const node: XmlNode = { tag, attrs, children: [] };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function childElements(node: XmlNode, tag?: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of node.children) {
    if (typeof child !== 'string' && (!tag || child.tag === tag)) out.push(child);
  }
  return out;
}

function findAll(node: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (typeof child !== 'string') {
      if (child.tag === tag) out.push(child);
      findAll(child, tag, out);
    }
  }
  return out;
}

function textContent(node: XmlNode): string {
  let text = '';
  for (const child of node.children) {
    if (typeof child === 'string') text += child;
    else text += textContent(child);
  }
  return text;
}

function unzipOoxml(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.byteLength > MAX_OOXML_BYTES) {
    throw new Error('文档体积超过 32 MB，请下载后使用本地应用打开。');
  }
  let total = 0;
  return unzipSync(bytes, {
    filter(file) {
      total += file.originalSize;
      return total <= MAX_OOXML_UNCOMPRESSED;
    },
  });
}

function readXmlPart(files: Record<string, Uint8Array>, path: string): XmlNode | undefined {
  const normalized = path.replace(/^\/+/, '');
  const data = files[normalized];
  if (!data) return undefined;
  return parseXml(new TextDecoder('utf-8', { fatal: false }).decode(data));
}

function parseRels(files: Record<string, Uint8Array>, relsPath: string): Map<string, string> {
  const map = new Map<string, string>();
  const doc = readXmlPart(files, relsPath);
  if (!doc) return map;
  for (const rel of findAll(doc, 'Relationship')) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (id && target) map.set(id, target);
  }
  return map;
}

function resolveZipTarget(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const parts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const seg of target.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function columnIndexFromRef(ref: string): number {
  const letters = /^([A-Z]+)/i.exec(ref)?.[1]?.toUpperCase();
  if (!letters) return -1;
  let index = 0;
  for (let i = 0; i < letters.length; i++) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1;
}

function formatExcelDate(serial: number): string {
  // Excel 1900 date system (accounting for 1900 leap-year bug).
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const frac = serial - Math.floor(serial);
  if (frac > 0.0001) {
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mm = String(date.getUTCMinutes()).padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }
  return `${y}-${m}-${d}`;
}

function parseDateStyleIds(files: Record<string, Uint8Array>): Set<number> {
  const dateStyles = new Set<number>();
  const styles = readXmlPart(files, 'xl/styles.xml');
  if (!styles) return dateStyles;
  const customDateFmtIds = new Set<number>();
  for (const numFmt of findAll(styles, 'numFmt')) {
    const id = Number(numFmt.attrs.numFmtId);
    const code = (numFmt.attrs.formatCode ?? '').replace(/"[^"]*"/g, '').toLowerCase();
    if (Number.isFinite(id) && /[ymdhs]/.test(code) && !/^[#0.,%\s]+$/.test(code)) {
      customDateFmtIds.add(id);
    }
  }
  const cellXfs = findAll(styles, 'cellXfs')[0];
  if (!cellXfs) return dateStyles;
  const xfs = childElements(cellXfs, 'xf');
  xfs.forEach((xf, idx) => {
    const numFmtId = Number(xf.attrs.numFmtId);
    const isBuiltInDate =
      (numFmtId >= 14 && numFmtId <= 22) || (numFmtId >= 45 && numFmtId <= 47);
    if (isBuiltInDate || customDateFmtIds.has(numFmtId)) dateStyles.add(idx);
  });
  return dateStyles;
}

export interface ParsedSheet {
  name: string;
  rows: string[][];
  clipped: boolean;
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[];
  clippedSheets: boolean;
}

export function parseXlsx(bytes: Uint8Array): ParsedWorkbook {
  const files = unzipOoxml(bytes);
  const workbook = readXmlPart(files, 'xl/workbook.xml');
  if (!workbook) throw new Error('无法解析 Excel 工作簿结构');
  const rels = parseRels(files, 'xl/_rels/workbook.xml.rels');
  const dateStyles = parseDateStyleIds(files);

  const sharedStrings: string[] = [];
  const sst = readXmlPart(files, 'xl/sharedStrings.xml');
  if (sst) {
    for (const si of findAll(sst, 'si')) {
      const texts = findAll(si, 't').map(textContent);
      sharedStrings.push(texts.join(''));
    }
  }

  const sheetNodes = findAll(workbook, 'sheet');
  const clippedSheets = sheetNodes.length > MAX_XLSX_SHEETS;
  const sheets: ParsedSheet[] = [];

  for (const node of sheetNodes.slice(0, MAX_XLSX_SHEETS)) {
    const name = node.attrs.name || `Sheet ${sheets.length + 1}`;
    const rId = node.attrs.id;
    const target = rId ? rels.get(rId) : undefined;
    const partPath = target ? resolveZipTarget('xl', target) : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const sheetXml = readXmlPart(files, partPath);
    if (!sheetXml) continue;

    const rows: string[][] = [];
    let clipped = false;
    const rowNodes = findAll(sheetXml, 'row');
    if (rowNodes.length > MAX_XLSX_ROWS) clipped = true;

    for (const rowNode of rowNodes.slice(0, MAX_XLSX_ROWS)) {
      const rowValues: string[] = [];
      let cursor = 0;
      for (const cell of childElements(rowNode, 'c')) {
        const refCol = cell.attrs.r ? columnIndexFromRef(cell.attrs.r) : cursor;
        const col = refCol >= 0 ? refCol : cursor;
        cursor = col + 1;
        if (col >= MAX_XLSX_COLS) {
          clipped = true;
          continue;
        }
        while (rowValues.length < col) rowValues.push('');
        const type = cell.attrs.t ?? '';
        const styleIdx = cell.attrs.s ? Number(cell.attrs.s) : -1;
        let value = '';
        if (type === 'inlineStr') {
          value = findAll(cell, 't').map(textContent).join('');
        } else {
          const vNode = childElements(cell, 'v')[0];
          const raw = vNode ? textContent(vNode) : '';
          if (type === 's') {
            const idx = Number(raw);
            value = Number.isInteger(idx) ? (sharedStrings[idx] ?? '') : raw;
          } else if (type === 'b') {
            value = raw === '1' ? 'TRUE' : 'FALSE';
          } else if ((type === '' || type === 'n') && raw !== '' && dateStyles.has(styleIdx)) {
            const num = Number(raw);
            value = Number.isFinite(num) ? formatExcelDate(num) : raw;
          } else {
            value = raw;
          }
        }
        rowValues[col] = value;
      }
      // Trim trailing empty cells
      while (rowValues.length > 0 && rowValues[rowValues.length - 1] === '') rowValues.pop();
      rows.push(rowValues);
    }
    sheets.push({ name, rows, clipped });
  }

  if (!sheets.length) throw new Error('Excel 文件中没有可预览的工作表');
  return { sheets, clippedSheets };
}

export interface ParsedSlideImage {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ParsedSlide {
  index: number;
  title: string;
  paragraphs: string[];
  notes: string[];
  images: ParsedSlideImage[];
}

export interface ParsedPresentation {
  slides: ParsedSlide[];
  clippedSlides: boolean;
}

function extractDrawingParagraphs(xml: XmlNode): string[] {
  const paragraphs: string[] = [];
  for (const p of findAll(xml, 'p')) {
    const runs = findAll(p, 't').map(textContent);
    const line = runs.join('').trim();
    if (line) paragraphs.push(line);
  }
  return paragraphs;
}

export function parsePptx(bytes: Uint8Array): ParsedPresentation {
  const files = unzipOoxml(bytes);
  const pres = readXmlPart(files, 'ppt/presentation.xml');
  if (!pres) throw new Error('无法解析 PowerPoint 演示文稿结构');
  const presRels = parseRels(files, 'ppt/_rels/presentation.xml.rels');

  const sldIds = findAll(pres, 'sldId');
  const slidePaths: string[] = [];
  for (const sldId of sldIds) {
    const rId = sldId.attrs.id;
    const target = rId ? presRels.get(rId) : undefined;
    if (target) slidePaths.push(resolveZipTarget('ppt', target));
  }
  if (!slidePaths.length) {
    // Fallback to numeric slide filenames
    Object.keys(files)
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
      .sort((a, b) => {
        const na = Number(/slide(\d+)\.xml/i.exec(a)?.[1] ?? 0);
        const nb = Number(/slide(\d+)\.xml/i.exec(b)?.[1] ?? 0);
        return na - nb;
      })
      .forEach((p) => slidePaths.push(p));
  }
  if (!slidePaths.length) throw new Error('演示文稿中没有可预览的幻灯片');

  const clippedSlides = slidePaths.length > MAX_PPTX_SLIDES;
  const slides: ParsedSlide[] = [];

  slidePaths.slice(0, MAX_PPTX_SLIDES).forEach((slidePath, idx) => {
    const slideXml = readXmlPart(files, slidePath);
    if (!slideXml) return;
    const slideDir = slidePath.slice(0, slidePath.lastIndexOf('/'));
    const slideFile = slidePath.slice(slidePath.lastIndexOf('/') + 1);
    const slideRels = parseRels(files, `${slideDir}/_rels/${slideFile}.rels`);

    const paragraphs = extractDrawingParagraphs(slideXml);
    const title = paragraphs[0] ?? `第 ${idx + 1} 页`;
    const bodyParagraphs = paragraphs.length > 1 ? paragraphs.slice(1) : [];

    // Extract speaker notes if linked
    const notes: string[] = [];
    for (const target of slideRels.values()) {
      if (target.includes('notesSlide')) {
        const notePath = resolveZipTarget(slideDir, target);
        const noteXml = readXmlPart(files, notePath);
        if (noteXml) notes.push(...extractDrawingParagraphs(noteXml));
      }
    }

    // Extract embedded images referenced by <a:blip r:embed="..."/>
    const images: ParsedSlideImage[] = [];
    const seenTargets = new Set<string>();
    for (const blip of findAll(slideXml, 'blip')) {
      const embed = blip.attrs.embed;
      if (!embed) continue;
      const target = slideRels.get(embed);
      if (!target) continue;
      const mediaPath = resolveZipTarget(slideDir, target);
      if (seenTargets.has(mediaPath)) continue;
      seenTargets.add(mediaPath);
      const imgBytes = files[mediaPath];
      if (!imgBytes || imgBytes.byteLength === 0) continue;
      const imgName = mediaPath.split('/').at(-1) || 'image';
      const mime = attachmentMime(imgName, imgBytes.subarray(0, 64));
      if (mime.startsWith('image/')) {
        images.push({ name: imgName, mime, bytes: imgBytes });
      }
    }

    slides.push({
      index: idx + 1,
      title,
      paragraphs: bodyParagraphs,
      notes,
      images,
    });
  });

  return { slides, clippedSlides };
}
