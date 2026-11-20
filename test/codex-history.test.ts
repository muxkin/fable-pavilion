import { describe, expect, it } from 'vitest';
import { mergeCodexHistory } from '../src/shared/codex-history';
import type { Message } from '../src/shared/types';

const message = (
  id: string,
  role: Message['role'],
  text: string,
  fields: Partial<Message> = {},
): Message => ({ id, role, text, ...fields });

describe('Codex history overlap', () => {
  it('shows an agent-created prompt, commentary and tools once when history overlaps live', () => {
    const turn = { turnId: 'turn-one' };
    const live = [
      message('delegated-one', 'user', 'Build a model.', turn),
      message('native-commentary', 'assistant', 'I will build the model.', { ...turn, phase: 'commentary' }),
      message('native-start', 'tool', '', {
        ...turn,
        codex: { kind: 'subagent', state: 'started', agentId: 'geometry', name: 'Geometry' },
      }),
      message('native-command', 'tool', 'Checking geometry', turn),
    ];
    const history = [
      message('rollout-1', 'assistant', 'I will build the model.', {
        turnId: 'an-earlier-turn',
        nativeItemId: 'earlier-reply',
      }),
      message('rollout-2', 'user', 'Build a model.', { ...turn, nativeItemId: 'delegated-one' }),
      message('rollout-3', 'assistant', 'I will build the model.', {
        ...turn,
        nativeItemId: 'native-commentary',
      }),
      message('rollout-4', 'tool', 'Checking geometry', { ...turn, nativeItemId: 'native-command' }),
    ];
    expect(mergeCodexHistory(history, live)).toEqual([history[0], ...live]);
  });

  it('matches the suffix of legacy history one-to-one while retaining repeated commentary', () => {
    const live = [
      message('native-commentary', 'assistant', 'I will check.'),
      message('native-start', 'tool', '', {
        codex: { kind: 'subagent', state: 'started', agentId: 'geometry', name: 'Geometry' },
      }),
      message('native-command', 'tool', 'Checking geometry'),
      message('another-command', 'tool', 'More checks'),
    ];
    const history = [
      message('rollout-1', 'assistant', 'I will check.'),
      message('rollout-2', 'assistant', 'I will check.'),
      message('rollout-3', 'tool', 'Checking geometry'),
    ];
    expect(mergeCodexHistory(history, live)).toEqual([history[0], ...live]);
    expect(mergeCodexHistory([history[0]], live)).toEqual([history[0], ...live]);
  });

  it('keeps distinct native items and preserves history during a live connection gap', () => {
    const history = [message('rollout-1', 'assistant', 'Same words.', { nativeItemId: 'first' })];
    const live = [message('second', 'assistant', 'Same words.')];
    expect(mergeCodexHistory(history, live)).toEqual([...history, ...live]);
    expect(mergeCodexHistory(history, [])).toEqual(history);
  });
});

describe('Codex transcript order', () => {
  it('keeps paginated images and a saved tail beside their matching live items', () => {
    const live = [
      message('prompt', 'user', 'Draw a model.'),
      message('commentary', 'assistant', 'Drawing.'),
      message('draw', 'tool', 'Rendering'),
      message('revision', 'user', 'Rotate it.'),
      message('answer', 'assistant', 'Updated.'),
      message('next-prompt', 'user', 'Export it.'),
    ];
    const history = [
      message('rollout-10', 'user', 'Draw a model.', { nativeItemId: 'prompt' }),
      message('rollout-20', 'assistant', 'Drawing.', { nativeItemId: 'commentary' }),
      message('rollout-30', 'tool', 'Rendering', { nativeItemId: 'draw' }),
      message('rollout-40:media:0', 'assistant', '', {
        attachments: [{ name: 'model.png', path: '/model.png', media: 'image' }],
      }),
      message('rollout-50', 'user', 'Rotate it.', { nativeItemId: 'revision' }),
      message('rollout-60', 'assistant', 'Updated.', { nativeItemId: 'answer' }),
      message('rollout-70', 'assistant', 'The file is saved.'),
    ];
    expect(mergeCodexHistory(history, live)).toEqual([
      ...live.slice(0, 3), history[3], ...live.slice(3, 5), history[6], live[5],
    ]);
  });

  it('pairs provider and desktop steering echoes individually and retains genuine repeated inputs', () => {
    const turn = { turnId: 'one' };
    const steer = 'Make it wider.';
    const live = [
      message('prompt', 'user', 'Draw a model.', turn),
      message('a160e965-8055-43ae-be67-924557b26cea', 'user', steer, turn),
      message('commentary', 'assistant', 'Updating.', turn),
      message('801f878c-c276-43b6-8086-71a72ef76dc8', 'user', steer, turn),
      message('next', 'user', steer, { turnId: 'two' }),
    ];
    const history = [
      message('rollout-10', 'user', steer, { turnId: 'older', nativeItemId: 'msg_earlier' }),
      message('rollout-20', 'user', 'Draw a model.', { ...turn, nativeItemId: 'prompt' }),
      message('rollout-30', 'user', steer, { ...turn, nativeItemId: 'msg_first' }),
      message('rollout-40', 'assistant', 'Updating.', { ...turn, nativeItemId: 'commentary' }),
      message('rollout-50', 'user', steer, { ...turn, nativeItemId: 'msg_second' }),
    ];
    expect(mergeCodexHistory(history, live)).toEqual([history[0], ...live]);
  });

  it('retains live tool order when the rollout completes tools in a different order', () => {
    const timing = { id: 'turn:timing', role: 'tool', text: 'Timing' } as const;
    const live = [
      message('prompt', 'user', 'Run checks.'),
      { ...timing, codex: { kind: 'turn-timing', state: 'running', startedAt: 1 } } as const,
      message('tool-first', 'tool', 'First check'),
      message('tool-second', 'tool', 'Second check'),
      message('reply', 'assistant', 'Done.'),
    ];
    const history = [
      message('rollout-10', 'user', 'Run checks.', { nativeItemId: 'prompt' }),
      message('rollout-20', 'tool', 'Second check', { nativeItemId: 'tool-second' }),
      message('rollout-30', 'tool', 'First check', { nativeItemId: 'tool-first' }),
      message('rollout-40', 'assistant', 'A saved result.'),
      message('rollout-50', 'assistant', 'Done.', { nativeItemId: 'reply' }),
      { ...timing, codex: { kind: 'turn-timing', state: 'completed', durationMs: 1 } } as const,
    ];
    expect(mergeCodexHistory(history, live)).toEqual([
      ...live.slice(0, 4), history[3], live[4],
    ]);
  });
});

it('keeps verified saved reply boundary and operations when an overlapping live view omits them', () => {
  const history = [
    message('rollout-13', 'assistant', 'Final.', {
      turnId: 'one', nativeItemId: 'final', phase: 'final_answer', turnBoundary: true,
    }),
    message('rollout-14', 'tool', 'Command', { turnId: 'one', nativeItemId: 'tool', toolActions: ['read-file'] }),
  ];
  const live = [
    message('final', 'assistant', 'Final.', { turnId: 'one', phase: 'final_answer' }),
    message('tool', 'tool', 'Command', { turnId: 'one' }),
  ];
  expect(mergeCodexHistory(history, live)).toEqual([
    { ...live[0], turnBoundary: true },
    { ...live[1], toolActions: ['read-file'] },
  ]);
  expect(mergeCodexHistory(history, [{ ...live[0], phase: 'commentary' }, live[1]])[0].turnBoundary).toBeUndefined();
});
