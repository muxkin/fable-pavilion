import { expect, it } from 'vitest';
import type { AttachmentResource } from '../src/web/AttachmentAccess';
import { attachmentPreviewContent } from '../src/web/attachment-preview';

function preview(name: string, body: BlobPart, mime = 'application/octet-stream') {
  const blob = new Blob([body], { type: mime });
  const file: AttachmentResource = { url: 'blob:fixture', name, mime, size: blob.size, blob, expiresAt: 0 };
  return attachmentPreviewContent(file, '/workspace/' + name, new AbortController().signal);
}

it.each([
  ['轧板端面15点.lay', 'page = canvas(size=(10 mm, 20 mm))', 'laymesh'],
  ['多页.laydoc', 'page = canvas(size=(10 mm, 20 mm))', 'laymesh'],
  ['style.lcss', '.panel { fill: #ffffff; }', 'lcss'],
  ['index.ts', 'export const x: number = 1;', 'typescript'],
  ['Dockerfile.dev', 'FROM alpine\nRUN echo 1', 'dockerfile'],
  ['入口脚本', '#!/usr/bin/env python3\nprint("你")', 'python'],
  ['payload.unknown', '{"value": "说明"}', 'json'],
  ['draw.unknown', '<?xml version="1.0"?><draw />', 'xml'],
  ['unsafe.html', '<html><script>window.bad = true</script></html>', 'html'],
])('identifies source files by name and content for %s', async (name, text, language) => {
  expect(await preview(name, text)).toMatchObject({
    kind: 'text',
    text,
    truncated: false,
    syntax: { language },
  });
});

it('reads UTF-8 and BOM-marked UTF-16 text with generic filenames and MIME', async () => {
  const text = '一份自定义格式的说明 ✨\n第二行';
  expect(await preview('说明.data', text)).toMatchObject({ kind: 'text', text });
  const encoded = Uint8Array.from(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  expect(await preview('说明', encoded)).toMatchObject({ kind: 'text', text });
});

it('leaves unknown binary, misnamed source and supported media in the right viewers', async () => {
  const binary = Uint8Array.of(0x50, 0x4b, 3, 4, 0, 0xf4, 0xfe);
  expect(await preview('report.custom', binary)).toMatchObject({ kind: 'unsupported' });
  expect(await preview('report.lay', binary)).toMatchObject({ kind: 'unsupported' });
  expect(await preview('report.docx', binary)).toMatchObject({ kind: 'unsupported' });
  expect(await preview('report.pdf', '%PDF-1.4', 'application/pdf')).toEqual({ kind: 'pdf' });
  expect(await preview('hidden-file.bin', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10))).toEqual({
    kind: 'image',
  });
});

it('keeps CSV rows and clips large text at a complete character', async () => {
  expect(await preview('data.csv', '名,值\n"一,二",2')).toMatchObject({
    kind: 'text',
    table: {
      rows: [
        ['名', '值'],
        ['一,二', '2'],
      ],
      clipped: false,
    },
  });
  const prefix = 'a'.repeat(256 * 1024 - 1);
  expect(await preview('note.unknown', prefix + '😀剩余内容')).toMatchObject({
    kind: 'text',
    text: prefix,
    truncated: true,
  });
});
