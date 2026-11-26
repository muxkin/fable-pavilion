import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  documentDirectory,
  isBareRelativeAssetPath,
  resolveMarkdownAssetPath,
} from '../src/shared/attachments';
import { authorizeFile } from '../src/server/media';
import { renderMarkdown } from '../src/web/markdown';
import type { Message } from '../src/shared/types';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';

const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

it('resolves relative, bare-relative, parent, file://, Windows, and external image paths in Markdown', () => {
  expect(documentDirectory('/workspace/docs/report.md')).toBe('/workspace/docs');
  expect(documentDirectory('file:///workspace/docs/report.md')).toBe('/workspace/docs');
  expect(documentDirectory('C:\\repo\\docs\\report.md')).toBe('C:\\repo\\docs');

  expect(resolveMarkdownAssetPath('./figs/loss.png', '/workspace/docs/report.md')).toBe(
    '/workspace/docs/figs/loss.png',
  );
  expect(resolveMarkdownAssetPath('figs/chart%201.png', '/workspace/docs/report.md')).toBe(
    '/workspace/docs/figs/chart 1.png',
  );
  expect(resolveMarkdownAssetPath('../assets/arch.svg', '/workspace/docs/report.md')).toBe(
    '/workspace/assets/arch.svg',
  );
  expect(resolveMarkdownAssetPath('figs/fig.png', 'C:\\repo\\docs\\report.md')).toBe(
    'C:\\repo\\docs\\figs\\fig.png',
  );
  expect(resolveMarkdownAssetPath('/abs/img.png', '/workspace/docs/report.md')).toBe('/abs/img.png');
  expect(resolveMarkdownAssetPath('file:///abs/img.png', '/workspace/docs/report.md')).toBe(
    'file:///abs/img.png',
  );
  expect(resolveMarkdownAssetPath('https://example.com/a.png', '/workspace/docs/report.md')).toBe(
    'https://example.com/a.png',
  );

  // Bare relative paths inside chat messages (no documentPath) normalize to ./ so localReference matches.
  expect(isBareRelativeAssetPath('plots/result.png')).toBe(true);
  expect(isBareRelativeAssetPath('javascript:alert(1)')).toBe(false);
  expect(resolveMarkdownAssetPath('plots/result.png')).toBe('./plots/result.png');
});

it('authorizes 1-hop local images referenced inside an authorized Markdown document and blocks abuses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'md-media-'));
  const outside = await mkdtemp(join(tmpdir(), 'md-outside-'));
  try {
    const docsDir = join(root, 'docs');
    const figsDir = join(root, 'assets');
    await mkdir(docsDir, { recursive: true });
    await mkdir(figsDir, { recursive: true });

    const validImg = join(figsDir, 'loss.png');
    const unrefImg = join(figsDir, 'unref.png');
    const fakeImg = join(figsDir, 'fake.png');
    const outsideImg = join(outside, 'leak.png');
    await writeFile(validImg, TINY_PNG);
    await writeFile(unrefImg, TINY_PNG);
    await writeFile(fakeImg, 'plain text pretending to be png');
    await writeFile(outsideImg, TINY_PNG);

    const reportPath = join(docsDir, 'report.md');
    await writeFile(
      reportPath,
      [
        '# Analysis',
        '![loss](../assets/loss.png)',
        `<img src="../assets/fake.png" />`,
        `![outside](${outsideImg})`,
      ].join('\n'),
    );

    const messages: Message[] = [
      {
        id: 'm1',
        role: 'assistant',
        text: `结果见 [report.md](${reportPath})`,
      },
    ];

    // Direct request without fromDocument is rejected.
    await expect(authorizeFile(validImg, root, messages)).rejects.toThrow();

    // 1-hop request with authorized report.md succeeds.
    expect(await authorizeFile(validImg, root, messages, reportPath)).toBe(validImg);
    expect(await authorizeFile('../assets/loss.png', root, messages, reportPath)).toBe(validImg);

    // Unreferenced image in same directory is rejected.
    await expect(authorizeFile(unrefImg, root, messages, reportPath)).rejects.toThrow();

    // Non-image content disguised with .png extension is rejected.
    await expect(authorizeFile(fakeImg, root, messages, reportPath)).rejects.toThrow();

    // Image outside workspace/doc root is rejected even if written in report.md.
    await expect(authorizeFile(outsideImg, root, messages, reportPath)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

it('safely maps clean HTML <img> tags in Markdown while escaping unsafe attributes', async () => {
  const render = (src: string) =>
    renderToString(createSSRApp({ render: () => renderMarkdown(src) }));
  const safe = await render('<p align="center"><img src="./figs/loss.png" alt="loss" width="480" /></p>');
  expect(safe).toContain('<img src="./figs/loss.png" alt="loss">');
  const unsafe = await render('<img src="./figs/loss.png" onerror="alert(1)" />');
  expect(unsafe).toContain('&lt;img');
  expect(unsafe).not.toContain('<img');
});
