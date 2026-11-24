import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type QuestionReceiptFault = 'committed' | 'uncommitted';

export const ANTIGRAVITY_FIXTURE_CONSTANTS = {
  backendId: 'antigravity-local',
  threadId: '11111111-1111-4111-8111-111111111111',
  createdId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  trajectoryId: '44444444-4444-4444-8444-444444444444',
  switchId: '55555555-5555-4555-8555-555555555555',
  replacementTrajectoryId: '66666666-6666-4666-8666-666666666666',
  initialTitle: 'Fixture Antigravity conversation',
  switchTitle: 'Fixture dense history conversation',
  recoveredAnswerMarker: 'Fixture continued after the native answer receipt was lost.',
  fixtureImage: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
    'base64',
  ),
  nativePlugin: {
    name: 'fixture-local-plugin',
    displayName: 'Fixture selectable plugin',
    path: 'file:///fixture/private/plugin-definition',
    logo: 'file:///fixture/private/plugin-logo',
  },
  extraQuestionOptions: Array.from({ length: 19 }, (_, index) => ({
    id: `extra-${index}`,
    text: `补充选项 ${index + 1}`,
  })),
} as const;

export interface AntigravityFixtureOptions {
  agentHome: string;
  browserChannel?: 'msedge' | 'chrome';
  oldGateway: boolean;
}

