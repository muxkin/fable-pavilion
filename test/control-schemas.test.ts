import { describe, expect, it } from 'vitest';
import { responseBody } from '../src/server/control-schemas.js';

const target = {
  requestId: '09ce9c86-c98c-4a52-9c77-18bb54d8c770',
  targetRequestId: 'question',
  expectedTurnId: 'turn',
  expectedFingerprint: 'a'.repeat(64),
};

describe('structured question responses', () => {
  it('accepts legacy replies and allows 100 selections only when explicit answer modes are sent', () => {
    const choices = Array.from({ length: 100 }, (_, index) => `Choice ${index}`);
    expect(responseBody.parse({ ...target, answers: { choices: choices.slice(0, 20) } })).not.toHaveProperty(
      'writeInQuestionIds',
    );
    expect(responseBody.safeParse({ ...target, answers: { choices } }).success).toBe(false);
    const explicit = { ...target, answers: { choices }, writeInQuestionIds: [] };
    expect(responseBody.parse(explicit)).toEqual(explicit);
    expect(responseBody.safeParse({ ...explicit, answers: { choices: [...choices, 'extra'] } }).success).toBe(
      false,
    );
  });

  it('requires distinct write-in IDs with exactly one nonempty answer each', () => {
    const answers = { mode: ['Standard'], choices: ['A', 'B'], blank: ['  '] };
    expect(responseBody.parse({ ...target, answers, writeInQuestionIds: ['mode'] })).toHaveProperty(
      'writeInQuestionIds',
      ['mode'],
    );
    for (const writeInQuestionIds of [['missing'], ['mode', 'mode'], ['choices'], ['blank']]) {
      expect(responseBody.safeParse({ ...target, answers, writeInQuestionIds }).success).toBe(false);
    }
    expect(responseBody.safeParse({ ...target, decision: 'accept', writeInQuestionIds: [] }).success).toBe(
      false,
    );
  });
});
