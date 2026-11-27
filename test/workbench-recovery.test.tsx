import { describe, expect, it, vi } from 'vitest';
import { createRenderer, createSSRApp, defineComponent, h, nextTick, shallowRef, ssrContextKey } from 'vue';
import { renderToString } from '@vue/server-renderer';

vi.mock('../src/web/diagnostics', () => ({
  recordDiagnostic: vi.fn(),
}));
vi.mock('../src/web/device-session', () => ({
  deviceSession: {
    online: false,
    backendId: 'antigravity-local',
    api: vi.fn(),
    cached: vi.fn(),
    onChange: () => () => {},
  },
  remoteFetch: vi.fn(),
}));
vi.mock('../src/web/desktop-keyboard', async () => {
  const { shallowRef } = await import('vue');
  return { useDesktopKeyboard: () => shallowRef(false) };
});
vi.mock('../src/web/theme/use-appearance', async () => {
  const { shallowRef } = await import('vue');
  return {
    useAppearance: () =>
      shallowRef({
        settings: { theme: 'jade', colorMode: 'light', lineNumbers: false },
        resolved: 'light',
      }),
  };
});

import { PageBoundary } from '../src/web/shell/PageBoundary';
import { TranscriptMessages } from '../src/web/TranscriptMessages';
import { DiffView } from '../src/web/DiffView';
import { TurnNavigation } from '../src/web/TurnNavigation';
import { PlanRequestCard } from '../src/web/PlanRequestCard';
import RichMessage from '../src/web/RichMessage';
import { useChatDrafts } from '../src/web/chat-drafts';
import { OutgoingMessageCard } from '../src/web/workspace/OutgoingMessageCard';
import type { ConversationRequest, Message, Operation } from '../src/shared/types';

type MockNode = {
  type: 'element' | 'text' | 'comment';
  tag?: string;
  text: string;
  children: MockNode[];
  parent: MockNode | null;
};

function createTestRenderer() {
  const make = (type: MockNode['type'], text = '', tag?: string): MockNode => ({
    type,
    tag,
    text,
    children: [],
    parent: null,
  });
  const renderer = createRenderer<MockNode, MockNode>({
    patchProp() {},
    insert(child, parent, anchor) {
      child.parent = parent;
      const idx = anchor ? parent.children.indexOf(anchor) : -1;
      if (idx >= 0) parent.children.splice(idx, 0, child);
      else parent.children.push(child);
    },
    remove(child) {
      if (!child.parent) return;
      const idx = child.parent.children.indexOf(child);
      if (idx >= 0) child.parent.children.splice(idx, 1);
      child.parent = null;
    },
    createElement: (tag) => make('element', '', tag),
    createText: (text) => make('text', text),
    createComment: (text) => make('comment', text),
    setText(node, text) {
      node.text = text;
    },
    setElementText(node, text) {
      node.children = [make('text', text)];
    },
    parentNode: (node) => node.parent,
    nextSibling(node) {
      if (!node.parent) return null;
      const idx = node.parent.children.indexOf(node);
      return idx >= 0 ? (node.parent.children[idx + 1] ?? null) : null;
    },
  });
  const textOf = (node: MockNode): string =>
    node.type === 'text' ? node.text : node.children.map(textOf).join('');
  return { renderer, container: make('element', '', 'root'), textOf };
}