export async function createAntigravityFixture(options: AntigravityFixtureOptions) {
  const { agentHome, browserChannel, oldGateway } = options;
  const {
    threadId,
    createdId,
    projectId,
    trajectoryId,
    switchId,
    replacementTrajectoryId,
    initialTitle,
    switchTitle,
    recoveredAnswerMarker,
    fixtureImage,
    nativePlugin,
    extraQuestionOptions,
  } = ANTIGRAVITY_FIXTURE_CONSTANTS;
  const nextInvocation = 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION';
  const workspaceDir = join(agentHome, 'workspace');
  await mkdir(join(workspaceDir, 'src'), { recursive: true });
  await writeFile(join(workspaceDir, 'src', 'demo.ts'), 'export const demo = 42;\n');
  await writeFile(join(workspaceDir, '.env'), 'FIXTURE_SECRET=do-not-expose\n');
  const workspaceUri = pathToFileURL(workspaceDir).href;
  const brainDir = join(agentHome, 'brain', threadId);
  await mkdir(brainDir, { recursive: true });
  const citedArtifact = join(brainDir, 'artifact.md');
  await writeFile(citedArtifact, '# Fixture Artifact\n');

  const calls = {
    send: 0,
    steer: 0,
    interrupt: 0,
    create: 0,
    answer: 0,
    answerReplyLost: 0,
    approval: 0,
    rename: 0,
    permissionUpdates: [] as { threadId: string; preset: string }[],
    queueAdd: 0,
    queueRemove: 0,
    quotaRefresh: [] as boolean[],
  };
  const errors: string[] = [];
  let token = 'synthetic-daemon-token-one';
  let quotaMode: 'primary' | 'unsupported' | 'none' = 'primary';
  let skillsEnabled = true;
  let pluginEnabled = true;
  let nextModelEnabled = true;
  let unavailableHistory: string | undefined;
  let heldHistory: ReturnType<typeof holdNextHistory> | undefined;
  let pagedHistory = false;
  let pagedHistoryUnavailable = false;
  let pagedTrajectoryId: string = trajectoryId;
  let extendedQuestions = false;
  let nextQuestionReceiptFault: QuestionReceiptFault | undefined;
  let expectedCommandApproval: boolean | undefined;
  let conversationPermissions = true;
  let adminPermissionLock = false;
  let sandboxAvailable = true;
  const skillInfo = {
    name: 'fixture-skill',
    type: 'SLASH_COMMAND_TYPE_SKILL',
    definitionPath: 'file:///fixture/skill/SKILL.md',
    modelFacingText: 'Fixture native skill instruction',
  };
  let server: ReturnType<typeof createServer> | undefined;
  type Conversation = {
    running: boolean;
    steps: Record<string, unknown>[];
    pending?: { id: string; requestId: string; text: string }[];
    annotations?: { title?: string; permissionPreset?: string };
    executorMetadatas?: { executionId: string; terminationReason: string }[];
  };
  const initial = (): Conversation => ({
    running: false,
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        metadata: { executionId: 'history-execution' },
        userInput: { items: [{ text: 'fixture question' }] },
      },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        metadata: { executionId: 'history-execution' },
        plannerResponse: {
          response: 'fixture answer',
          thinking: 'private synthetic reasoning',
          signature: 'private synthetic signature',
        },
      },
    ],
  });
  const conversations = new Map<string, Conversation>();
  function resetConversations() {
    conversations.clear();
    conversations.set(threadId, initial());
    if (!browserChannel) {
      conversations.set(switchId, { running: false, steps: [] });
      return;
    }
    // Exercise the expensive render branches without using private chat history.
    const code = [
      '```typescript',
      ...Array.from({ length: 48 }, (_, i) => `const item${i} = { value: ${i}, active: true };`),
      '```',
    ].join('\n');
    const steps = Array.from({ length: 22 }, (_, i) => {
      const metadata = { executionId: `synthetic-dense-${i}` };
      return [
        {
          type: 'CORTEX_STEP_TYPE_USER_INPUT',
          metadata,
          userInput: { items: [{ text: `Synthetic prompt ${i}` }] },
        },
        ...Array.from({ length: 5 }, (_, commandIndex) => ({
          type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
          metadata,
          runCommand: {
            commandLine: `fixture-command ${commandIndex}`,
            combinedOutput: { full: 'synthetic output\n'.repeat(500) },
          },
        })),
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          metadata,
          plannerResponse: {
            response: i === 21 ? 'Synthetic history marker.' : `## Synthetic response ${i}\n\n${code}`,
          },
        },
      ];
    }).flat();
    conversations.set(switchId, { running: false, steps });
  }
  resetConversations();
  const command = "printf 'fixture command'";
  const nativeQuestions = [
    {
      question: '选颜色',
      options: [
        { id: 'red', text: '红' },
        { id: 'blue', text: '蓝' },
      ],
    },
    {
      question: '选择多项',
      isMultiSelect: true,
      options: [
        { id: 'first', text: '甲' },
        { id: 'second', text: '乙' },
        ...extraQuestionOptions,
      ],
    },
    { question: '写点什么' },
  ];
  const whenIdle = 'MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE';

  function protobufPart(tag: number, data: string | Buffer) {
    const value = typeof data === 'string' ? Buffer.from(data) : data;
    assert(value.length < 128, 'Choose short synthetic protobuf fixture fields');
    const key = (tag << 3) | 2;
    return Buffer.concat([
      Buffer.from(key < 128 ? [key, value.length] : [(key & 127) | 128, key >> 7, value.length]),
      value,
    ]);
  }

  function queueFrame(body: {
    conversationId: string;
    initialStepsPageBounds?: { startIndex?: number; endIndexExclusive?: number };
  }) {
    const id = body.conversationId;
    const conversation = conversations.get(id);
    assert(conversation, 'Requested unknown queue fixture conversation');
    const pending = conversation.pending ?? [];
    const bounds = body.initialStepsPageBounds;
    const paged = pagedHistory && id === switchId;
    const start = bounds?.startIndex ?? 0;
    const end = bounds?.endIndexExclusive ?? 0;
    const total = conversation.steps.length;
    if (paged && total > 160 && end === total && end - start > 50) {
      const header = Buffer.alloc(5);
      header.writeUInt32BE(32 * 1024 * 1024 + 1, 1);
      return header;
    }
    const steps = paged ? conversation.steps.slice(start, end) : [];
    const update = {
      conversationId: id,
      trajectoryId: nativeTrajectoryId(id),
      status: conversation.running ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
      mainTrajectoryUpdate: paged
        ? {
            stepsUpdate: {
              pageBounds: bounds,
              totalLength: total,
              indices: steps.map((_, index) => start + index),
              steps,
            },
          }
        : {},
      ...(pending.length && {
        pendingAgentMessagesUpdate: {
          indices: pending.map((_, index) => index),
          totalLength: pending.length,
          pendingAgentMessages: pending.map((row) => ({
            id: row.id,
            recipient: id,
            deliveryStrategy: whenIdle,
            stepPayload: protobufPart(
              19,
              Buffer.concat([protobufPart(3, protobufPart(1, row.text)), protobufPart(19, row.requestId)]),
            ).toString('base64'),
          })),
        },
      }),
    };
    const payload = Buffer.from(JSON.stringify({ update }));
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
  }

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      assert.equal(request.headers['x-codeium-csrf-token'], token);
      assert.equal(request.headers['connect-protocol-version'], '1');
      assert(request.url?.startsWith('/exa.language_server_pb.LanguageServerService/'));
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const method = request.url?.split('/').at(-1);
      const bytes = Buffer.concat(chunks);
      if (method === 'StreamAgentStateUpdates') {
        assert.equal(request.headers['content-type'], 'application/connect+json');
        assert.equal(bytes[0], 0);
        assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
        const streamRequest = JSON.parse(bytes.subarray(5).toString());
        if (pagedHistoryUnavailable && streamRequest.conversationId === switchId) {
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ code: 'unavailable', message: 'Synthetic paged history outage' }));
          return;
        }
        const frame = queueFrame(streamRequest);
        response.setHeader('Content-Type', 'application/connect+json');
        response.write(frame.subarray(0, 3));
        response.end(frame.subarray(3));
        return;
      }
      const body = JSON.parse(bytes.toString() || '{}');
      if (method === 'GetCascadeTrajectory' && body.cascadeId === unavailableHistory) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ code: 'unavailable', message: 'Synthetic history outage' }));
        return;
      }
      if (method === 'GetCascadeTrajectory' && pagedHistory && body.cascadeId === switchId) {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': 32 * 1024 * 1024 + 1,
        });
        response.end('{}');
        return;
      }
      if (method === 'RetrieveUserQuotaSummary' && quotaMode === 'unsupported') {
        response.writeHead(501, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ code: 'unimplemented', message: 'Synthetic unsupported quota summary API' }),
        );
        return;
      }
      const held =
        method === 'GetCascadeTrajectory' && body.cascadeId === heldHistory?.thread ? heldHistory : undefined;
      if (held) {
        heldHistory = undefined;
        held.started = true;
        await held.wait;
      }
      const receiptFault =
        method === 'HandleCascadeUserInteraction' && body.interaction?.askQuestion
          ? nextQuestionReceiptFault
          : undefined;
      if (receiptFault) nextQuestionReceiptFault = undefined;
      const result = await dispatch(method ?? '', body, held?.marker, receiptFault);
      if (receiptFault) {
        calls.answerReplyLost++;
        response.destroy();
        return;
      }
      if (
        (method === 'SendUserCascadeMessage' && body.items?.[0]?.text === 'fixture unknown outcome') ||
        (method === 'UpdateConversationAnnotations' &&
          body.annotations?.title === 'fixture unknown rename outcome')
      ) {
        response.destroy();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
      if (held) held.replied = true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ code: 'invalid_argument', message: 'Synthetic fixture rejected request' }),
        );
      }
    }
  };

  const start = async () => {
    server = createServer((request, response) => {
      void handle(request, response);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    await writeFile(
      join(agentHome, 'daemon', `hub_${address.port}.json`),
      JSON.stringify({ pid: process.pid, httpPort: address.port, csrfToken: token, lsVersion: '2.33.0' }),
      { mode: 0o600 },
    );
  };

  const closeServer = async () => {
    const active = server;
    if (!active) return;
    server = undefined;
    active.closeAllConnections();
    await new Promise<void>((done) => active.close(() => done()));
  };

  const dispatch = async (
    method: string,
    body: Record<string, any>,
    historyMarker?: string,
    receiptFault?: QuestionReceiptFault,
  ): Promise<unknown> => {
    switch (method) {
      case 'GetCapabilities':
        return {};
      case 'GetServerConfiguration':
        return { config: { sandboxAvailable, subclientType: 'hub' } };
      case 'GetMendelFlags':
        return { experimentConfig: { experiments: [
          { keyString: 'permission-v2' },
          { keyString: 'enable-conversation-scoped-permissions', disabled: !conversationPermissions },
          { keyString: 'enable-auto-permission-preset' },
        ] } };
      case 'GetPermissionSettings':
        return { globalPreset: 'AGENT_PERMISSION_PRESET_TURBO' };
      case 'FetchAdminControls':
        return adminPermissionLock
          ? { adminControlsApplicable: true, agentControls: { permissionPresetLocked: true } }
          : {};
      case 'RetrieveUserQuotaSummary':
        assert.equal(typeof body.forceRefresh, 'boolean');
        calls.quotaRefresh.push(body.forceRefresh);
        return quotaSummary();
      case 'GetUserStatus':
        return {
          userStatus: {
            name: 'private-fixture-account',
            email: 'private-fixture-account@example.invalid',
            userTier: { name: 'Fixture Pro', id: 'private-fixture-account-tier' },
            planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro' } },
            cascadeModelConfigData: quotaMode === 'primary' ? quotaCatalog() : {},
          },
        };
      case 'GetAllCascadeTrajectories':
        assert.equal(body.excludeSubtrajectories, true);
        return {
          trajectorySummaries: Object.fromEntries(
            [...conversations].map(([id, conversation]) => [
              id,
              {
                summary:
                  id === threadId
                    ? initialTitle
                    : id === switchId
                      ? switchTitle
                      : 'Created fixture conversation',
                annotations: conversation.annotations,
                trajectoryId: nativeTrajectoryId(id),
                stepCount: conversation.steps.length,
                lastModifiedTime: '2026-11-19T06:00:00Z',
                workspaces: [{ workspaceFolderAbsoluteUri: workspaceUri }],
                trajectoryMetadata: { projectId },
              },
            ]),
          ),
        };
      case 'GetCascadeTrajectory': {
        const conversation = conversations.get(body.cascadeId);
        assert(conversation, 'Requested unknown fixture conversation');
        return {
          status: conversation.running ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
          trajectory: {
            cascadeId: body.cascadeId,
            trajectoryId: nativeTrajectoryId(body.cascadeId),
            steps: historyMarker ? [...conversation.steps, historyMarkerStep(historyMarker)] : conversation.steps,
            executorMetadatas: conversation.executorMetadatas ?? [],
            generatorMetadata: [{ plannerConfig: { planModel: 'MODEL_FIXTURE' } }],
          },
        };
      }
      case 'ListProjects':
        return { projectIds: [projectId] };
      case 'ReadProjects':
        assert.deepEqual(body.ids, [projectId]);
        return {
          projects: [
            {
              id: projectId,
              name: 'Fixture project',
              projectResources: { resources: [{ gitFolder: { folderUri: workspaceUri } }] },
            },
          ],
        };
      case 'ReadProject':
        assert.deepEqual(body, { id: projectId });
        return { project: { id: projectId, backendType: 'BACKEND_TYPE_LOCAL',
          settings: { permissionPreset: 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW' } } };
      case 'GetCascadeModelConfigData':
        return quotaCatalog();
      case 'GetSlashCommands':
        assert(body.cascadeId === threadId || body.cascadeId === '');
        assert.deepEqual(body.workspaceUris, [workspaceUri]);
        return {
          commands: [
            { info: { name: 'help', type: 'SLASH_COMMAND_TYPE_SYSTEM' }, title: 'Help' },
            ...(skillsEnabled
              ? [{ info: skillInfo, title: 'Fixture skill', description: 'Fixture skill description' }]
              : []),
          ],
        };
      case 'GetAllPlugins':
        assert.deepEqual(body, { workspaceUris: [workspaceUri] });
        return {
          plugins: [
            {
              ...nativePlugin,
              description: 'Fixture plugin description',
              disabled: !pluginEnabled,
            },
            {
              name: 'fixture-private-disabled',
              path: 'file:///fixture/private/disabled',
              forceDisabled: true,
            },
            {
              name: 'fixture-private-unauthenticated',
              path: 'file:///fixture/private/unauthenticated',
              authRequired: true,
            },
          ],
        };
      case 'SendUserCascadeMessage': {
        const conversation = conversations.get(body.cascadeId);
        assert(conversation);
        assert.equal(typeof body.clientMessageId, 'string');
        assert(Array.isArray(body.items) && (typeof body.items[0]?.text === 'string' || body.media?.length));
        const text = body.items[0]?.text;
        const media = [];
        if (body.media?.length) {
          assert.equal(body.media.length, 1);
          const image = body.media[0];
          assert.equal(image.mimeType, 'image/png');
          assert.deepEqual(await readFile(image.uri), fixtureImage);
          const nativeFolder = join(agentHome, 'brain', body.cascadeId, '.user_uploaded');
          await mkdir(nativeFolder, { recursive: true });
          const path = join(nativeFolder, basename(image.uri));
          try {
            await rename(image.uri, path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
            await writeFile(path, await readFile(image.uri));
            await rm(image.uri);
          }
          media.push({ mimeType: image.mimeType, displayName: image.displayName, uri: path });
        }
        if (body.deliveryStrategy === nextInvocation) {
          assert.equal(conversation.running, true, 'Append reached a conversation without an active turn');
          const executionId = conversation.steps.at(-1)?.metadata as { executionId?: string };
          assert(executionId?.executionId);
          const expectedKeys = ['cascadeId', 'clientMessageId', 'deliveryStrategy', 'items'];
          if (media.length) expectedKeys.push('media');
          assert.deepEqual(Object.keys(body).sort(), expectedKeys.sort());
          if (typeof text === 'string') assert.deepEqual(body.items, [{ text }]);
          else assert.deepEqual(body.items, []);
          calls.steer++;
          conversation.steps.push({
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            metadata: { executionId: executionId.executionId },
            userInput: {
              items: body.items,
              ...(media.length ? { media } : {}),
              clientMessageId: body.clientMessageId,
            },
          });
          return {};
        }
        if (body.deliveryStrategy === whenIdle) {
          assert(conversation.running, 'Queue did not reach the active native conversation');
          conversation.pending ??= [];
          conversation.pending.push({
            id: `native-queue-${++calls.queueAdd}`,
            requestId: body.clientMessageId,
            text: body.items[0].text,
          });
          return {};
        }
        assert.equal(conversation.running, false, 'Send reached a busy native conversation');
        if (text === 'fixture send once') {
          assert.deepEqual(
            body.items[1],
            { item: { slashCommand: { info: skillInfo, argumentValues: {} } } },
            'Selected skill was not sent as a native slash-command scope item',
          );
          assert.deepEqual(body.items[2], { item: { plugin: nativePlugin } });
        } else if (text === 'Fixture browser plugin and photo') {
          assert.deepEqual(body.items[1], { item: { plugin: nativePlugin } });
        }
        if (text === 'fixture create once') {
          assert.equal(body.cascadeId, createdId);
          assert.deepEqual(body.cascadeConfig, { plannerConfig: { planModel: 'MODEL_FIXTURE_NEXT' } });
          assert.equal(media.length, 1, 'Creation image did not reach Antigravity');
          assert.deepEqual(body.items[1], { item: { slashCommand: { info: skillInfo, argumentValues: {} } } });
          assert.deepEqual(body.items[2], { item: { plugin: nativePlugin } });
        }
        const expectedModel =
          !oldGateway && (text === 'fixture send once' || media[0]?.displayName === 'browser-fixture.png');
        if (expectedModel) {
          assert.deepEqual(body.cascadeConfig, { plannerConfig: { planModel: 'MODEL_FIXTURE_NEXT' } });
        } else if (text === 'fixture failed execution') {
          assert.equal(body.cascadeConfig, undefined, 'A prior message model leaked into a later send');
        }
        calls.send++;
        if (text === 'fixture unknown outcome') return {};
        conversation.running = true;
        conversation.steps.push({
          type: 'CORTEX_STEP_TYPE_USER_INPUT',
          metadata: { executionId: `execution-${calls.send}` },
          userInput: { items: body.items, clientMessageId: body.clientMessageId, media },
        });
        if (text === 'fixture failed execution') {
          conversation.running = false;
          conversation.executorMetadatas ??= [];
          conversation.executorMetadatas.push({
            executionId: `execution-${calls.send}`,
            terminationReason: 'EXECUTOR_TERMINATION_REASON_ERROR',
          });
        }
        return {};
      }
      case 'DeleteAgentMessage': {
        assert.deepEqual(Object.keys(body).sort(), ['messageId', 'recipient']);
        const conversation = conversations.get(body.recipient);
        assert(conversation?.pending);
        const index = conversation.pending.findIndex((row) => row.id === body.messageId);
        assert(index >= 0, 'Deletion did not use a stable native pending-message ID');
        calls.queueRemove++;
        conversation.pending.splice(index, 1);
        return {};
      }
      case 'HandleCascadeUserInteraction': {
        assert(body.cascadeId === threadId || (pagedHistory && body.cascadeId === switchId));
        const conversation = conversations.get(body.cascadeId)!;
        assert.equal(conversation.running, true);
        assert.equal(body.interaction.trajectoryId, nativeTrajectoryId(body.cascadeId));
        const stepIndex = body.interaction.stepIndex;
        assert.equal(stepIndex, conversation.steps.length - 1);
        const step = conversation.steps[stepIndex];
        assert.equal(step.status, 'CORTEX_STEP_STATUS_WAITING');
        if (
          step.requestedInteraction &&
          typeof step.requestedInteraction === 'object' &&
          'permission' in step.requestedInteraction
        ) {
          assert.equal(body.cascadeId, threadId, 'Paged history must not approve commands');
          calls.approval++;
          assert.equal(typeof expectedCommandApproval, 'boolean');
          assert.deepEqual(body.interaction.permission, {
            allow: expectedCommandApproval,
            scope: 'PERMISSION_SCOPE_ONCE',
          });
          step.status = 'CORTEX_STEP_STATUS_DONE';
          step.completedInteractions = [{ request: step.requestedInteraction, response: body.interaction }];
          conversation.running = false;
          return {};
        }
        const [single, multi, freeform] = body.interaction.askQuestion.responses;
        if (extendedQuestions) {
          assert.equal(single.selectedOptionIds, undefined);
          assert.equal(single.writeInResponse, '红');
        } else {
          assert.deepEqual(single.selectedOptionIds, ['red']);
        }
        assert.deepEqual(multi.selectedOptionIds, [
          'first',
          'second',
          ...(extendedQuestions ? extraQuestionOptions.map(({ id }) => id) : []),
        ]);
        assert.equal(freeform.writeInResponse, '补充内容');
        calls.answer++;
        if (receiptFault === 'uncommitted') return {};
        const responses = [single, multi, freeform].map(({ isMultiSelect, options: opts, ...answer }) => ({
          ...answer,
          ...(isMultiSelect && { isMultiSelect }),
          ...(opts?.length && { options: opts }),
        }));
        step.status = 'CORTEX_STEP_STATUS_DONE';
        step.completedInteractions = [
          {
            request: { askQuestion: { questions: nativeQuestions } },
            response: { ...body.interaction, askQuestion: { responses } },
          },
        ];
        conversation.steps.push({
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          metadata: { executionId: 'fixture-interaction-turn' },
          plannerResponse: {
            response: receiptFault ? recoveredAnswerMarker : 'fixture continued after answer',
          },
        });
        conversation.running = false;
        return {};
      }
      case 'CancelCascadeInvocation': {
        const conversation = conversations.get(body.cascadeId);
        assert(conversation?.running, 'Cancellation reached an idle native conversation');
        calls.interrupt++;
        conversation.running = false;
        const latest = [...conversation.steps]
          .reverse()
          .find((step: any) => step.metadata?.executionId) as any;
        assert(latest?.metadata.executionId);
        conversation.executorMetadatas ??= [];
        conversation.executorMetadatas.push({
          executionId: latest.metadata.executionId,
          terminationReason: 'EXECUTOR_TERMINATION_REASON_USER_CANCELED',
        });
        return {};
      }
      case 'StartCascade':
        assert.equal(body.source, 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT');
        assert.equal(body.trajectoryType, 'CORTEX_TRAJECTORY_TYPE_CASCADE');
        assert.equal(body.projectEnvConfig.projectId, projectId);
        calls.create++;
        conversations.set(createdId, { running: false, steps: [] });
        return { cascadeId: createdId };
      case 'UpdateConversationAnnotations': {
        assert.equal(body.mergeAnnotations, true);
        assert.equal(body.cascadeIds.length, 1);
        const conversation = conversations.get(body.cascadeIds[0]);
        assert(conversation);
        if (body.annotations.permissionPreset) {
          assert(conversationPermissions && !adminPermissionLock);
          assert.deepEqual(Object.keys(body.annotations), ['permissionPreset']);
          const preset = body.annotations.permissionPreset;
          calls.permissionUpdates.push({ threadId: body.cascadeIds[0], preset });
          conversation.annotations = { ...conversation.annotations, permissionPreset: preset };
          if (preset === 'AGENT_PERMISSION_PRESET_UNSPECIFIED')
            delete conversation.annotations.permissionPreset;
          return {};
        }
        assert.deepEqual(Object.keys(body.annotations), ['title']);
        assert.equal(typeof body.annotations.title, 'string');
        assert.equal(body.annotations.title, body.annotations.title.trim());
        conversation.annotations = { ...conversation.annotations, ...body.annotations };
        calls.rename++;
        return {};
      }
      default:
        throw Error(`Unimplemented synthetic Connect method: ${method}`);
    }
  };

  function quotaSummary() {
    if (quotaMode === 'none') return { response: { groups: [] } };
    const bucket = (bucketId: string, window: string, remainingFraction: number) => ({
      bucketId,
      window,
      remainingFraction,
      displayName: `${window} limit remaining`,
      description: bucketId.startsWith('gemini-') ? 'private-fixture-account' : undefined,
      resetTime: window === 'weekly' ? '2026-11-26T11:09:35Z' : '2026-11-19T11:09:35Z',
    });
    return {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'private-fixture-account',
            buckets: [
              bucket('gemini-weekly', 'weekly', 0.962743),
              bucket('gemini-5h', '5h', 0.89123),
              { bucketId: 'disabled', window: 'weekly', remainingFraction: 0.5, disabled: true },
              { bucketId: 'unknown', window: 'weekly', resetTime: '2026-11-26T11:09:35Z' },
              { bucketId: 'amount-only', window: 'weekly', remainingAmount: '20' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [bucket('3p-weekly', 'weekly', 1), bucket('3p-5h', '5h', 0)],
          },
          { displayName: 'Gemini 4 Argon', buckets: [bucket('argon-weekly', 'weekly', 1)] },
        ],
      },
    };
  }

  function quotaCatalog() {
    return {
      clientModelConfigs: [
        {
          modelId: 'fixture',
          label: 'Fixture model',
          modelOrAlias: { model: 'MODEL_FIXTURE' },
          allowedTiers: ['TEAMS_TIER_PRO'],
          quotaInfo:
            quotaMode === 'none' ? {} : { remainingFraction: 0.75, resetTime: '2026-11-19T11:09:35Z' },
        },
        {
          modelId: 'fixture-zero',
          label: 'Exhausted fixture model',
          modelOrAlias: { model: 'MODEL_ZERO' },
          allowedTiers: ['TEAMS_TIER_PRO'],
          quotaInfo: quotaMode === 'none' ? {} : { remainingFraction: 0, resetTime: '2026-11-19T11:09:35Z' },
        },
        { modelId: 'fixture-disabled', label: 'Unavailable fixture model', quotaInfo: {} },
        ...(nextModelEnabled
          ? [{ modelId: 'fixture-next', label: 'Fixture next model', modelOrAlias: { model: 'MODEL_FIXTURE_NEXT' } }]
          : []),
      ],
    };
  }

  function nativeTrajectoryId(id: string) {
    return pagedHistory && id === switchId ? pagedTrajectoryId : trajectoryId;
  }

  function historyMarkerStep(text: string) {
    return {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      metadata: { executionId: 'synthetic-history-marker' },
      userInput: { items: [{ text }] },
    };
  }

  function holdNextHistory(thread: string, marker: string) {
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const held = {
      thread,
      marker,
      started: false,
      replied: false,
      wait,
      release() {
        if (heldHistory === held) heldHistory = undefined;
        resume();
      },
    };
    assert(!heldHistory, 'Only one synthetic history response can be held');
    heldHistory = held;
    return held;
  }

  function appendPagedRows(count: number) {
    const { steps } = conversations.get(switchId)!;
    const start = steps.length;
    const name = pagedTrajectoryId === trajectoryId ? 'paged' : 'replacement';
    for (let index = start; index < start + count; index++) {
      steps.push({
        type: 'CORTEX_STEP_TYPE_USER_INPUT',
        metadata: { executionId: `${name}-record-${index}` },
        userInput: { items: [{ text: `Synthetic ${name} record ${index}.` }] },
      });
    }
  }

  await start();
  return {
    calls,
    errors,
    setQuotaMode(mode: 'primary' | 'unsupported' | 'none') {
      quotaMode = mode;
    },
    setSkillsEnabled(enabled: boolean) {
      skillsEnabled = enabled;
    },
    setPluginEnabled(enabled: boolean) {
      pluginEnabled = enabled;
    },
    setNextModelEnabled(enabled: boolean) {
      nextModelEnabled = enabled;
    },
    setPermissionCapabilities(options: { enabled?: boolean; adminLocked?: boolean; sandbox?: boolean }) {
      conversationPermissions = options.enabled ?? true;
      adminPermissionLock = options.adminLocked ?? false;
      sandboxAvailable = options.sandbox ?? true;
    },
    failHistory(thread: string | undefined) {
      unavailableHistory = thread;
    },
    failPagedHistory(unavailable: boolean) {
      pagedHistoryUnavailable = unavailable;
    },
    holdNextHistory,
    appendHistoryMarker(thread: string, text: string) {
      conversations.get(thread)!.steps.push(historyMarkerStep(text));
    },
    beginPagedHistory() {
      pagedHistory = true;
      pagedTrajectoryId = trajectoryId;
      conversations.set(switchId, { running: false, steps: [] });
      appendPagedRows(160);
    },
    advancePagedHistory(count: number) {
      assert(pagedHistory);
      appendPagedRows(count);
    },
    replacePagedHistory() {
      assert(pagedHistory);
      const { steps } = conversations.get(switchId)!;
      const count = steps.length;
      steps.length = 0;
      pagedTrajectoryId = replacementTrajectoryId;
      appendPagedRows(count);
    },
    rewindPagedHistory(count: number) {
      assert(pagedHistory);
      const { steps } = conversations.get(switchId)!;
      assert(count > 0 && count < steps.length);
      steps.length = count;
      steps[count - 1].userInput = { items: [{ text: 'Synthetic rewind marker.' }] };
    },
    askQuestion(extended = false, id: string = threadId) {
      extendedQuestions = extended;
      const conversation = conversations.get(id)!;
      conversation.running = true;
      conversation.steps.push({
        type: 'CORTEX_STEP_TYPE_ASK_QUESTION',
        status: 'CORTEX_STEP_STATUS_WAITING',
        metadata: { executionId: 'fixture-interaction-turn' },
        askQuestion: { questions: nativeQuestions },
      });
    },
    loseNextQuestionReceipt(fault: QuestionReceiptFault) {
      assert.equal(nextQuestionReceiptFault, undefined);
      nextQuestionReceiptFault = fault;
    },
    dismissQuestion() {
      const conversation = conversations.get(threadId)!;
      const step = conversation.steps.at(-1)!;
      assert.equal(step.type, 'CORTEX_STEP_TYPE_ASK_QUESTION');
      assert.equal(step.status, 'CORTEX_STEP_STATUS_WAITING');
      assert.equal(step.completedInteractions, undefined);
      step.status = 'CORTEX_STEP_STATUS_CANCELED';
      conversation.running = false;
    },
    clearHistory() {
      conversations.clear();
    },
    requestCommandApproval(allow: boolean) {
      const conversation = conversations.get(threadId)!;
      assert.equal(conversation.running, false);
      expectedCommandApproval = allow;
      conversation.running = true;
      conversation.steps.push({
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: 'CORTEX_STEP_STATUS_WAITING',
        metadata: {
          executionId: 'fixture-command-approval',
          sourceTrajectoryStepInfo: { trajectoryId, cascadeId: threadId, stepIndex: conversation.steps.length },
        },
        generic: { args: { CommandLine: command, BypassSandbox: 'false' } },
        requestedInteraction: {
          permission: {
            resource: { action: 'command', target: command },
            approvalScopeFilter: ['PERMISSION_SCOPE_ONCE'],
          },
        },
      });
    },
    requestFileApproval(allow: boolean) {
      const conversation = conversations.get(threadId)!;
      assert.equal(conversation.running, false);
      expectedCommandApproval = allow;
      conversation.running = true;
      conversation.steps.push({
        type: 'CORTEX_STEP_TYPE_REPLACE_FILE_CONTENT',
        status: 'CORTEX_STEP_STATUS_WAITING',
        metadata: {
          executionId: 'fixture-file-approval',
          sourceTrajectoryStepInfo: { trajectoryId, cascadeId: threadId, stepIndex: conversation.steps.length },
        },
        requestedInteraction: {
          permission: {
            resource: { action: 'replace_file_content', target: join(workspaceDir, 'src', 'demo.ts') },
            approvalScopeFilter: ['PERMISSION_SCOPE_ONCE'],
          },
        },
      });
    },
    citeArtifact() {
      const conversation = conversations.get(threadId)!;
      conversation.steps.push({
        type: 'CORTEX_STEP_TYPE_VIEW_FILE',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: { executionId: 'history-execution' },
        viewFile: { absolutePath: citedArtifact },
      });
    },
    citedArtifact,
    startQueueTurn() {
      const conversation = conversations.get(threadId)!;
      conversation.running = true;
      conversation.steps.push({
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        metadata: { executionId: 'fixture-browser-queue-turn' },
        plannerResponse: { response: 'Synthetic active queue turn.' },
      });
    },
    reset() {
      heldHistory?.release();
      heldHistory = undefined;
      resetConversations();
      quotaMode = 'primary';
      skillsEnabled = true;
      pluginEnabled = true;
      nextModelEnabled = true;
      unavailableHistory = undefined;
      pagedHistory = false;
      pagedHistoryUnavailable = false;
      pagedTrajectoryId = trajectoryId;
      extendedQuestions = false;
      nextQuestionReceiptFault = undefined;
      expectedCommandApproval = undefined;
      conversationPermissions = true;
      adminPermissionLock = false;
      sandboxAvailable = true;
      errors.length = 0;
      calls.send = 0;
      calls.steer = 0;
      calls.interrupt = 0;
      calls.create = 0;
      calls.answer = 0;
      calls.answerReplyLost = 0;
      calls.approval = 0;
      calls.rename = 0;
      calls.permissionUpdates.length = 0;
      calls.queueAdd = 0;
      calls.queueRemove = 0;
      calls.quotaRefresh.length = 0;
    },
    get token() {
      return token;
    },
    async rotate() {
      await closeServer();
      token = 'synthetic-daemon-token-two';
      await start();
    },
    close: closeServer,
  };
}

export type AntigravityFixture = Awaited<ReturnType<typeof createAntigravityFixture>>;
