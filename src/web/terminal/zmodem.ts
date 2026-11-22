import { concatBytes, indexOfSubarray } from './shell-escape';

export interface TerminalTransferProgress {
  protocol: 'lrzsz' | 'trzsz';
  direction: 'download' | 'upload';
  fileName: string;
  transferred: number;
  total: number;
  fileIndex: number;
  fileCount: number;
  status: 'active' | 'done' | 'error' | 'cancelled';
  message?: string;
}

export interface ZmodemCallbacks {
  sendBytes: (bytes: Uint8Array) => void;
  onProgress: (progress: TerminalTransferProgress | null) => void;
  onDownloadFile: (name: string, data: Uint8Array) => void;
  onRequestUploadFiles: () => Promise<File[]>;
}

const ZPAD = 0x2a; // '*'
const ZDLE = 0x18; // CAN
const ZBIN = 0x41; // 'A'
const ZHEX = 0x42; // 'B'
const ZBIN32 = 0x43; // 'C'

const ZRQINIT = 0;
const ZRINIT = 1;
const ZFILE = 4;
const ZSKIP = 5;
const ZFIN = 8;
const ZRPOS = 9;
const ZDATA = 10;
const ZEOF = 11;

const ZCRCE = 0x68; // 'h'
const ZCRCG = 0x69; // 'i'
const ZCRCQ = 0x6a; // 'j'
const ZCRCW = 0x6b; // 'k'

const CANFDX = 0x01;
const CANOVIO = 0x02;
const CANFC32 = 0x20;

