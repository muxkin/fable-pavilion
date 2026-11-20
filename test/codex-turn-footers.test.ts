import { expect, it } from 'vitest';
import type { Message } from '../src/shared/types';
import { codexTurnFooters } from '../src/web/codex-turn-footers';

function row(id: string, role: Message['role'], turnId?: string, fields?: Partial<Message>): Message {
  return { id, text: id, role, turnId, ...fields };
}

it('anchors one completed footer after trailing tools and agent notices in the same turn', () => {
  const reply = row('answer', 'assistant', 'one', { phase: 'final_answer', turnBoundary: true });
  const rows = [
    row('question', 'user', 'one'),
    row('progress', 'assistant', 'one', { phase: 'commentary' }),
    reply,
    row('tool', 'tool', 'one'),
    row('subagent', 'tool', 'one', {
      codex: { kind: 'subagent', state: 'completed', agentId: 'qa', name: 'QA' },
    }),
    row('next', 'user', 'two'),
    row('unconfirmed', 'assistant', 'two', { phase: 'final_answer' }),
  ];
  expect([...codexTurnFooters(rows, 'two')]).toEqual([[4, reply]]);
  expect([...codexTurnFooters(rows)]).toEqual([
    [4, reply],
    [6, rows[6]],
  ]);
});

it('copies the last old reply at its visible end and ignores commentary-only turns', () => {
  const reply = row('answer', 'assistant');
  const rows = [
    row('prompt', 'user'),
    row('progress', 'assistant'),
    reply,
    row('tool', 'tool'),
    row('next', 'user'),
    row('commentary', 'assistant', undefined, { phase: 'commentary' }),
  ];
  expect([...codexTurnFooters(rows)]).toEqual([[3, reply]]);
  expect([...codexTurnFooters(rows, 'unknown-turn')]).toEqual([[3, reply]]);
});

it('never extends a reply beyond a different turn or past steering in the same turn', () => {
  const reply = row('answer', 'assistant', 'one', { phase: 'final_answer' });
  const rows = [
    reply,
    row('other-tool', 'tool', 'two'),
    row('old-reply', 'assistant', 'two'),
    row('steer', 'user', 'two'),
    row('reply-after-steer', 'assistant', 'two'),
  ];
  expect([...codexTurnFooters(rows)]).toEqual([
    [0, reply],
    [4, rows[4]],
  ]);
});
