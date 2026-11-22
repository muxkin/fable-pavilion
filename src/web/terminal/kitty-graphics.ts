import { unzlibSync, zlibSync } from 'fflate';
import { base64ToBytes, bytesToBase64, concatBytes } from './shell-escape';

export interface TerminalCapturedImage {
  id: string;
  protocol: 'kitty' | 'iterm2' | 'sixel';
  mime: string;
  dataUrl: string;
  name?: string;
  timestamp: number;
}

export interface TerminalSequenceCallbacks {
  sendReply: (bytes: Uint8Array) => void;
  onImage?: (image: TerminalCapturedImage) => void;
  onClipboardWrite?: (text: string) => void;
  onCwdChange?: (cwd: string) => void;
  onShellPromptMark?: (mark: string) => void;
}

const MAX_SEQUENCE_BYTES = 24 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

/** Encode raw RGB (24-bit) or RGBA (32-bit) pixels into a valid PNG byte buffer. */
export function encodeRawToPng(pixels: Uint8Array, width: number, height: number, channels: 3 | 4): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    const srcOffset = y * stride;
    raw.set(pixels.subarray(srcOffset, srcOffset + stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // RGBA or RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return concatBytes([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

interface PendingKittyTransfer {
  params: Record<string, string>;
  chunks: string[];
}

/**
 * Intercepts Kitty Graphics Protocol (APC G), OSC 52 clipboard, OSC 7 CWD,
 * OSC 133 shell marks, and indexes OSC 1337 iTerm2 inline images while
 * passing normal terminal output (and Sixel/iTerm2 sequences) through to xterm.
 */
export class TerminalSequenceFilter {
  private pending = new Uint8Array(0);
  private kittyTransfer: PendingKittyTransfer | null = null;
  private imageSeq = 0;

  constructor(private readonly callbacks: TerminalSequenceCallbacks) {}

  reset() {
    this.pending = new Uint8Array(0);
    this.kittyTransfer = null;
  }

  process(chunk: Uint8Array): Uint8Array {
    if (!chunk.length) return chunk;
    const data = this.pending.length ? concatBytes([this.pending, chunk]) : chunk;
    this.pending = new Uint8Array(0);

    const out: Uint8Array[] = [];
    let i = 0;
    let passthroughStart = 0;

    const flushPassthrough = (end: number) => {
      if (end > passthroughStart) out.push(data.subarray(passthroughStart, end));
    };

    while (i < data.length) {
      if (data[i] !== 0x1b) {
        i++;
        continue;
      }
      if (i + 1 >= data.length) {
        flushPassthrough(i);
        this.pending = data.slice(i);
        return concatBytes(out);
      }
      const next = data[i + 1];
      // Kitty Graphics APC: ESC _ G ... ESC \
      if (next === 0x5f) {
        if (i + 2 >= data.length) {
          flushPassthrough(i);
          this.pending = data.slice(i);
          return concatBytes(out);
        }
        if (data[i + 2] === 0x47) {
          const end = findSt(data, i + 3);
          if (end < 0) {
            if (data.length - i > MAX_SEQUENCE_BYTES) {
              i += 3;
              continue;
            }
            flushPassthrough(i);
            this.pending = data.slice(i);
            return concatBytes(out);
          }
          flushPassthrough(i);
          const body = decoder.decode(data.subarray(i + 3, end));
          const translated = this.handleKittyApc(body);
          if (translated) out.push(translated);
          i = end + 2;
          passthroughStart = i;
          continue;
        }
      }

      // OSC sequences: ESC ] <code> ; <payload> (BEL | ESC \)
      if (next === 0x5d) {
        const oscEnd = findOscEnd(data, i + 2);
        if (!oscEnd) {
          if (data.length - i > MAX_SEQUENCE_BYTES) {
            i += 2;
            continue;
          }
          flushPassthrough(i);
          this.pending = data.slice(i);
          return concatBytes(out);
        }
        const content = decoder.decode(data.subarray(i + 2, oscEnd.payloadEnd));
        const handled = this.handleOsc(content);
        if (handled === 'consume') {
          flushPassthrough(i);
          i = oscEnd.nextIndex;
          passthroughStart = i;
          continue;
        }
        i = oscEnd.nextIndex;
        continue;
      }

      i++;
    }

    flushPassthrough(data.length);
    return concatBytes(out);
  }

  private handleOsc(content: string): 'consume' | 'passthrough' {
    const semi = content.indexOf(';');
    if (semi < 0) return 'passthrough';
    const code = content.slice(0, semi);
    const body = content.slice(semi + 1);

    if (code === '52') {
      const sep = body.indexOf(';');
      if (sep >= 0) {
        const payload = body.slice(sep + 1);
        if (payload && payload !== '?') {
          try {
            const text = decoder.decode(base64ToBytes(payload));
            this.callbacks.onClipboardWrite?.(text);
          } catch {
            /* Ignore malformed base64 clipboard payload. */
          }
        }
      }
      return 'consume';
    }

    if (code === '7') {
      const cwd = parseOsc7Cwd(body);
      if (cwd) this.callbacks.onCwdChange?.(cwd);
      return 'consume';
    }

    if (code === '133') {
      this.callbacks.onShellPromptMark?.(body);
      return 'passthrough';
    }

    if (code === '1337' && body.startsWith('File=')) {
      const colon = body.indexOf(':');
      if (colon > 5) {
        const meta = body.slice(5, colon);
        const base64 = body.slice(colon + 1).replace(/\s+/g, '');
        if (base64.length > 0 && base64.length <= MAX_SEQUENCE_BYTES) {
          const nameMatch = /(?:^|;)name=([^;]+)/.exec(meta);
          let name: string | undefined;
          if (nameMatch) {
            try {
              name = decoder.decode(base64ToBytes(nameMatch[1]));
            } catch {
              name = undefined;
            }
          }
          const mime = guessImageMimeFromBase64(base64);
          this.callbacks.onImage?.({
            id: `img-${++this.imageSeq}`,
            protocol: 'iterm2',
            mime,
            dataUrl: `data:${mime};base64,${base64}`,
            name,
            timestamp: Date.now(),
          });
        }
      }
      // Pass through so @xterm/addon-image renders it inline on the canvas!
      return 'passthrough';
    }

    return 'passthrough';
  }

  private handleKittyApc(body: string): Uint8Array | null {
    const semi = body.indexOf(';');
    const controlPart = semi >= 0 ? body.slice(0, semi) : body;
    const payload = semi >= 0 ? body.slice(semi + 1) : '';
    const params: Record<string, string> = {};
    for (const pair of controlPart.split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) params[pair.slice(0, eq)] = pair.slice(eq + 1);
    }

    const action = params.a || (this.kittyTransfer ? 't' : 'T');
    const id = params.i || this.kittyTransfer?.params.i;
    const quiet = params.q || this.kittyTransfer?.params.q || '0';

    if (action === 'q') {
      if (quiet !== '2') {
        const ack = id ? `\x1b_Gi=${id};OK\x1b\\` : `\x1b_G;OK\x1b\\`;
        this.callbacks.sendReply(encoder.encode(ack));
      }
      return null;
    }

    if (action === 'd') {
      // Delete graphics command — nothing to inject into xterm.
      return null;
    }

    const more = params.m === '1';
    if (!this.kittyTransfer) {
      this.kittyTransfer = { params, chunks: payload ? [payload] : [] };
    } else {
      Object.assign(this.kittyTransfer.params, params);
      if (payload) this.kittyTransfer.chunks.push(payload);
    }

    if (more) return null;

    const completed = this.kittyTransfer;
    this.kittyTransfer = null;

    try {
      const fullBase64 = completed.chunks.join('').replace(/\s+/g, '');
      if (!fullBase64) return null;
      let raw = base64ToBytes(fullBase64);
      if (completed.params.o === 'z') {
        raw = unzlibSync(raw);
      }
      const format = Number(completed.params.f || '32');
      let pngBytes: Uint8Array;
      if (format === 100) {
        pngBytes = raw;
      } else if (format === 24 || format === 32) {
        const width = Number(completed.params.s || '0');
        const height = Number(completed.params.v || '0');
        if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return null;
        pngBytes = encodeRawToPng(raw, width, height, format === 24 ? 3 : 4);
      } else {
        return null;
      }

      const pngBase64 = bytesToBase64(pngBytes);
      this.callbacks.onImage?.({
        id: `img-${++this.imageSeq}`,
        protocol: 'kitty',
        mime: 'image/png',
        dataUrl: `data:image/png;base64,${pngBase64}`,
        timestamp: Date.now(),
      });

      if (quiet === '0') {
        const ack = id ? `\x1b_Gi=${id};OK\x1b\\` : `\x1b_G;OK\x1b\\`;
        this.callbacks.sendReply(encoder.encode(ack));
      }

      // Translate into iTerm2 OSC 1337 inline image so @xterm/addon-image renders it inline!
      const cols = completed.params.c ? `;width=${completed.params.c}` : '';
      const rows = completed.params.r ? `;height=${completed.params.r}` : '';
      return encoder.encode(
        `\x1b]1337;File=inline=1;preserveAspectRatio=1${cols}${rows}:${pngBase64}\x07`,
      );
    } catch {
      if (quiet !== '2') {
        const err = id ? `\x1b_Gi=${id};EINVAL:invalid image\x1b\\` : `\x1b_G;EINVAL:invalid image\x1b\\`;
        this.callbacks.sendReply(encoder.encode(err));
      }
      return null;
    }
  }
}

function findSt(data: Uint8Array, from: number): number {
  for (let i = from; i + 1 < data.length; i++) {
    if (data[i] === 0x1b && data[i + 1] === 0x5c) return i;
  }
  return -1;
}

function findOscEnd(
  data: Uint8Array,
  from: number,
): { payloadEnd: number; nextIndex: number } | null {
  for (let i = from; i < data.length; i++) {
    if (data[i] === 0x07) {
      return { payloadEnd: i, nextIndex: i + 1 };
    }
    if (data[i] === 0x1b && i + 1 < data.length && data[i + 1] === 0x5c) {
      return { payloadEnd: i, nextIndex: i + 2 };
    }
  }
  return null;
}

function parseOsc7Cwd(body: string): string | null {
  try {
    const url = new URL(body.trim());
    if (url.protocol !== 'file:') return null;
    let decoded = decodeURIComponent(url.pathname);
    // Windows drive path emitted as file:///C:/Users/...
    if (/^\/[A-Za-z]:\//.test(decoded)) {
      decoded = decoded.slice(1).replace(/\//g, '\\');
    }
    return decoded || null;
  } catch {
    return null;
  }
}

function guessImageMimeFromBase64(b64: string): string {
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('R0lGO')) return 'image/gif';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}