const ZRQINIT_MAGIC = new Uint8Array([ZPAD, ZPAD, ZDLE, ZHEX, 0x30, 0x30]); // **\x18B00
const ZRINIT_MAGIC = new Uint8Array([ZPAD, ZPAD, ZDLE, ZHEX, 0x30, 0x31]); // **\x18B01
const CANCEL_SEQ = new Uint8Array([
  0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc16Xmodem(bytes: Uint8Array, seed = 0): number {
  let crc = seed & 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function crc32Zmodem(bytes: Uint8Array, seed = 0xffffffff): number {
  let crc = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

export function encodeZdle(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const mustEscape =
      b === ZDLE ||
      b === 0x10 ||
      b === 0x90 ||
      b === 0x11 ||
      b === 0x91 ||
      b === 0x13 ||
      b === 0x93 ||
      b === 0x7f ||
      b === 0xff ||
      ((b === 0x0d || b === 0x8d) && (prev & 0x7f) === 0x40);
    if (mustEscape) {
      out.push(ZDLE, b ^ 0x40);
    } else {
      out.push(b);
    }
    prev = b;
  }
  return new Uint8Array(out);
}

export function buildZhexHeader(type: number, flags: [number, number, number, number] = [0, 0, 0, 0]): Uint8Array {
  const body = new Uint8Array([type, flags[0], flags[1], flags[2], flags[3]]);
  const crc = crc16Xmodem(body);
  const full = new Uint8Array([type, flags[0], flags[1], flags[2], flags[3], (crc >> 8) & 0xff, crc & 0xff]);
  const hex = Array.from(full, (b) => b.toString(16).padStart(2, '0')).join('');
  const tail = type === ZFIN || type === ZACK_TYPE ? '\r\n' : '\r\n\x11';
  const enc = new TextEncoder().encode(`**\x18B${hex}${tail}`);
  return enc;
}

const ZACK_TYPE = 3;

export function buildZbin32Header(
  type: number,
  flags: [number, number, number, number] = [0, 0, 0, 0],
): Uint8Array {
  const body = new Uint8Array([type, flags[0], flags[1], flags[2], flags[3]]);
  const crc = (~crc32Zmodem(body)) >>> 0;
  const raw = new Uint8Array([
    type,
    flags[0],
    flags[1],
    flags[2],
    flags[3],
    crc & 0xff,
    (crc >>> 8) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 24) & 0xff,
  ]);
  return concatBytes([new Uint8Array([ZPAD, ZDLE, ZBIN32]), encodeZdle(raw)]);
}

function encodeSubpacket32(payload: Uint8Array, frameEnd: number): Uint8Array {
  let crc = crc32Zmodem(payload);
  crc = crc32Zmodem(new Uint8Array([frameEnd]), crc);
  crc = (~crc) >>> 0;
  const crcBytes = new Uint8Array([
    crc & 0xff,
    (crc >>> 8) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 24) & 0xff,
  ]);
  return concatBytes([encodeZdle(payload), new Uint8Array([ZDLE, frameEnd]), encodeZdle(crcBytes)]);
}

function uint32ToFlags(value: number): [number, number, number, number] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function flagsToUint32(flags: [number, number, number, number]): number {
  return (flags[0] | (flags[1] << 8) | (flags[2] << 16) | (flags[3] << 24)) >>> 0;
}

interface ParsedHeader {
  type: number;
  flags: [number, number, number, number];
  crc32: boolean;
  consumed: number;
}

function parseHexByte(a: number, b: number): number | null {
  const nibble = (c: number) => {
    if (c >= 0x30 && c <= 0x39) return c - 0x30;
    if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
    return -1;
  };
  const hi = nibble(a);
  const lo = nibble(b);
  return hi < 0 || lo < 0 ? null : (hi << 4) | lo;
}

function readZdleBytes(
  buf: Uint8Array,
  start: number,
  count: number,
): { bytes: Uint8Array; next: number } | null {
  const out = new Uint8Array(count);
  let outIdx = 0;
  let i = start;
  while (outIdx < count) {
    if (i >= buf.length) return null;
    const b = buf[i++];
    if (b === ZDLE) {
      if (i >= buf.length) return null;
      const esc = buf[i++];
      out[outIdx++] = esc ^ 0x40;
    } else {
      out[outIdx++] = b;
    }
  }
  return { bytes: out, next: i };
}

function tryParseHeader(buf: Uint8Array): ParsedHeader | null {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== ZPAD) continue;
    let j = i + 1;
    while (j < buf.length && buf[j] === ZPAD) j++;
    if (j + 1 >= buf.length) return null;
    if (buf[j] !== ZDLE) continue;
    const format = buf[j + 1];
    if (format === ZHEX) {
      if (j + 2 + 14 > buf.length) return null;
      const decoded = new Uint8Array(7);
      let valid = true;
      for (let k = 0; k < 7; k++) {
        const byte = parseHexByte(buf[j + 2 + k * 2], buf[j + 2 + k * 2 + 1]);
        if (byte === null) {
          valid = false;
          break;
        }
        decoded[k] = byte;
      }
      if (!valid) continue;
      let end = j + 2 + 14;
      while (end < buf.length && (buf[end] === 0x0d || buf[end] === 0x0a || buf[end] === 0x11 || buf[end] === 0x8a)) {
        end++;
      }
      return {
        type: decoded[0],
        flags: [decoded[1], decoded[2], decoded[3], decoded[4]],
        crc32: false,
        consumed: end,
      };
    }
    if (format === ZBIN || format === ZBIN32) {
      const want = format === ZBIN32 ? 9 : 7;
      const read = readZdleBytes(buf, j + 2, want);
      if (!read) return null;
      return {
        type: read.bytes[0],
        flags: [read.bytes[1], read.bytes[2], read.bytes[3], read.bytes[4]],
        crc32: format === ZBIN32,
        consumed: read.next,
      };
    }
  }
  return null;
}

interface ParsedSubpacket {
  data: Uint8Array;
  frameEnd: number;
  consumed: number;
}

function tryParseSubpacket(buf: Uint8Array, crc32: boolean): ParsedSubpacket | null {
  const out: number[] = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i++];
    if (b === ZDLE) {
      if (i >= buf.length) return null;
      const next = buf[i++];
      if (next === ZCRCE || next === ZCRCG || next === ZCRCQ || next === ZCRCW) {
        const crcLen = crc32 ? 4 : 2;
        const crcRead = readZdleBytes(buf, i, crcLen);
        if (!crcRead) return null;
        return {
          data: new Uint8Array(out),
          frameEnd: next,
          consumed: crcRead.next,
        };
      }
      out.push(next ^ 0x40);
    } else {
      out.push(b);
    }
  }
  return null;
}

type Mode =
  | 'idle'
  | 'dl-wait-header'
  | 'dl-wait-file-subpacket'
  | 'dl-wait-data'
  | 'ul-choosing'
  | 'ul-wait-zrpos'
  | 'ul-wait-zrinit'
  | 'ul-wait-zfin';

