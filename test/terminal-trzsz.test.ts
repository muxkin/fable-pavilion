import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { TrzszFilter } from '../src/web/terminal/trzsz';
import { bytesToBase64 } from '../src/web/terminal/shell-escape';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeStr(value: string): string {
  return bytesToBase64(zlibSync(encoder.encode(value)));
}

describe('trzsz filter (Linux/macOS + Windows ConPTY)', () => {
  it('completes tsz download in Windows ConPTY mode and preserves preceding text', () => {
    const sent: string[] = [];
    const downloaded: { name: string; data: Uint8Array }[] = [];
    const filter = new TrzszFilter({
      sendBytes: (bytes) => sent.push(decoder.decode(bytes)),
      onProgress: () => {},
      onDownloadFile: (name, data) => downloaded.push({ name, data }),
      onRequestUploadFiles: async () => [],
    });

    // Windows ConPTY trigger ends with 10.
    const prefix = filter.process(encoder.encode('PS C:\\> ::TRZSZ:TRANSFER:D:1.1.7:1234510\n'));
    expect(decoder.decode(prefix)).toBe('PS C:\\> ');
    expect(filter.active).toBe(true);
    expect(sent[0]).toMatch(/^#ACT:.*\r$/);

    const content = encoder.encode('windows trzsz payload');
    filter.process(encoder.encode(`#CFG:${encodeStr('{}')}\n`));
    filter.process(encoder.encode('#NUM:1\n'));
    filter.process(encoder.encode(`#NAME:${encodeStr('report.txt')}\n`));
    filter.process(encoder.encode(`#SIZE:${content.length}\n`));
    filter.process(encoder.encode(`#DATA:${bytesToBase64(zlibSync(content))}\n`));
    filter.process(encoder.encode(`#MD5:${encodeStr('abc')}\n`));
    filter.process(encoder.encode(`#FIN:${encodeStr('Saved')}\n`));

    expect(downloaded).toHaveLength(1);
    expect(downloaded[0].name).toBe('report.txt');
    expect(decoder.decode(downloaded[0].data)).toBe('windows trzsz payload');
    expect(filter.active).toBe(false);
  });

  it('completes trz upload handshake and sends chunks', async () => {
    const sent: string[] = [];
    const payload = encoder.encode('hello trz');
    const fakeFile = {
      name: 'demo.bin',
      arrayBuffer: async () => payload.buffer.slice(0),
    } as File;

    const filter = new TrzszFilter({
      sendBytes: (bytes) => sent.push(decoder.decode(bytes)),
      onProgress: () => {},
      onDownloadFile: () => {},
      onRequestUploadFiles: async () => [fakeFile],
    });

    filter.process(encoder.encode('::TRZSZ:TRANSFER:R:1.1.7:99900\n'));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0]).toMatch(/^#ACT:.*\n$/);

    filter.process(encoder.encode(`#CFG:${encodeStr('{}')}\n`));
    filter.process(encoder.encode('#SUCC:1\n')); // ack NUM
    filter.process(encoder.encode('#SUCC:name\n')); // ack NAME
    filter.process(encoder.encode('#SUCC:size\n')); // ack SIZE -> triggers DATA
    filter.process(encoder.encode('#SUCC:9\n')); // ack DATA -> triggers MD5
    filter.process(encoder.encode('#SUCC:md5\n')); // ack MD5 -> triggers FIN
    filter.process(encoder.encode('#SUCC:fin\n')); // ack FIN -> done

    expect(filter.active).toBe(false);
    expect(sent.some((line) => line.startsWith('#DATA:'))).toBe(true);
    expect(sent.some((line) => line.startsWith('#FIN:'))).toBe(true);
  });
});
