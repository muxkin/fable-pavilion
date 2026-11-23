import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { chmod, mkdir, rmdir, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { FrameReader, MAX_FRAME, encodeFrame } from '../../../packages/adapter-codex/src/framing.js';

export const CODEX_SMOKE_IDS = {
  FORK_REPLY: 'ed2a5874-cf9b-44d6-a2d6-fb9351af8eee',
  FORK: 'ed2a5874-cf9b-44d6-a2d6-fb9351af8ccc',
  CREATED: 'ed2a5874-cf9b-44d6-a2d6-fb9351af8ddd',
  VOICE_FORK: 'ed2a5874-cf9b-44d6-a2d6-fb9351af8fff',
  secondaryId: 'codex-secondary',
  browserReadOnlyPrompt: '只读权限控制验收',
  voiceOffer: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
  voiceAnswer: 'v=0\r\nm=audio 10 UDP/TLS/RTP/SAVPF 111\r\n',
  voiceSecret: 'fixture-credential-should-stay-local',
} as const;

export interface ForkCliFixtureOptions {
  directory: string;
  threadId: string;
  projectPath: string;
  voiceStopped: string;
}

export async function writeCodexForkCliFixture(options: ForkCliFixtureOptions): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  const { directory, threadId, projectPath, voiceStopped } = options;
  const { FORK_REPLY, VOICE_FORK, voiceOffer, voiceAnswer, voiceSecret } = CODEX_SMOKE_IDS;
  const forkCli = join(directory, 'fixture-codex');
  await writeFile(
    forkCli,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  console.log('codex-cli 999.0.0');
} else {
  const assert = require('node:assert/strict');
  const lines = require('node:readline').createInterface({ input: process.stdin });
  let voiceSession;
  let probing;
  const send = (value) => console.log(JSON.stringify(value));
  const notify = (name, params = {}) =>
    send({ method: 'thread/realtime/' + name, params: { threadId: '${VOICE_FORK}', ...params } });
  lines.on('line', (line) => {
    const call = JSON.parse(line);
    const reply = (result = {}) => send({ id: call.id, result });
    switch (call.method) {
      case 'initialize':
        probing = call.params.clientInfo.name === 'agent_space_reply_probe';
        if (call.params.clientInfo.name === 'agent_space_codex_voice') {
          assert.equal(call.params.capabilities.experimentalApi, true);
        }
        reply({ userAgent: call.params.clientInfo.name + '/999.0.0 fixture' });
        break;
      case 'initialized':
        break;
      case 'thread/start':
        assert(probing);
        assert.equal(call.params.cwd, process.env.CODEX_HOME);
        reply({ thread: { id: '${FORK_REPLY}', cwd: process.env.CODEX_HOME } });
        break;
      case 'thread/name/set':
        assert(probing);
        assert.equal(call.params.threadId, '${FORK_REPLY}');
        reply();
        break;
      case 'config/read':
        assert.deepEqual(call.params, { cwd: ${JSON.stringify(projectPath)}, includeLayers: false });
        reply({ config: { mcp_servers: { fixture: { enabled: true }, "fixture.with.dot": {} } } });
        break;
      case 'thread/fork': {
        if (probing) {
          assert.equal(call.params.threadId, '${FORK_REPLY}');
          assert.match(call.params.lastTurnId, /^[0-9a-f-]{36}$/);
          send({ id: call.id, error: { code: -32600, message: 'turn not found: ' + call.params.lastTurnId } });
          break;
        }
        const expected = { threadId: '${threadId}', excludeTurns: true, threadSource: 'user' };
        if (call.params.lastTurnId) {
          assert.deepEqual(call.params, { ...expected, lastTurnId: 'earlier-turn' });
          reply({ thread: { id: '${FORK_REPLY}', forkedFromId: '${threadId}' } });
        } else {
          assert.deepEqual(call.params, {
            ...expected, cwd: ${JSON.stringify(projectPath)}, deferGoalContinuation: true,
            sandbox: 'read-only', approvalPolicy: 'never',
            config: { mcp_servers: { fixture: { enabled: false }, "fixture.with.dot": { enabled: false } } },
          });
          reply({
            thread: { id: '${VOICE_FORK}', forkedFromId: '${threadId}' },
            sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never',
          });
        }
        break;
      }
      case 'thread/realtime/listVoices':
        reply({ voices: { v3: ['marin'] } });
        break;
      case 'thread/realtime/start':
        voiceSession = call.params.voiceSessionId;
        assert.match(voiceSession, /^[0-9a-f-]{36}$/);
        assert.equal(call.params.threadId, '${VOICE_FORK}');
        assert.equal(call.params.outputModality, 'audio');
        assert.equal(call.params.version, 'v3');
        assert.equal(call.params.transport.type, 'webrtc');
        reply();
        if (call.params.transport.sdp.includes('fixture-reject')) {
          notify('error', { message: '${voiceSecret}' });
          break;
        }
        assert.equal(call.params.transport.sdp, ${JSON.stringify(voiceOffer)});
        notify('started', { version: 'v3' });
        notify('sdp', { sdp: ${JSON.stringify(voiceAnswer)} });
        notify('transcript/delta', { role: 'assistant', delta: 'wrong thread', threadId: '${threadId}' });
        notify('transcript/delta', { role: 'assistant', delta: 'He' });
        notify('transcript/done', { role: 'assistant', text: 'Hello.' });
        break;
      case 'thread/realtime/stop':
        assert.equal(call.params.threadId, '${VOICE_FORK}');
        require('node:fs').appendFileSync(${JSON.stringify(voiceStopped)}, voiceSession + '\\n');
        reply();
        notify('closed', { reason: 'requested' });
        break;
      default:
        assert.fail('Unexpected Codex fixture request: ' + call.method);
    }
  });
}
`,
    { mode: 0o700 },
  );
  return forkCli;
}

export interface QueueStateControl {
  globalPath: string;
  globalFixture: Record<string, any>;
  getProtocolVersion: () => number;
  setProtocolVersion: (version: number) => void;
  protocolAttempts: number[];
}

export interface CodexDesktopFixtureOptions {
  id?: string;
  initialTitle?: string;
  renameTitle?: string;
  directory: string;
  threadId: string;
  projectPath: string;
  legacyName: string;
  legacyPath: string;
  viewed: ReadonlyArray<{ path: string; bytes: Buffer; width: number }>;
  queue: QueueStateControl;
}

export async function createCodexDesktopFixture(options: CodexDesktopFixtureOptions) {
  const {
    id = 'default',
    initialTitle = '测试会话',
    renameTitle = '已改名',
    directory,
    threadId,
    projectPath,
    legacyName,
    legacyPath,
    viewed,
    queue,
  } = options;
  const { FORK, CREATED, browserReadOnlyPrompt } = CODEX_SMOKE_IDS;

  const toolsDirectory =
    id === 'default' && process.platform !== 'win32'
      ? join('/tmp', process.platform === 'linux' ? `codex-app-tools-${process.getuid!()}` : 'codex-app-tools')
      : undefined;
  const createdToolsDirectory = !!toolsDirectory && !existsSync(toolsDirectory);
  if (toolsDirectory) await mkdir(toolsDirectory, { mode: 0o700, recursive: true });
  const path =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\' + (id === 'default' ? 'codex-app-tools-' : 'agent-space-native-test-') + crypto.randomUUID()
      : toolsDirectory
        ? join(toolsDirectory, crypto.randomUUID() + '.sock')
        : join(directory, 'ipc', id + '.sock');
  if (process.platform !== 'win32') await mkdir(join(directory, 'ipc'), { mode: 0o700, recursive: true });

  const sockets = new Set<Socket>();
  const errors: string[] = [];
  const expected = { send: 0, steer: 0, interrupt: 0 };
  const turn = crypto.randomUUID();
  let publishTurn = () => {};
  let holdStart = false;
  let heldStart: (() => void) | undefined;
  let opened = false;
  let oversizedSnapshotArmed = false;
  let oversizedSnapshotBytes = 0;
  const tools = [
    'navigate_to_codex_page',
    'get_usage_limits',
    'list_projects',
    'set_thread_title',
    'fork_thread',
    'create_thread',
  ];
  const actions: string[] = [];
  let title = initialTitle;
  let effort = 'medium';
  let mode = 'default';
  let serviceTier: string | null = null;
  let permission = ':workspace';
  let sandbox = 'workspaceWrite';
  let pending: any[] = [];
  let publish = () => {};
  let addAsyncQuestion = () => {};
  let responseCount = 0;
  let browserSends = 0;
  let threadGoal: unknown;
  const applyQueue = (rows: any[]) => {
    queue.globalFixture['queued-follow-ups'][threadId] = rows;
    writeFileSync(queue.globalPath, JSON.stringify(queue.globalFixture));
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const frames = new FrameReader();
    let revision = 0;
    const nativeTurns: Record<string, unknown>[] = [
      {
        turnId: 'earlier-turn',
        status: 'completed',
        durationMs: 1056000,
        items: [
          { id: 'live-compaction', type: 'contextCompaction', status: 'inProgress' },
          {
            id: 'live-agent',
            type: 'subAgentActivity',
            kind: 'started',
            agentThreadId: 'fixture-agent',
            agentPath: '/验证',
          },
          { id: 'earlier-progress', type: 'agentMessage', phase: 'commentary', text: 'Preparing response' },
          {
            id: 'earlier-message',
            type: 'agentMessage',
            phase: 'final_answer',
            text: 'earlier response '.repeat(1000),
          },
          {
            id: 'live-command',
            type: 'commandExecution',
            command: 'printf live',
            status: 'completed',
            aggregatedOutput: 'live output',
            exitCode: 0,
            accessToken: 'fixture-secret',
          },
          { id: 'live-image', type: 'imageView', path: viewed[0].path },
          { id: 'second-live-image', type: 'imageView', path: viewed[1].path },
        ],
      },
    ];
    const send = (value: unknown) => socket.write(encodeFrame(value));
    const snapshot = () => {
      if (oversizedSnapshotArmed && oversizedSnapshotBytes) return;
      const turns = oversizedSnapshotArmed
        ? [
            ...nativeTurns,
            {
              turnId: 'large-snapshot-turn',
              status: 'completed',
              items: [
                {
                  id: 'large-snapshot-command',
                  type: 'commandExecution',
                  command: 'cat synthetic-output.txt',
                  status: 'completed',
                  aggregatedOutput: '0123456789abcdef'.repeat((33 * 1024 * 1024) / 16),
                },
              ],
            },
          ]
        : nativeTurns;
      const value = {
        type: 'broadcast',
        sourceClientId: 'fixture-owner',
        method: 'thread-stream-state-changed',
        version: 11,
        params: {
          hostId: 'local',
          conversationId: threadId,
          change: {
            type: 'snapshot',
            revision: ++revision,
            conversationState: {
              id: threadId,
              hostId: 'local',
              title,
              latestModel: 'fixture-model',
              latestReasoningEffort: effort,
              latestCollaborationMode: { mode },
              latestThreadSettings: {
                serviceTier,
                activePermissionProfile: { id: permission },
                sandboxPolicy: { type: sandbox },
                approvalPolicy: 'on-request',
                approvalsReviewer: 'user',
              },
              cwd: projectPath,
              turns,
              requests: pending,
              threadGoal,
            },
          },
        },
      };
      if (oversizedSnapshotArmed) {
        const body = Buffer.from(JSON.stringify(value));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        oversizedSnapshotBytes = body.length;
        socket.write(header);
        socket.write(body);
      } else send(value);
    };
    socket.on('data', (chunk) => {
      try {
        frames.push(chunk, (value) => {
          const response = (result: unknown, extra = {}) =>
            send({
              type: 'response',
              requestId: value.requestId,
              resultType: 'success',
              result,
              ...extra,
            });
          switch (value.method) {
            case 'tools/list':
              send({
                id: value.id,
                result: { tools: tools.map((name) => ({ namespace: 'codex_app', name })) },
              });
              break;
            case 'tools/call': {
              const { tool, arguments: args, threadId: callThreadId } = value.params;
              assert.equal(callThreadId, threadId);
              actions.push(tool);
              let result: unknown;
              switch (tool) {
                case 'navigate_to_codex_page':
                  assert.deepEqual(args, { threadId });
                  opened = true;
                  break;
                case 'list_projects':
                  result = {
                    projects: [
                      { hostId: 'local', projectKind: 'local', projectId: 'legacy-project', label: '材料研究' },
                      { hostId: 'remote', projectKind: 'local', projectId: 'remote', label: '远程项目' },
                    ],
                  };
                  break;
                case 'get_usage_limits':
                  result = {
                    accountId: 'private-id',
                    rateLimits: {
                      primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: 1_800_000_000 },
                    },
                  };
                  break;
                case 'set_thread_title':
                  assert.deepEqual(args, { source: 'codex', threadId, title: renameTitle });
                  title = args.title;
                  break;
                case 'fork_thread':
                  assert.deepEqual(args, { threadId, environment: { type: 'same-directory' } });
                  result = { hostId: 'local', threadId: FORK };
                  break;
                case 'create_thread':
                  assert.deepEqual(args, {
                    title: '新建测试',
                    prompt: '第一条消息',
                    model: 'fixture-model',
                    thinking: 'high',
                    target: { type: 'project', projectId: 'legacy-project', environment: { type: 'local' } },
                  });
                  result = { hostId: 'local', threadId: CREATED };
                  break;
                default:
                  assert.fail('Unexpected Codex tool');
              }
              send({
                id: value.id,
                result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] },
              });
              break;
            }
            case 'initialize':
              response({ clientId: 'rust-fixture-client' });
              break;
            case 'thread-owner-discovery':
              response({}, opened ? { handledByClientId: 'fixture-owner' } : {});
              break;
            case 'thread-stream-following-changed':
              if (value.params.following) {
                publish = snapshot;
                addAsyncQuestion = () => {
                  (nativeTurns.at(-1)!.items as any[]).push({
                    id: 'fixture-async-question',
                    type: 'agentMessage',
                    text: '请回答一个可选问题',
                    questions: [{ title: '你选择什么', options: ['测试'] }],
                  });
                  snapshot();
                };
                snapshot();
              }
              break;
            case 'thread-follower-update-thread-settings': {
              const { threadSettings, condition } = value.params;
              if (threadSettings.permissions) {
                assert([':read-only', ':workspace'].includes(threadSettings.permissions));
                assert.equal(threadSettings.approvalPolicy, 'on-request');
                assert.equal(threadSettings.approvalsReviewer, 'user');
                permission = threadSettings.permissions;
                sandbox = permission === ':read-only' ? 'readOnly' : 'workspaceWrite';
              } else {
                assert.deepEqual(condition, { ifModelEquals: 'fixture-model', ifEffortEquals: 'medium' });
                assert.equal(threadSettings.model, 'fixture-model');
                effort = threadSettings.effort;
                serviceTier = threadSettings.serviceTier;
                mode = threadSettings.collaborationMode.mode;
              }
              response({ applied: true });
              snapshot();
              break;
            }
            case 'thread-follower-read-model-settings':
              response({ settings: { model: 'fixture-model', reasoningEffort: effort } });
              break;
            case 'thread-follower-set-queued-follow-ups-state':
              queue.protocolAttempts.push(value.version);
              if (value.version !== queue.getProtocolVersion()) {
                send({
                  type: 'response',
                  requestId: value.requestId,
                  resultType: 'error',
                  error: 'request-version-mismatch',
                });
                break;
              }
              assert.equal(value.params.state[threadId].at(-1).submission.queueModeOverride, 'queue-only');
              applyQueue(value.params.state[threadId]);
              response({ ok: true });
              break;
            case 'thread-follower-remove-queued-message':
              applyQueue(
                queue.globalFixture['queued-follow-ups'][threadId].filter(
                  (row: any) => row.id !== value.params.messageId,
                ),
              );
              response({ removed: true });
              break;
            case 'thread-follower-command-approval-decision':
            case 'thread-follower-file-approval-decision':
            case 'thread-follower-permissions-request-approval-response':
            case 'thread-follower-submit-user-input':
            case 'thread-follower-submit-mcp-server-elicitation-response':
              assert.equal(value.params.requestId, pending[0].id);
              if (value.method === 'thread-follower-permissions-request-approval-response') {
                assert.deepEqual(value.params.response, {
                  permissions: { fileSystem: { read: ['/allowed'] } },
                  scope: 'turn',
                });
              } else if (value.method === 'thread-follower-submit-mcp-server-elicitation-response') {
                assert.deepEqual(value.params.response, { action: 'accept', content: { confirmed: true } });
              } else if (value.method === 'thread-follower-submit-user-input') {
                assert.deepEqual(value.params.response, { answers: { answer: { answers: ['测试'] } } });
              } else {
                assert.equal(value.params.decision, pending[0].id === 'browser-approval-accept' ? 'accept' : 'decline');
              }
              responseCount++;
              pending = [];
              response({ ok: true });
              snapshot();
              break;
            case 'thread-follower-start-turn': {
              const text = value.params.turnStart.request.input[0].text;
              if (text === '从历史会话直接发送' || text === browserReadOnlyPrompt) {
                if (text === browserReadOnlyPrompt) {
                  assert.equal(permission, ':read-only');
                  assert.equal(sandbox, 'readOnly');
                  assert.equal(value.params.turnStart.context.inheritThreadSettings, true);
                }
                browserSends++;
                assert.equal(value.targetClientId, 'fixture-owner');
                const turnId = crypto.randomUUID();
                nativeTurns.push({
                  turnId,
                  status: 'completed',
                  params: value.params.turnStart.request,
                  items: [],
                });
                response({ result: { turn: { id: turnId } } });
                snapshot();
                break;
              }
              if (
                text.startsWith('PLEASE IMPLEMENT THIS PLAN:') ||
                text.startsWith('<send_user_message_question_reply>')
              ) {
                if (text.startsWith('PLEASE')) {
                  assert.equal(value.params.turnStart.request.collaborationMode.mode, 'default');
                  assert.equal(text, 'PLEASE IMPLEMENT THIS PLAN:\n测试计划');
                } else assert(text.includes('"answer":"测试"'));
                pending = [];
                const turnId = crypto.randomUUID();
                nativeTurns.push({
                  turnId,
                  status: 'completed',
                  params: value.params.turnStart.request,
                  items: [],
                });
                response({ result: { turn: { id: turnId } } });
                snapshot();
                break;
              }
              expected.send++;
              assert.equal(value.targetClientId, 'fixture-owner');
              assert(value.params.turnStart.request.input[0].text.endsWith('native smoke'));
              assert.deepEqual(value.params.turnStart.context.attachments, [
                { label: legacyName, path: legacyPath, fsPath: legacyPath },
              ]);
              assert.deepEqual(
                value.params.turnStart.request.input.slice(1).map((item: any) => [item.type, item.name]),
                [
                  ['skill', 'fixture'],
                  ['mention', 'Fixture Plugin'],
                ],
              );
              nativeTurns.push({
                turnId: turn,
                status: 'inProgress',
                params: value.params.turnStart.request,
                items: [],
              });
              const acknowledge = () => response({ result: { turn: { id: turn } } });
              if (holdStart) heldStart = acknowledge;
              else acknowledge();
              publishTurn = snapshot;
              break;
            }
            case 'thread-follower-steer-turn':
              expected.steer++;
              assert(value.params.input[0].text.endsWith('follow up'));
              assert.equal(value.params.attachments[0].label, 'native-attachment.txt');
              response({});
              break;
            case 'thread-follower-interrupt-turn':
              expected.interrupt++;
              assert.equal(value.params.expectedTurnId, turn);
              nativeTurns.at(-1)!.status = 'interrupted';
              response({ interruptedTurnId: turn });
              snapshot();
              break;
          }
        });
      } catch (error) {
        errors.push(`IPC(${id}): ${error instanceof Error ? error.message : String(error)}`);
        socket.destroy();
      }
    });
  });

  server.listen(path);
  await once(server, 'listening');
  if (process.platform !== 'win32') await chmod(path, 0o600);

  return {
    path,
    turn,
    expected,
    actions,
    errors,
    holdStart: () => {
      holdStart = true;
      return () => {
        holdStart = false;
        heldStart?.();
        heldStart = undefined;
      };
    },
    setRequest: (reqId: string | number, method: string, params: Record<string, unknown>) => {
      pending = [{ id: reqId, method, params }];
      publish();
    },
    setGoalSnapshot: (goal: unknown) => {
      threadGoal = goal;
      publish();
    },
    asyncQuestion: () => addAsyncQuestion(),
    responseCount: () => responseCount,
    browserSends: () => browserSends,
    expectLargeSnapshot: () => {
      oversizedSnapshotArmed = true;
      oversizedSnapshotBytes = 0;
      return () => {
        oversizedSnapshotArmed = false;
        assert(oversizedSnapshotBytes > MAX_FRAME, 'Fixture did not send an oversized Codex snapshot');
      };
    },
    closeConversation: () => {
      opened = false;
      responseCount = 0;
    },
    publishTurn: () => publishTurn(),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (createdToolsDirectory && toolsDirectory)
        await rmdir(toolsDirectory).catch((error) => {
          if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
        });
    },
  };
}

export type CodexDesktopFixture = Awaited<ReturnType<typeof createCodexDesktopFixture>>;
