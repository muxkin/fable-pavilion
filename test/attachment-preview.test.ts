import { gzipSync, zipSync } from 'fflate';
import { expect, it } from 'vitest';
import type { AttachmentResource } from '../src/web/AttachmentAccess';
import { attachmentPreviewContent } from '../src/web/attachment-preview';
import { resolveArchiveRelativePath } from '../src/web/preview/archive';

const encode = (text: string) => new TextEncoder().encode(text);
const TINY_PNG = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
);

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
])('identifies source files by name and content for %s', async (name, text, language) => {
  expect(await preview(name, text)).toMatchObject({
    kind: 'text',
    text,
    truncated: false,
    syntax: { language },
  });
});

it('dispatches Markdown, SVG, HTML, and structured JSON/YAML/TOML to dedicated viewers', async () => {
  expect(await preview('report.md', '# 标题\n\n![图](./fig.png)')).toEqual({
    kind: 'markdown',
    text: '# 标题\n\n![图](./fig.png)',
    truncated: false,
  });
  expect(await preview('diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toEqual({
    kind: 'svg',
    text: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    truncated: false,
  });
  expect(await preview('unsafe.html', '<html><script>window.bad = true</script></html>')).toEqual({
    kind: 'html',
    text: '<html><script>window.bad = true</script></html>',
    truncated: false,
  });
  expect(await preview('config.yaml', 'app:\n  name: demo\n  port: 8080\n')).toMatchObject({
    kind: 'text',
    structured: {
      format: 'yaml',
      value: { app: { name: 'demo', port: 8080 } },
    },
  });
  expect(await preview('settings.toml', 'title = "demo"\n[net]\nport = 8080\n')).toMatchObject({
    kind: 'text',
    structured: {
      format: 'toml',
      value: { title: 'demo', net: { port: 8080 } },
    },
  });
  expect(await preview('records.jsonl', '{"a":1}\n{"a":2}\n')).toMatchObject({
    kind: 'text',
    structured: {
      format: 'jsonl',
      value: [{ a: 1 }, { a: 2 }],
    },
  });
});

it('parses Jupyter notebooks with markdown cells, code cells, and image/stream outputs', async () => {
  const nb = JSON.stringify({
    nbformat: 4,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# 实验记录\n', '结论如下'] },
      {
        cell_type: 'code',
        execution_count: 3,
        source: ['print("ok")'],
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['\x1b[32mok\x1b[0m\n'] },
          { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo=' } },
        ],
      },
    ],
  });
  const result = await preview('analysis.ipynb', nb);
  expect(result.kind).toBe('notebook');
  if (result.kind === 'notebook') {
    expect(result.notebook.language).toBe('python');
    expect(result.notebook.cells).toHaveLength(2);
    expect(result.notebook.cells[1].outputs[0]).toMatchObject({ kind: 'text', text: 'ok\n' });
    expect(result.notebook.cells[1].outputs[1]).toMatchObject({
      kind: 'image',
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    });
  }
});

it('parses ZIP and GZIP archives and resolves nested relative paths', async () => {
  const zipBytes = zipSync({
    'docs/README.md': encode('# Hello\n![img](../imgs/pic.png)'),
    'imgs/pic.png': TINY_PNG,
  });
  const zipResult = await preview('bundle.zip', zipBytes as Uint8Array<ArrayBuffer>, 'application/zip');
  expect(zipResult.kind).toBe('archive');
  if (zipResult.kind === 'archive') {
    expect(zipResult.archive.entries.map((e) => e.path)).toEqual(['docs/README.md', 'imgs/pic.png']);
    const rel = resolveArchiveRelativePath('docs/README.md', '../imgs/pic.png');
    expect(rel).toBe('imgs/pic.png');
    expect(zipResult.archive.readEntry(rel)).toEqual(TINY_PNG);
  }

  const gzBytes = gzipSync(encode('line1\nline2'));
  const gzResult = await preview('app.log.gz', gzBytes as Uint8Array<ArrayBuffer>, 'application/gzip');
  expect(gzResult.kind).toBe('archive');
  if (gzResult.kind === 'archive') {
    expect(gzResult.archive.format).toBe('gzip');
    expect(gzResult.archive.entries[0].name).toBe('app.log');
  }
});

it('parses valid XLSX, PPTX, and DOCX packages and rejects malformed ones', async () => {
  const xlsxBytes = zipSync({
    'xl/workbook.xml': encode(
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': encode(
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/sharedStrings.xml': encode('<sst><si><t>名称</t></si><si><t>样本A</t></si></sst>'),
    'xl/worksheets/sheet1.xml': encode(
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>数值</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42.5</v></c></row></sheetData></worksheet>',
    ),
  });
  const xlsxResult = await preview('metrics.xlsx', xlsxBytes as Uint8Array<ArrayBuffer>);
  expect(xlsxResult.kind).toBe('xlsx');
  if (xlsxResult.kind === 'xlsx') {
    expect(xlsxResult.workbook.sheets[0]).toMatchObject({
      name: '数据',
      rows: [
        ['名称', '数值'],
        ['样本A', '42.5'],
      ],
    });
  }

  const pptxBytes = zipSync({
    'ppt/presentation.xml': encode(
      '<presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sldIdLst><sldId id="256" r:id="rId1"/></sldIdLst></presentation>',
    ),
    'ppt/_rels/presentation.xml.rels': encode(
      '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
    ),
    'ppt/slides/slide1.xml': encode(
      '<sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><cSld><spTree><sp><txBody><a:p><a:r><a:t>项目汇报</a:t></a:r></a:p><a:p><a:r><a:t>核心进展</a:t></a:r></a:p></txBody></sp><pic><blipFill><a:blip r:embed="rIdImg"/></blipFill></pic></spTree></cSld></sld>',
    ),
    'ppt/slides/_rels/slide1.xml.rels': encode(
      '<Relationships><Relationship Id="rIdImg" Target="../media/chart.png"/></Relationships>',
    ),
    'ppt/media/chart.png': TINY_PNG,
  });
  const pptxResult = await preview('deck.pptx', pptxBytes as Uint8Array<ArrayBuffer>);
  expect(pptxResult.kind).toBe('pptx');
  if (pptxResult.kind === 'pptx') {
    expect(pptxResult.presentation.slides[0]).toMatchObject({
      index: 1,
      title: '项目汇报',
      paragraphs: ['核心进展'],
    });
    expect(pptxResult.presentation.slides[0].images[0].mime).toBe('image/png');
  }

  const docxBytes = zipSync({
    'word/document.xml': encode('<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>'),
  });
  expect(await preview('doc.docx', docxBytes as Uint8Array<ArrayBuffer>)).toMatchObject({ kind: 'docx' });
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
  const pdfResult = await preview('report.pdf', '%PDF-1.4', 'application/pdf');
  expect(pdfResult.kind).toBe('pdf');
  if (pdfResult.kind === 'pdf') expect(pdfResult.bytes?.byteLength).toBe(8);
  expect(await preview('hidden-file.bin', TINY_PNG)).toEqual({
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
