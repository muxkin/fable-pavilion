import { describe, it, expect } from 'vitest';
import { approvalResponse, normalizeRequest, requestFingerprint, responseBody } from '../src/approvals.js';
const turn = 'test-turn';
const request = (method: string, params: Record<string, unknown>) => ({
  id: 42,
  method,
  params: { turnId: turn, ...params },
});
const target = { targetRequestId: '42', expectedTurnId: turn };
describe('native approval boundaries', () => {
  it('requires a bound plan decision and feedback only for revisions', () => {
    const base = {
      requestId: crypto.randomUUID(),
      ...target,
      expectedFingerprint: 'a'.repeat(64),
      planDecision: 'implement',
    };
    expect(responseBody.safeParse(base).success).toBe(true);
    expect(
      responseBody.safeParse({ ...base, planDecision: 'revise', feedback: 'Adjust step 2' }).success,
    ).toBe(true);
    for (const extra of [
      { expectedFingerprint: undefined },
      { planDecision: 'revise' },
      { decision: 'accept' },
      { feedback: 'unexpected' },
    ])
      expect(responseBody.safeParse({ ...base, ...extra }).success).toBe(false);
  });
  it('shows file changes from the matching native item', () => {
    const r = normalizeRequest(request('item/fileChange/requestApproval', { itemId: 'file' }), [
      { id: 'file', changes: [{ path: '/work/a.ts', kind: { type: 'add' }, diff: '+new' }] },
    ]);
    expect(r.changes).toEqual([{ path: '/work/a.ts', kind: 'add', diff: '+new' }]);
    expect(r.actionable).toBe(true);
  });
  it('restricts command decisions to the choices offered by the desktop', () => {
    const r = request('item/commandExecution/requestApproval', {
      command: 'echo test',
      availableDecisions: ['accept', 'decline'],
    });
    const reviewed = { ...target, expectedFingerprint: requestFingerprint(r) };
    expect(() => approvalResponse(r, { ...reviewed, decision: 'acceptForSession' })).toThrow();
    expect(approvalResponse(r, { ...reviewed, decision: 'decline' }).payload).toMatchObject({
      requestId: 42,
      decision: 'decline',
    });
  });
  it('pins a response to the exact request content as well as its turn', () => {
    const r = request('item/commandExecution/requestApproval', { command: 'echo before' });
    const fingerprint = requestFingerprint(r);
    Object.assign(r.params, { command: 'echo changed' });
    expect(() =>
      approvalResponse(r, { ...target, expectedFingerprint: fingerprint, decision: 'accept' }),
    ).toThrow();
  });
  it('changes the fingerprint when an approval shows updated item details', () => {
    for (const [method, field, before, after] of [
      ['commandExecution', 'command', 'printf first', 'printf second'],
      ['fileChange', 'changes', [{ path: '/fixture/a.txt', diff: '+first' }], [
        { path: '/fixture/a.txt', diff: '+second' },
      ]],
    ] as const) {
      const raw = request(`item/${method}/requestApproval`, { itemId: 'review-item' });
      const first = normalizeRequest(raw, [{ id: 'review-item', [field]: before }]);
      const second = normalizeRequest(raw, [{ id: 'review-item', [field]: after }]);
      expect(second.actionable).toBe(true);
      expect(second.fingerprint).not.toBe(first.fingerprint);
      for (const decision of ['accept', 'decline'] as const) {
        const response = { ...target, expectedFingerprint: first.fingerprint, decision };
        expect(approvalResponse(raw, response, first).payload).toEqual({ requestId: 42, decision });
        expect(() => approvalResponse(raw, response, second)).toThrow();
      }
    }
  });
  it('requires a reviewed fingerprint for command approvals', () => {
    const raw = request('item/commandExecution/requestApproval', { command: 'printf fixture' });
    expect(() => approvalResponse(raw, { ...target, decision: 'accept' })).toThrow();
  });
  it('binds a regular command to the item working directory and prefers explicit callback details', () => {
    const first = { id: 'review', command: 'printf fixture', cwd: '/fixture/first' };
    const second = { ...first, cwd: '/fixture/second' };
    const raw = request('item/commandExecution/requestApproval', { itemId: 'review' });
    const original = normalizeRequest(raw, [first]);
    expect(original.description).toContain(first.cwd);
    expect(normalizeRequest(raw, [second]).fingerprint).not.toBe(original.fingerprint);

    const callback = request(raw.method, { itemId: 'review', approvalId: 'specific-callback' });
    expect(normalizeRequest(callback, [first]).actionable).toBe(false);
    Object.assign(callback.params, { command: 'printf requested', cwd: '/fixture/requested' });
    const explicit = normalizeRequest(callback, [first]);
    expect(explicit.actionable).toBe(true);
    expect(explicit.description).toContain('/fixture/requested');
    expect(explicit.description).toContain('printf requested');
    expect(normalizeRequest(callback, [second]).fingerprint).toBe(explicit.fingerprint);
  });
  it('does not approve a file change with incomplete review details', () => {
    const raw = request('item/fileChange/requestApproval', { changes: [{ path: '/fixture/a.txt' }] });
    const shown = normalizeRequest(raw, []);
    expect(shown.actionable).toBe(false);
    expect(() => approvalResponse(raw, { ...target, expectedFingerprint: shown.fingerprint, decision: 'accept' })).toThrow();
  });
  it('grants only selected original filesystem paths and never accepts injected paths', () => {
    const r = request('item/permissions/requestApproval', {
      permissions: { network: { enabled: true }, fileSystem: { read: ['/a', '/b'], write: ['/c'] } },
    });
    const reviewed = { ...target, expectedFingerprint: requestFingerprint(r) };
    for (const scope of ['turn', 'session'] as const) {
      expect(
        approvalResponse(r, { ...reviewed, permissionIds: ['fileSystem.read.1'], scope }).payload,
      ).toMatchObject({ response: { permissions: { fileSystem: { read: ['/b'] } }, scope } });
    }
    expect(() => approvalResponse(r, { ...reviewed, permissionIds: ['/root'] })).toThrow();
    expect(approvalResponse(r, { ...reviewed, permissionIds: [] }).payload).toMatchObject({
      response: { permissions: {}, scope: 'turn' },
    });
  });
  it('validates connector forms and preserves cancel/decline semantics', () => {
    const r = request('mcpServer/elicitation/request', {
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1 } },
        required: ['count'],
        additionalProperties: false,
      },
    });
    expect(() => approvalResponse(r, { ...target, action: 'accept', content: { count: 'bad' } })).toThrow();
    expect(approvalResponse(r, { ...target, action: 'accept', content: { count: 2 } }).payload).toMatchObject(
      { response: { action: 'accept', content: { count: 2 } } },
    );
    expect(approvalResponse(r, { ...target, action: 'cancel' }).payload).toMatchObject({
      response: { action: 'cancel', content: null },
    });
  });
  it('does not synthesize acceptance for user-verification or unknown request modes', () => {
    const r = request('mcpServer/elicitation/request', { mode: 'openai/userVerification' });
    expect(normalizeRequest(r, []).actionable).toBe(false);
    expect(() => approvalResponse(r, { ...target, action: 'accept' })).toThrow();
  });
  it('requires all native questions and rejects mixed response payloads', () => {
    const r = request('item/tool/requestUserInput', { questions: [{ id: 'a' }, { id: 'b' }] });
    expect(() => approvalResponse(r, { ...target, answers: { a: ['yes'] } })).toThrow();
    expect(
      responseBody.safeParse({
        ...target,
        requestId: crypto.randomUUID(),
        decision: 'accept',
        answers: { a: ['yes'] },
      }).success,
    ).toBe(false);
  });
});