export class ZmodemFilter {
  private mode: Mode = 'idle';
  private buffer: Uint8Array = new Uint8Array(0);
  private currentCrc32 = true;
  private dlFileName = '';
  private dlTotal = 0;
  private dlChunks: Uint8Array[] = [];
  private dlReceived = 0;
  private dlIndex = 0;

  private ulFiles: { name: string; data: Uint8Array }[] = [];
  private ulIndex = 0;
  private cancelled = false;

  constructor(private readonly callbacks: ZmodemCallbacks) {}

  get active(): boolean {
    return this.mode !== 'idle';
  }

  cancel() {
    if (this.mode === 'idle') return;
    this.cancelled = true;
    this.callbacks.sendBytes(CANCEL_SEQ);
    this.callbacks.sendBytes(new Uint8Array([0x0d, 0x0a]));
    this.reset('已取消 lrzsz 传输');
  }

  private reset(message?: string) {
    const wasActive = this.mode !== 'idle';
    this.mode = 'idle';
    this.buffer = new Uint8Array(0);
    this.dlChunks = [];
    this.dlReceived = 0;
    this.dlTotal = 0;
    this.dlFileName = '';
    this.dlIndex = 0;
    this.ulFiles = [];
    this.ulIndex = 0;
    if (wasActive && message) {
      this.callbacks.onProgress({
        protocol: 'lrzsz',
        direction: 'download',
        fileName: '',
        transferred: 0,
        total: 0,
        fileIndex: 0,
        fileCount: 0,
        status: 'cancelled',
        message,
      });
      setTimeout(() => this.callbacks.onProgress(null), 1500);
    } else if (wasActive) {
      this.callbacks.onProgress(null);
    }
  }

  process(chunk: Uint8Array): Uint8Array {
    if (!chunk.length) return chunk;

    if (this.mode === 'idle') {
      const scan = this.buffer.length ? concatBytes([this.buffer, chunk]) : chunk;
      this.buffer = new Uint8Array(0);
      const szIdx = indexOfSubarray(scan, ZRQINIT_MAGIC);
      const rzIdx = indexOfSubarray(scan, ZRINIT_MAGIC);
      const hit = szIdx >= 0 && (rzIdx < 0 || szIdx < rzIdx) ? { idx: szIdx, kind: 'sz' as const } : rzIdx >= 0 ? { idx: rzIdx, kind: 'rz' as const } : null;
      if (!hit) {
        // Keep trailing 6 bytes in case magic straddles chunks, unless no ZPAD present.
        if (scan.length >= 1 && scan[scan.length - 1] === ZPAD) {
          this.buffer = scan.slice(-1);
          return scan.subarray(0, scan.length - 1);
        }
        return scan;
      }
      const before = scan.subarray(0, hit.idx);
      const rest = scan.subarray(hit.idx);
      this.cancelled = false;
      this.buffer = rest;
      if (hit.kind === 'sz') {
        this.mode = 'dl-wait-header';
        this.pump();
      } else {
        this.startUpload();
      }
      return before;
    }

    // Check for 5 consecutive CAN bytes from remote.
    if (indexOfSubarray(chunk, new Uint8Array([ZDLE, ZDLE, ZDLE, ZDLE, ZDLE])) >= 0) {
      this.reset('对端取消了 lrzsz 传输');
      return new Uint8Array(0);
    }

    this.buffer = concatBytes([this.buffer, chunk]);
    this.pump();
    return new Uint8Array(0);
  }

  private sendZrinit() {
    this.callbacks.sendBytes(buildZhexHeader(ZRINIT, [0, 0, 0, CANFDX | CANOVIO | CANFC32]));
  }