describe('workbench PageBoundary recovery and defensive rendering', () => {
  it('clears captured failure on the same mounted PageBoundary when resetKey changes', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prevWindow = (globalThis as { window?: unknown }).window;
    if (!prevWindow) {
      (globalThis as { window?: unknown }).window = {
        addEventListener() {},
        removeEventListener() {},
      };
    }
    const shouldFail = shallowRef(true);
    const resetKey = shallowRef('host:antigravity-local:thread-1:true');

    const Flaky = defineComponent({
      setup() {
        return () => {
          if (shouldFail.value) throw new TypeError('synthetic workbench crash');
          return h('div', { class: 'recovered' }, 'workbench-recovered');
        };
      },
    });

    const Host = defineComponent({
      setup() {
        return () =>
          h(
            PageBoundary,
            {
              page: 'workbench',
              backLabel: '返回工作台',
              onBack: () => {},
              resetKey: resetKey.value,
            },
            { default: () => h(Flaky) },
          );
      },
    });

    const { renderer, container, textOf } = createTestRenderer();
    const app = renderer.createApp(Host);
    app.provide(ssrContextKey, { modules: new Set() });
    try {
      app.mount(container);
      await nextTick();
      expect(textOf(container)).toContain('这个页面遇到了问题');
      expect(textOf(container)).toContain('返回工作台');
      expect(errorSpy).toHaveBeenCalled();

      shouldFail.value = false;
      resetKey.value = 'host:antigravity-local::true';
      await nextTick();
      expect(textOf(container)).toContain('workbench-recovered');
      expect(textOf(container)).not.toContain('这个页面遇到了问题');
    } finally {
      app.unmount();
      await nextTick();
      errorSpy.mockRestore();
      if (!prevWindow) delete (globalThis as { window?: unknown }).window;
    }
  });

  it('mounts empty RichMessage in Vue client renderer without crashing Fragment children', async () => {
    const { renderer, container } = createTestRenderer();
    const app = renderer.createApp({
      render: () => h(RichMessage, { text: '', threadId: 't1' }),
    });
    app.provide(ssrContextKey, { modules: new Set() });
    try {
      app.mount(container);
      await nextTick();
      expect(container.children.length).toBeGreaterThan(0);
    } finally {
      app.unmount();
      await nextTick();
    }
  });

  it('renders malformed Antigravity/workbench messages without throwing', async () => {
    const messages = [
      {
        id: 'm1',
        role: 'user',
        text: undefined as unknown as string,
        createdAt: 1_795_742_695_678_000_000, // out-of-range nanoseconds
      },
      {
        id: 'm2',
        role: 'assistant',
        text: 'hello',
        createdAt: Number.NaN,
      },
      {
        id: 'm3',
        role: 'tool',
        text: 'edit',
        changes: [{ path: '/tmp/a.ts', kind: 'update', diff: undefined as unknown as string }],
      },
    ] as Message[];

    const requests = [
      {
        id: 'async:m2',
        kind: 'async-question',
        title: 'q',
        actionable: true,
        questions: undefined,
      },
      {
        id: 'plan-1',
        kind: 'plan',
        title: 'plan',
        actionable: false,
        description: undefined,
      },
    ] as unknown as ConversationRequest[];

    const transcriptHtml = await renderToString(
      createSSRApp({
        render: () => (
          <TranscriptMessages
            agent={{ name: 'Antigravity' }}
            messages={messages}
            threadId="t1"
            requests={requests}
            codex={false}
          />
        ),
      }),
    );
    expect(transcriptHtml).toContain('Antigravity');

    const richHtml = await renderToString(
      createSSRApp({
        render: () => <RichMessage text={undefined as unknown as string} threadId="t1" />,
      }),
    );
    expect(richHtml).toContain('markdown');

    const planHtml = await renderToString(
      createSSRApp({
        render: () => (
          <PlanRequestCard
            request={requests[1]}
            threadId="t1"
            disabled={true}
            onRespond={() => {}}
          />
        ),
      }),
    );
    expect(planHtml).toContain('计划等待批准');

    const diffHtml = await renderToString(
      createSSRApp({
        render: () => <DiffView changes={[{ path: 'a.ts', kind: 'update', diff: undefined as unknown as string }]} />,
      }),
    );
    expect(diffHtml).toContain('a.ts');

    const navHtml = await renderToString(
      createSSRApp({
        render: () => (
          <TurnNavigation
            messages={[messages[0], { id: 'u2', role: 'user', text: 'second' }]}
            transcript={shallowRef(null)}
            onNavigate={() => {}}
          />
        ),
      }),
    );
    expect(navHtml).toContain('附件消息');
  });

  it('keeps accepted steer outgoing messages visible until cleared after echo', async () => {
    const store = new Map<string, string>();
    const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    const steerOp: Operation = {
      id: 'op-steer-1',
      threadId: 't1',
      kind: 'steer',
      state: 'received',
      turnId: 'turn-1',
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    let latestDrafts: ReturnType<ReturnType<typeof useChatDrafts>> | undefined;
    const Probe = defineComponent({
      setup() {
        const readDrafts = useChatDrafts();
        return () => {
          latestDrafts = readDrafts('dev:antigravity-local', 't1');
          return h('div', latestDrafts.outgoing?.operation.state ?? 'none');
        };
      },
    });
    const { renderer, container } = createTestRenderer();
    const app = renderer.createApp(Probe);
    app.provide(ssrContextKey, { modules: new Set() });
    try {
      app.mount(container);
      await nextTick();
      latestDrafts!.submit(
        steerOp,
        { text: '好吧还是失败', uploads: [{ id: 'u1', name: 'image.png' }], skills: [], plugins: [] },
        false,
      );
      await nextTick();
      expect(latestDrafts!.outgoing?.operation.state).toBe('received');

      const accepted: Operation = { ...steerOp, state: 'accepted' };
      latestDrafts!.settle(accepted);
      await nextTick();
      expect(latestDrafts!.outgoing?.operation.state).toBe('accepted');
      expect(latestDrafts!.outgoing?.draft.text).toBe('好吧还是失败');

      const cardHtml = await renderToString(
        createSSRApp({
          render: () => (
            <OutgoingMessageCard
              threadId="t1"
              codex={false}
              operation={accepted}
              draft={latestDrafts!.outgoing!.draft}
              hasFailure={false}
              draftHasContent={false}
              onCheck={async () => {}}
              onMoveToDraft={() => {}}
              onDismiss={() => {}}
            />
          ),
        }),
      );
      expect(cardHtml).toMatch(/已追加，等待接入|Queued for next step/);

      latestDrafts!.clearOutgoing(accepted);
      await nextTick();
      expect(latestDrafts!.outgoing).toBeUndefined();
    } finally {
      app.unmount();
      await nextTick();
      if (prevStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else (globalThis as { localStorage?: unknown }).localStorage = prevStorage;
    }
  });
});
