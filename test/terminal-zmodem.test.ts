import { describe, expect, it } from 'vitest';
import {
  buildZbin32Header,
  buildZhexHeader,
  crc16Xmodem,
  crc32Zmodem,
  encodeZdle,
  ZmodemFilter,
} from '../src/web/terminal/zmodem';
import { concatBytes } from '../src/web/terminal/shell-escape';

const encoder = new TextEncoder();

function makeSubpacket32(payload: Uint8Array, frameEnd: number): Uint8Array {
  let crc = crc32Zmodem(payload);
  crc = crc32Zmodem(new Uint8Array([frameEnd]), crc);
  crc = (~crc) >>> 0;
  const crcBytes = new Uint8Array([
    crc & 0xff,
    (crc >>> 8) & 0xff,
    (crc >>> 16) & 0xff,
    (crc >>> 24) & 0xff,
  ]);
  return concatBytes([encodeZdle(payload), new Uint8Array([0x18, frameEnd]), encodeZdle(crcBytes)]);
}

describe('ZMODEM (lrzsz) filter', () => {
  it('computes XMODEM CRC-16 and escapes control bytes via ZDLE', () => {
    expect(crc16Xmodem(encoder.encode('123456789'))).toBe(0x31c3);
    const escaped = encodeZdle(new Uint8Array([0x18, 0x11, 0x41]));
    expect(Array.from(escaped)).toEqual([0x18, 0x58, 0x18, 0x51, 0x41]);
  });

  it('handles full sz download session from ZRQINIT to ZFIN', () => {
    const sent: Uint8Array[] = [];
    const downloaded: { name: string; data: Uint8Array }[] = [];
    const filter = new ZmodemFilter({
      sendBytes: (b) => sent.push(b),
      onProgress: () => {},
      onDownloadFile: (name, data) => downloaded.push({ name, data }),
      onRequestUploadFiles: async () => [],
    });

    // Normal text passes through untouched before ZRQINIT.
    const pre = filter.process(encoder.encode('normal output\r\n'));
    expect(new TextDecoder().decode(pre)).toBe('normal output\r\n');
    expect(filter.active).toBe(false);

    // Host initiates sz with ZRQINIT.
    const zrqinit = buildZhexHeader(0);
    const afterTrigger = filter.process(concatBytes([encoder.encode('ready:'), zrqinit]));
    expect(new TextDecoder().decode(afterTrigger)).toBe('ready:');
    expect(filter.active).toBe(true);
    expect(sent.length).toBeGreaterThan(0);

    // Host sends ZFILE + metadata subpacket ("hello.txt\011").
    const payload = encoder.encode('hello world');
    const zfile = concatBytes([
      buildZbin32Header(4),
      makeSubpacket32(encoder.encode(`hello.txt\0${payload.length} 0 100644\0`), 0x6b),
    ]);
    filter.process(zfile);

    // Host sends ZDATA + data subpacket (ZCRCE = 0x68) + ZEOF + ZFIN.
    const zdata = concatBytes([
      buildZbin32Header(10),
      makeSubpacket32(payload, 0x68),
      buildZhexHeader(11, [payload.length, 0, 0, 0]),
      buildZhexHeader(8),
    ]);
    filter.process(zdata);

    expect(downloaded).toHaveLength(1);
    expect(downloaded[0].name).toBe('hello.txt');
    expect(new TextDecoder().decode(downloaded[0].data)).toBe('hello world');
    expect(filter.active).toBe(false);
  });

  it('handles full rz upload session from ZRINIT to ZFIN', async () => {
    const sent: Uint8Array[] = [];
    const fileContent = encoder.encode('uploaded via rz');
    const fakeFile = {
      name: 'note.txt',
      arrayBuffer: async () => fileContent.buffer.slice(0),
    } as File;

    const filter = new ZmodemFilter({
      sendBytes: (b) => sent.push(b),
      onProgress: () => {},
      onDownloadFile: () => {},
      onRequestUploadFiles: async () => [fakeFile],
    });

    // Host initiates rz with ZRINIT (**\x18B01...).
    filter.process(buildZhexHeader(1, [0, 0, 0, 0x23]));
    expect(filter.active).toBe(true);

    // Wait for async file picker promise to flush ZFILE.
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.length).toBeGreaterThan(0);

    // Host responds ZRPOS(0), then ZRINIT after ZEOF, then ZFIN.
    filter.process(buildZhexHeader(9, [0, 0, 0, 0]));
    filter.process(buildZhexHeader(1, [0, 0, 0, 0x23]));
    filter.process(buildZhexHeader(8));

    expect(filter.active).toBe(false);
    const mergedSent = concatBytes(sent);
    expect(new TextDecoder().decode(mergedSent)).toContain('note.txt');
    expect(new TextDecoder().decode(mergedSent)).toContain('OO');
  });
});