  private pump() {
    let progressed = true;
    while (progressed && this.mode !== 'idle') {
      progressed = false;
      if (this.mode === 'dl-wait-header') {
        const hdr = tryParseHeader(this.buffer);
        if (!hdr) break;
        this.buffer = this.buffer.subarray(hdr.consumed);
        this.currentCrc32 = hdr.crc32;
        progressed = true;
        if (hdr.type === ZRQINIT) {
          this.sendZrinit();
        } else if (hdr.type === ZFILE) {
          this.mode = 'dl-wait-file-subpacket';
        } else if (hdr.type === ZDATA) {
          this.mode = 'dl-wait-data';
        } else if (hdr.type === ZEOF) {
          this.finishDownloadFile();
          this.sendZrinit();
        } else if (hdr.type === ZFIN) {
          this.callbacks.sendBytes(buildZhexHeader(ZFIN));
          this.callbacks.sendBytes(new Uint8Array([0x4f, 0x4f])); // "OO"
          this.callbacks.onProgress({
            protocol: 'lrzsz',
            direction: 'download',
            fileName: this.dlFileName,
            transferred: this.dlTotal,
            total: this.dlTotal,
            fileIndex: this.dlIndex,
            fileCount: this.dlIndex,
            status: 'done',
            message: 'lrzsz 下载完成',
          });
          this.mode = 'idle';
          this.buffer = new Uint8Array(0);
          setTimeout(() => this.callbacks.onProgress(null), 1800);
          break;
        }
      } else if (this.mode === 'dl-wait-file-subpacket') {
        const sub = tryParseSubpacket(this.buffer, this.currentCrc32);
        if (!sub) break;
        this.buffer = this.buffer.subarray(sub.consumed);
        progressed = true;
        const nul = sub.data.indexOf(0);
        const decoder = new TextDecoder('utf-8');
        this.dlFileName = nul >= 0 ? decoder.decode(sub.data.subarray(0, nul)) : 'download.bin';
        const meta = nul >= 0 ? decoder.decode(sub.data.subarray(nul + 1)) : '';
        const sizeMatch = /^(\d+)/.exec(meta.trim());
        this.dlTotal = sizeMatch ? Number(sizeMatch[1]) : 0;
        this.dlChunks = [];
        this.dlReceived = 0;
        this.dlIndex++;
        this.callbacks.onProgress({
          protocol: 'lrzsz',
          direction: 'download',
          fileName: this.dlFileName,
          transferred: 0,
          total: this.dlTotal,
          fileIndex: this.dlIndex,
          fileCount: this.dlIndex,
          status: 'active',
        });
        this.callbacks.sendBytes(buildZhexHeader(ZRPOS, [0, 0, 0, 0]));
        this.mode = 'dl-wait-header';
      } else if (this.mode === 'dl-wait-data') {
        const sub = tryParseSubpacket(this.buffer, this.currentCrc32);
        if (!sub) break;
        this.buffer = this.buffer.subarray(sub.consumed);
        progressed = true;
        if (sub.data.length) {
          this.dlChunks.push(sub.data);
          this.dlReceived += sub.data.length;
          this.callbacks.onProgress({
            protocol: 'lrzsz',
            direction: 'download',
            fileName: this.dlFileName,
            transferred: this.dlReceived,
            total: Math.max(this.dlTotal, this.dlReceived),
            fileIndex: this.dlIndex,
            fileCount: this.dlIndex,
            status: 'active',
          });
        }
        if (sub.frameEnd === ZCRCQ || sub.frameEnd === ZCRCW) {
          this.callbacks.sendBytes(buildZhexHeader(ZACK_TYPE, uint32ToFlags(this.dlReceived)));
        }
        if (sub.frameEnd === ZCRCE || sub.frameEnd === ZCRCW) {
          this.mode = 'dl-wait-header';
        }
      } else if (this.mode === 'ul-wait-zrpos') {
        const hdr = tryParseHeader(this.buffer);
        if (!hdr) break;
        this.buffer = this.buffer.subarray(hdr.consumed);
        progressed = true;
        if (hdr.type === ZRPOS) {
          const offset = flagsToUint32(hdr.flags);
          this.sendCurrentUploadFile(offset);
        } else if (hdr.type === ZSKIP) {
          this.ulIndex++;
          this.sendNextUploadHeader();
        } else if (hdr.type === ZFIN) {
          this.finishUpload();
        }
      } else if (this.mode === 'ul-wait-zrinit') {
        const hdr = tryParseHeader(this.buffer);
        if (!hdr) break;
        this.buffer = this.buffer.subarray(hdr.consumed);
        progressed = true;
        if (hdr.type === ZRINIT) {
          this.ulIndex++;
          this.sendNextUploadHeader();
        } else if (hdr.type === ZFIN) {
          this.finishUpload();
        }
      } else if (this.mode === 'ul-wait-zfin') {
        const hdr = tryParseHeader(this.buffer);
        if (!hdr) break;
        this.buffer = this.buffer.subarray(hdr.consumed);
        progressed = true;
        if (hdr.type === ZFIN) {
          this.finishUpload();
        }
      }
    }
  }

