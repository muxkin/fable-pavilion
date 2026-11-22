import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import {
  encodeRawToPng,
  TerminalSequenceFilter,
  type TerminalCapturedImage,
} from '../src/web/terminal/kitty-graphics';
import { bytesToBase64 } from '../src/web/terminal/shell-escape';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('Terminal graphics (Kitty / iTerm2) and OSC 52 / OSC 7 filter', () => {
  it('answers Kitty graphics query (a=q) with OK', () => {
    const replies: string[] = [];
    const filter = new TerminalSequenceFilter({
      sendReply: (bytes) => replies.push(decoder.decode(bytes)),
    });
    const out = filter.process(encoder.encode('before\x1b_Gi=42,a=q,s=1,v=1,t=d;AAAA\x1b\\after'));
    expect(decoder.decode(out)).toBe('beforeafter');
    expect(replies).toEqual(['\x1b_Gi=42;OK\x1b\\']);
  });

  it('decodes chunked zlib RGBA Kitty graphics into PNG and emits OSC 1337 inline image', () => {
    const replies: string[] = [];
    const images: TerminalCapturedImage[] = [];
    const filter = new TerminalSequenceFilter({
      sendReply: (bytes) => replies.push(decoder.decode(bytes)),
      onImage: (img) => images.push(img),
    });

    // 2x1 RGBA red + green pixels, zlib compressed, split across two chunks.
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const b64 = bytesToBase64(zlibSync(rgba));
    const mid = Math.floor(b64.length / 2);
    const out1 = filter.process(
      encoder.encode(`\x1b_Ga=T,i=7,f=32,s=2,v=1,o=z,m=1;${b64.slice(0, mid)}\x1b\\`),
    );
    expect(out1.length).toBe(0);
    const out2 = filter.process(encoder.encode(`\x1b_Gm=0;${b64.slice(mid)}\x1b\\`));
    const emitted = decoder.decode(out2);
    expect(emitted).toContain('\x1b]1337;File=inline=1;preserveAspectRatio=1:');
    expect(images).toHaveLength(1);
    expect(images[0].protocol).toBe('kitty');
    expect(images[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(replies).toEqual(['\x1b_Gi=7;OK\x1b\\']);
  });

  it('encodes raw RGB to a valid PNG header', () => {
    const png = encodeRawToPng(new Uint8Array([10, 20, 30]), 1, 1, 3);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('extracts OSC 52 clipboard and OSC 7 CWD for both POSIX and Windows paths', () => {
    const clip: string[] = [];
    const cwds: string[] = [];
    const filter = new TerminalSequenceFilter({
      sendReply: () => {},
      onClipboardWrite: (text) => clip.push(text),
      onCwdChange: (cwd) => cwds.push(cwd),
    });

    const b64 = bytesToBase64(encoder.encode('copied text'));
    filter.process(
      encoder.encode(
        `\x1b]52;c;${b64}\x07\x1b]7;file://host/home/dev/project\x07\x1b]7;file:///C:/Users/Alice/Code\x1b\\`,
      ),
    );
    expect(clip).toEqual(['copied text']);
    expect(cwds).toEqual(['/home/dev/project', 'C:\\Users\\Alice\\Code']);
  });
});
