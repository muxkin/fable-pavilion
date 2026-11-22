import { unzlibSync, zlibSync } from 'fflate';
import { base64ToBytes, bytesToBase64, concatBytes } from './shell-escape';
import type { TerminalTransferProgress } from './zmodem';

export interface TrzszCallbacks {
  sendBytes: (bytes: Uint8Array) => void;
  onProgress: (progress: TerminalTransferProgress | null) => void;
  onDownloadFile: (name: string, data: Uint8Array) => void;
  onRequestUploadFiles: () => Promise<File[]>;
}

const TRIGGER_REGEX = /::TRZSZ:TRANSFER:([DRSU]):(\d+\.\d+\.\d+)(?::(\d+))?/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

function encodeTrzszStr(value: string): string {
  return bytesToBase64(zlibSync(encoder.encode(value)));
}

function decodeTrzszStr(encoded: string): string {
  const bytes = base64ToBytes(encoded);
  try {
    return decoder.decode(unzlibSync(bytes));
  } catch {
    return decoder.decode(bytes);
  }
}

function decodeTrzszData(encoded: string): Uint8Array {
  const bytes = base64ToBytes(encoded);
  try {
    return unzlibSync(bytes);
  } catch {
    return bytes;
  }
}

function encodeTrzszData(data: Uint8Array): string {
  return bytesToBase64(zlibSync(data));
}

function formatLine(type: string, value: string, newline = '\n'): Uint8Array {
  return encoder.encode(`#${type}:${value}${newline}`);
}

/**
 * Pure TypeScript trzsz (`trz` / `tsz`) client supporting Linux, macOS, and Windows ConPTY.
 * Always negotiates base64-encoded ASCII mode (`binary: false`) so frames pass through
 * Windows ConPTY, tmux, and UTF-8 pipelines with zero control-byte corruption.
 */
export class TrzszFilter {
  private mode: 'idle' | 'download' | 'upload' = 'idle';
  private lineBuffer = '';
  private newline = '\n';
  private cancelled = false;

  // Download state
  private dlFileCount = 0;
  private dlFileIndex = 0;
  private dlFileName = '';
  private dlFileSize = 0;
  private dlChunks: Uint8Array[] = [];
  private dlReceived = 0;

  // Upload state
  private ulFiles: { name: string; data: Uint8Array }[] = [];
  private ulIndex = 0;
  private ulStep: 'idle' | 'wait-act' | 'wait-cfg' | 'wait-num' | 'wait-name' | 'wait-size' | 'wait-data' | 'wait-md5' | 'wait-fin' = 'idle';
  private ulOffset = 0;

  constructor(private readonly callbacks: TrzszCallbacks) {}

  get active(): boolean {
    return this.mode !== 'idle';
  }

  cancel() {
    if (this.mode === 'idle') return;
    this.cancelled = true;
    this.callbacks.sendBytes(formatLine('FAIL', encodeTrzszStr('Cancelled by user'), this.newline));
    this.callbacks.sendBytes(new Uint8Array([0x03]));
    this.reset('已取消 trzsz 传输');
  }

