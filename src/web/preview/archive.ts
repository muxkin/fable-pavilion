import { gunzipSync, unzipSync } from 'fflate';

export interface ArchiveEntry {
  path: string;
  name: string;
  directory: boolean;
  size: number;
}

export interface ParsedArchive {
  format: 'zip' | 'tar' | 'tar.gz' | 'gzip';
  entries: ArchiveEntry[];
  totalSize: number;
  truncated: boolean;
  readEntry(path: string): Uint8Array | null;
}

const MAX_ARCHIVE_BYTES = 48 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_TOTAL_UNCOMPRESSED = 96 * 1024 * 1024;
const MAX_SINGLE_EXTRACT = 24 * 1024 * 1024;

function normalizeEntryPath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function entryName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.split('/').at(-1) || trimmed || 'entry';
}

function parseOctal(bytes: Uint8Array): number {
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0) break;
    str += String.fromCharCode(c);
  }
  const trimmed = str.trim();
  if (!trimmed) return 0;
  const parsed = Number.parseInt(trimmed, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNullString(bytes: Uint8Array): string {
  let end = bytes.indexOf(0);
  if (end === -1) end = bytes.length;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, end));
}

function isTarBuffer(bytes: Uint8Array): boolean {
  if (bytes.length < 512) return false;
  const magic = parseNullString(bytes.subarray(257, 263));
  return magic === 'ustar' || magic === 'ustar ';
}

function parseTar(bytes: Uint8Array, format: 'tar' | 'tar.gz'): ParsedArchive {
  const entries: ArchiveEntry[] = [];
  const dataMap = new Map<string, Uint8Array>();
  let offset = 0;
  let totalSize = 0;
  let truncated = false;
  let nextLongName = '';

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = parseNullString(header.subarray(0, 100));
    const prefix = parseNullString(header.subarray(345, 500));
    const size = parseOctal(header.subarray(124, 136));
    const typeFlag = header[156];
    const dataStart = offset + 512;
    const dataEnd = Math.min(bytes.length, dataStart + size);
    const blocks = Math.ceil(size / 512) * 512;
    offset = dataStart + blocks;

    if (typeFlag === 76 /* 'L' GNU LongLink */) {
      nextLongName = parseNullString(bytes.subarray(dataStart, dataEnd));
      continue;
    }
    if (typeFlag === 120 /* 'x' PAX */ || typeFlag === 103 /* 'g' */) {
      continue;
    }

    const fullPath = normalizeEntryPath(nextLongName || (prefix ? `${prefix}/${rawName}` : rawName));
    nextLongName = '';
    if (!fullPath) continue;
    const directory = typeFlag === 53 /* '5' */ || fullPath.endsWith('/');
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    totalSize += size;
    if (totalSize > MAX_TOTAL_UNCOMPRESSED) {
      truncated = true;
      break;
    }
    const cleanPath = fullPath.replace(/\/+$/, '');
    entries.push({
      path: cleanPath,
      name: entryName(cleanPath),
      directory,
      size: directory ? 0 : size,
    });
    if (!directory && size <= MAX_SINGLE_EXTRACT) {
      dataMap.set(cleanPath, bytes.subarray(dataStart, dataEnd));
    }
  }

  entries.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return {
    format,
    entries,
    totalSize,
    truncated,
    readEntry(path: string) {
      return dataMap.get(normalizeEntryPath(path)) ?? null;
    },
  };
}

function parseZip(bytes: Uint8Array): ParsedArchive {
  let entryCount = 0;
  let totalSize = 0;
  let truncated = false;
  const files = unzipSync(bytes, {
    filter(file) {
      if (entryCount >= MAX_ENTRIES) {
        truncated = true;
        return false;
      }
      if (totalSize + file.originalSize > MAX_TOTAL_UNCOMPRESSED) {
        truncated = true;
        return false;
      }
      entryCount++;
      totalSize += file.originalSize;
      return file.originalSize <= MAX_SINGLE_EXTRACT;
    },
  });
  const entries: ArchiveEntry[] = [];
  const dataMap = new Map<string, Uint8Array>();
  for (const [rawPath, content] of Object.entries(files)) {
    const normalized = normalizeEntryPath(rawPath);
    if (!normalized) continue;
    const directory = rawPath.endsWith('/');
    const cleanPath = normalized.replace(/\/+$/, '');
    if (!cleanPath) continue;
    entries.push({
      path: cleanPath,
      name: entryName(cleanPath),
      directory,
      size: directory ? 0 : content.byteLength,
    });
    if (!directory) dataMap.set(cleanPath, content);
  }
  entries.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return {
    format: 'zip',
    entries,
    totalSize,
    truncated,
    readEntry(path: string) {
      const normalized = normalizeEntryPath(path);
      return dataMap.get(normalized) ?? null;
    },
  };
}

export function isArchiveExtension(extension: string): boolean {
  return ['zip', 'tar', 'gz', 'tgz', 'tar.gz'].includes(extension.toLowerCase());
}

export function parseArchive(bytes: Uint8Array, name: string, extension: string): ParsedArchive {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('压缩包超过 48 MB，暂不支持在线展开，请下载查看。');
  }
  const ext = extension.toLowerCase();
  const isZipSig = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
  const isGzipSig = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

  if (ext === 'zip' || isZipSig) {
    return parseZip(bytes);
  }
  if (ext === 'tar.gz' || ext === 'tgz' || ext === 'gz' || isGzipSig) {
    const inflated = gunzipSync(bytes);
    if (inflated.byteLength > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error('压缩包解压后体积过大，请下载查看。');
    }
    if (ext === 'tar.gz' || ext === 'tgz' || isTarBuffer(inflated)) {
      return parseTar(inflated, 'tar.gz');
    }
    const innerName = name.replace(/\.gz$/i, '') || 'content';
    return {
      format: 'gzip',
      entries: [{ path: innerName, name: innerName, directory: false, size: inflated.byteLength }],
      totalSize: inflated.byteLength,
      truncated: false,
      readEntry(path: string) {
        return normalizeEntryPath(path) === normalizeEntryPath(innerName) ? inflated : null;
      },
    };
  }
  if (ext === 'tar' || isTarBuffer(bytes)) {
    return parseTar(bytes, 'tar');
  }
  throw new Error('暂不支持此压缩包格式，请下载查看。');
}

export function resolveArchiveRelativePath(baseFilePath: string, relativeRef: string): string {
  const cleanedRef = relativeRef.split(/[?#]/)[0].replace(/\\/g, '/');
  let decoded = cleanedRef;
  try {
    decoded = decodeURIComponent(cleanedRef);
  } catch {
    /* keep raw */
  }
  if (decoded.startsWith('/')) return normalizeEntryPath(decoded);
  const baseParts = normalizeEntryPath(baseFilePath).split('/');
  baseParts.pop();
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}
