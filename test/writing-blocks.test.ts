import { describe, expect, it } from 'vitest';
import { splitWritingBlocks } from '../src/web/writing-blocks';

describe('Codex writing blocks', () => {
  it('separates consecutive drafts from surrounding Markdown and preserves source text', () => {
    const body = String.raw`**Formation energy** for Al₈Cu₄Sc.\cite{study}`;
    const source = [
      'Intro paragraph',
      '',
      ':::writing{variant="standard" id="81935" title="Comparison with our previous study"}',
      body,
      '',
      'Second draft paragraph.',
      ':::',
      ':::writing{variant="chat_message" id="01827" title="Follow-up"}',
      'Ready to review.',
      ':::',
      '',
      'Outro',
    ].join('\n');
    const parts = splitWritingBlocks(source);
    expect(parts.map((part) => part.kind)).toEqual(['markdown', 'writing', 'writing', 'markdown']);
    expect(parts[1]).toMatchObject({
      metadata: { title: 'Comparison with our previous study' },
      options: [{ text: body + '\n\nSecond draft paragraph.' }],
    });
    expect(parts[2]).toMatchObject({
      metadata: { title: 'Follow-up' },
      options: [{ text: 'Ready to review.' }],
    });
  });

  it('preserves email metadata and separates labeled tones on CRLF input', () => {
    const source = [
      ':::writing{variant="email" id="01827" subject="A \\"quoted\\" subject" recipient="a@example.com,b@example.com" cc="c@example.com"}',
      '---tone 简明',
      'Direct text',
      '~~~md',
      '---tone fake',
      ':::',
      '~~~',
      '---tone 正式',
      'Formal text',
      ':::',
    ].join('\r\n');
    expect(splitWritingBlocks(source)).toMatchObject([
      {
        kind: 'writing',
        metadata: {
          subject: 'A "quoted" subject',
          recipient: 'a@example.com,b@example.com',
          cc: 'c@example.com',
        },
        options: [
          { label: '简明', text: 'Direct text\n~~~md\n---tone fake\n:::\n~~~' },
          { label: '正式', text: 'Formal text' },
        ],
      },
    ]);
  });

  it.each([
    '```md\n:::writing{variant="standard"}\nExample\n:::\n```',
    '    :::writing{variant="standard"}\n    Example\n    :::',
    '> :::writing{variant="standard"}\n> Example\n> :::',
    ':::writing{variant="standard"}\nStreaming, waiting for the closing fence.',
    ':::writing{variant="standard" title=no-quotes}\nExample\n:::',
    ':::writing{variant="standard"}\n  \n:::',
  ])('leaves code, quotes, and incomplete or malformed writing fences unchanged', (text) => {
    expect(splitWritingBlocks(text)).toEqual([{ kind: 'markdown', text }]);
  });
});