  private reset(message?: string) {
    const wasActive = this.mode !== 'idle';
    const dir = this.mode === 'upload' ? 'upload' : 'download';
    this.mode = 'idle';
    this.lineBuffer = '';
    this.dlChunks = [];
    this.dlReceived = 0;
    this.dlFileName = '';
    this.dlFileSize = 0;
    this.dlFileCount = 0;
    this.dlFileIndex = 0;
    this.ulFiles = [];
    this.ulIndex = 0;
    this.ulStep = 'idle';
    this.ulOffset = 0;
    if (wasActive && message) {
      this.callbacks.onProgress({
        protocol: 'trzsz',
        direction: dir,
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
    const text = decoder.decode(chunk, { stream: true });

    if (this.mode === 'idle') {
      const match = TRIGGER_REGEX.exec(text);
      if (!match) return chunk;
      const triggerMode = match[1];
      const uniqueId = match[3] || '';
      // Windows ConPTY uses `\r` for line submission in trzsz (`uniqueId` ending with `10` or `20`).
      this.newline = uniqueId.endsWith('10') || uniqueId.endsWith('20') ? '\r' : '\n';
      this.cancelled = false;
      this.lineBuffer = text.slice(match.index + match[0].length);
      if (triggerMode === 'D' || triggerMode === 'S') {
        this.startDownload();
      } else {
        this.startUpload();
      }
      const before = text.slice(0, match.index);
      return before ? encoder.encode(before) : new Uint8Array(0);
    }

    this.lineBuffer += text;
    this.consumeLines();
    return new Uint8Array(0);
  }

  private consumeLines() {
    while (this.mode !== 'idle') {
      const idx = this.lineBuffer.indexOf('\n');
      if (idx < 0) break;
      const rawLine = this.lineBuffer.slice(0, idx).replace(/\r$/, '');
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      const hashIdx = rawLine.indexOf('#');
      if (hashIdx < 0) continue;
      const body = rawLine.slice(hashIdx + 1);
      const colon = body.indexOf(':');
      if (colon <= 0) continue;
      const type = body.slice(0, colon);
      const value = body.slice(colon + 1);
      if (type === 'FAIL' || type === 'fail' || type === 'EXIT') {
        const msg = value ? decodeTrzszStr(value) : 'trzsz 传输已终止';
        this.reset(msg);
        return;
      }
      if (this.mode === 'download') {
        this.handleDownloadMessage(type, value);
      } else {
        this.handleUploadMessage(type, value);
      }
    }
  }

  private startDownload() {
    this.mode = 'download';
    this.dlFileCount = 0;
    this.dlFileIndex = 0;
    this.callbacks.onProgress({
      protocol: 'trzsz',
      direction: 'download',
      fileName: '正在建立 trzsz 下载会话…',
      transferred: 0,
      total: 0,
      fileIndex: 0,
      fileCount: 0,
      status: 'active',
    });
    const act = JSON.stringify({
      lang: 'js',
      version: '1.1.0',
      confirm: true,
      binary: false,
      newline: this.newline,
    });
    this.callbacks.sendBytes(formatLine('ACT', encodeTrzszStr(act), this.newline));
    this.consumeLines();
  }

  private handleDownloadMessage(type: string, value: string) {
    if (type === 'CFG') {
      this.callbacks.sendBytes(formatLine('SUCC', '1', this.newline));
    } else if (type === 'NUM') {
      this.dlFileCount = Number(value) || 1;
      this.callbacks.sendBytes(formatLine('SUCC', String(this.dlFileCount), this.newline));
    } else if (type === 'NAME') {
      this.dlFileName = decodeTrzszStr(value);
      this.dlFileIndex++;
      this.dlChunks = [];
      this.dlReceived = 0;
      this.dlFileSize = 0;
      this.callbacks.onProgress({
        protocol: 'trzsz',
        direction: 'download',
        fileName: this.dlFileName,
        transferred: 0,
        total: 0,
        fileIndex: this.dlFileIndex,
        fileCount: Math.max(this.dlFileCount, this.dlFileIndex),
        status: 'active',
      });
      this.callbacks.sendBytes(formatLine('SUCC', encodeTrzszStr(this.dlFileName), this.newline));
    } else if (type === 'SIZE') {
      this.dlFileSize = Number(value) || 0;
      this.callbacks.onProgress({
        protocol: 'trzsz',
        direction: 'download',
        fileName: this.dlFileName,
        transferred: 0,
        total: this.dlFileSize,
        fileIndex: this.dlFileIndex,
        fileCount: Math.max(this.dlFileCount, this.dlFileIndex),
        status: 'active',
      });
      this.callbacks.sendBytes(formatLine('SUCC', String(this.dlFileSize), this.newline));
    } else if (type === 'DATA') {
      const part = decodeTrzszData(value);
      this.dlChunks.push(part);
      this.dlReceived += part.length;
      this.callbacks.onProgress({
        protocol: 'trzsz',
        direction: 'download',
        fileName: this.dlFileName,
        transferred: this.dlReceived,
        total: Math.max(this.dlFileSize, this.dlReceived),
        fileIndex: this.dlFileIndex,
        fileCount: Math.max(this.dlFileCount, this.dlFileIndex),
        status: 'active',
      });
      this.callbacks.sendBytes(formatLine('SUCC', String(part.length), this.newline));
    } else if (type === 'MD5' || type === 'SHA') {
      const merged = concatBytes(this.dlChunks);
      this.callbacks.onDownloadFile(this.dlFileName || 'download.bin', merged);
      this.dlChunks = [];
      this.callbacks.sendBytes(formatLine('SUCC', value, this.newline));
    } else if (type === 'FIN') {
      this.callbacks.sendBytes(formatLine('SUCC', encodeTrzszStr('Saved'), this.newline));
      this.callbacks.onProgress({
        protocol: 'trzsz',
        direction: 'download',
        fileName: this.dlFileName,
        transferred: this.dlFileSize,
        total: this.dlFileSize,
        fileIndex: this.dlFileIndex,
        fileCount: Math.max(this.dlFileCount, this.dlFileIndex),
        status: 'done',
        message: 'trzsz 下载完成',
      });
      this.mode = 'idle';
      this.lineBuffer = '';
      setTimeout(() => this.callbacks.onProgress(null), 1800);
    }
  }

  private startUpload() {
    this.mode = 'upload';
    this.ulStep = 'wait-act';
    this.callbacks.onProgress({
      protocol: 'trzsz',
      direction: 'upload',
      fileName: '请选择要通过 trzsz 上传的文件…',
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
          const act = JSON.stringify({ lang: 'js', version: '1.1.0', confirm: false });
          this.callbacks.sendBytes(formatLine('ACT', encodeTrzszStr(act), this.newline));
          this.reset('未选择文件，已取消 trz');
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
        const act = JSON.stringify({
          lang: 'js',
          version: '1.1.0',
          confirm: true,
          binary: false,
          newline: this.newline,
        });
        this.ulStep = 'wait-cfg';
        this.callbacks.sendBytes(formatLine('ACT', encodeTrzszStr(act), this.newline));
        this.consumeLines();
      })
      .catch(() => {
        this.cancel();
      });
  }

  private handleUploadMessage(type: string, _value: string) {
    if (this.ulStep === 'wait-cfg' && type === 'CFG') {
      this.callbacks.sendBytes(formatLine('SUCC', '1', this.newline));
      this.ulStep = 'wait-num';
      this.callbacks.sendBytes(formatLine('NUM', String(this.ulFiles.length), this.newline));
      return;
    }
    if (type !== 'SUCC') return;

    if (this.ulStep === 'wait-num') {
      this.sendUploadFileName();
    } else if (this.ulStep === 'wait-name') {
      const file = this.ulFiles[this.ulIndex];
      this.ulStep = 'wait-size';
      this.callbacks.sendBytes(formatLine('SIZE', String(file.data.length), this.newline));
    } else if (this.ulStep === 'wait-size' || this.ulStep === 'wait-data') {
      const file = this.ulFiles[this.ulIndex];
      if (this.ulOffset < file.data.length) {
        const chunkSize = 32 * 1024;
        const end = Math.min(this.ulOffset + chunkSize, file.data.length);
        const slice = file.data.subarray(this.ulOffset, end);
        this.ulOffset = end;
        this.ulStep = 'wait-data';
        this.callbacks.onProgress({
          protocol: 'trzsz',
          direction: 'upload',
          fileName: file.name,
          transferred: this.ulOffset,
          total: file.data.length,
          fileIndex: this.ulIndex + 1,
          fileCount: this.ulFiles.length,
          status: 'active',
        });
        this.callbacks.sendBytes(formatLine('DATA', encodeTrzszData(slice), this.newline));
      } else {
        this.ulStep = 'wait-md5';
        this.callbacks.sendBytes(formatLine('MD5', encodeTrzszStr('ok'), this.newline));
      }
    } else if (this.ulStep === 'wait-md5') {
      this.ulIndex++;
      if (this.ulIndex < this.ulFiles.length) {
        this.sendUploadFileName();
      } else {
        this.ulStep = 'wait-fin';
        this.callbacks.sendBytes(formatLine('FIN', encodeTrzszStr('Done'), this.newline));
      }
    } else if (this.ulStep === 'wait-fin') {
      this.callbacks.onProgress({
        protocol: 'trzsz',
        direction: 'upload',
        fileName: this.ulFiles[this.ulFiles.length - 1]?.name ?? '',
        transferred: 1,
        total: 1,
        fileIndex: this.ulFiles.length,
        fileCount: this.ulFiles.length,
        status: 'done',
        message: 'trzsz 上传完成',
      });
      this.mode = 'idle';
      this.lineBuffer = '';
      setTimeout(() => this.callbacks.onProgress(null), 1800);
    }
  }

  private sendUploadFileName() {
    const file = this.ulFiles[this.ulIndex];
    this.ulOffset = 0;
    this.ulStep = 'wait-name';
    this.callbacks.onProgress({
      protocol: 'trzsz',
      direction: 'upload',
      fileName: file.name,
      transferred: 0,
      total: file.data.length,
      fileIndex: this.ulIndex + 1,
      fileCount: this.ulFiles.length,
      status: 'active',
    });
    this.callbacks.sendBytes(formatLine('NAME', encodeTrzszStr(file.name), this.newline));
  }
}