  private finishDownloadFile() {
    if (!this.dlFileName) return;
    const merged = concatBytes(this.dlChunks);
    const data = this.dlTotal > 0 && merged.length > this.dlTotal ? merged.subarray(0, this.dlTotal) : merged;
    this.callbacks.onDownloadFile(this.dlFileName, data);
    this.dlChunks = [];
  }

  private startUpload() {
    this.mode = 'ul-choosing';
    this.buffer = new Uint8Array(0);
    this.callbacks.onProgress({
      protocol: 'lrzsz',
      direction: 'upload',
      fileName: '请选择要上传的文件…',
      transferred: 0,
      total: 0,
      fileIndex: 0,
      fileCount: 0,
      status: 'active',
    });
    void this.callbacks
      .onRequestUploadFiles()
      .then(async (files) => {
        if (this.cancelled) return;
        if (!files.length) {
          this.callbacks.sendBytes(buildZhexHeader(ZFIN));
          this.reset('未选择文件，已结束 rz');
          return;
        }
        this.ulFiles = [];
        for (const file of files) {
          this.ulFiles.push({
            name: file.name,
            data: new Uint8Array(await file.arrayBuffer()),
          });
        }
        this.ulIndex = 0;
        this.sendNextUploadHeader();
      })
      .catch(() => {
        this.cancel();
      });
  }

  private sendNextUploadHeader() {
    if (this.ulIndex >= this.ulFiles.length) {
      this.mode = 'ul-wait-zfin';
      this.callbacks.sendBytes(buildZhexHeader(ZFIN));
      return;
    }
    const file = this.ulFiles[this.ulIndex];
    this.callbacks.onProgress({
      protocol: 'lrzsz',
      direction: 'upload',
      fileName: file.name,
      transferred: 0,
      total: file.data.length,
      fileIndex: this.ulIndex + 1,
      fileCount: this.ulFiles.length,
      status: 'active',
    });
    const meta = new TextEncoder().encode(`${file.name}\0${file.data.length} 0 100644 0 1 ${file.data.length}\0`);
    this.callbacks.sendBytes(buildZbin32Header(ZFILE, [0, 0, 0, 0]));
    this.callbacks.sendBytes(encodeSubpacket32(meta, ZCRCW));
    this.mode = 'ul-wait-zrpos';
    this.pump();
  }

  private sendCurrentUploadFile(offset: number) {
    const file = this.ulFiles[this.ulIndex];
    if (!file) return;
    const chunkSize = 4096;
    let pos = Math.min(offset, file.data.length);
    this.callbacks.sendBytes(buildZbin32Header(ZDATA, uint32ToFlags(pos)));
    while (pos < file.data.length) {
      const end = Math.min(pos + chunkSize, file.data.length);
      const isLast = end >= file.data.length;
      const slice = file.data.subarray(pos, end);
      this.callbacks.sendBytes(encodeSubpacket32(slice, isLast ? ZCRCE : ZCRCG));
      pos = end;
      this.callbacks.onProgress({
        protocol: 'lrzsz',
        direction: 'upload',
        fileName: file.name,
        transferred: pos,
        total: file.data.length,
        fileIndex: this.ulIndex + 1,
        fileCount: this.ulFiles.length,
        status: 'active',
      });
    }
    if (file.data.length === 0) {
      this.callbacks.sendBytes(encodeSubpacket32(new Uint8Array(0), ZCRCE));
    }
    this.callbacks.sendBytes(buildZhexHeader(ZEOF, uint32ToFlags(file.data.length)));
    this.mode = 'ul-wait-zrinit';
  }

  private finishUpload() {
    this.callbacks.sendBytes(new Uint8Array([0x4f, 0x4f])); // "OO"
    this.callbacks.onProgress({
      protocol: 'lrzsz',
      direction: 'upload',
      fileName: this.ulFiles[this.ulFiles.length - 1]?.name ?? '',
      transferred: 1,
      total: 1,
      fileIndex: this.ulFiles.length,
      fileCount: this.ulFiles.length,
      status: 'done',
      message: 'lrzsz 上传完成',
    });
    this.mode = 'idle';
    this.buffer = new Uint8Array(0);
    setTimeout(() => this.callbacks.onProgress(null), 1800);
  }
}
