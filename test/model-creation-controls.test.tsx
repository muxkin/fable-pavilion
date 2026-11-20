import { beforeEach, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import type { BackendInfo, ModelChoice } from '../src/shared/backends';
import type { ThreadView } from '../src/shared/types';

const fixture = vi.hoisted(() => ({ models: [] as ModelChoice[] }));
vi.mock('../src/web/device-session', () => ({
  deviceSession: {
    modelCatalogKey: () => 'fixture',
    contentKey: (key: string) => key,
    online: false,
    cache: { peek: () => ({ models: fixture.models }) },
    onChange: () => () => {},
  },
  remoteFetch: vi.fn(),
}));
vi.mock('../src/web/desktop-keyboard', async () => {
  const { shallowRef } = await import('vue');
  return { useDesktopKeyboard: () => shallowRef(false) };
});
import { ModelSettings } from '../src/web/ModelSettings';
import { NewConversation } from '../src/web/NewConversation';
import { ConversationControls } from '../src/web/ConversationControls';
import { ChatComposer } from '../src/web/ChatComposer';

const view = (effort: string | null = null) =>
  ({
    model: 'fixture-model',
    reasoningEffort: effort,
    serviceTier: null,
    mode: 'default',
    activeTurnId: null,
  }) as ThreadView;
const model = (efforts: string[]): ModelChoice => ({
  id: 'fixture-model',
  name: 'Fixture model',
  efforts,
  defaultEffort: efforts[0] ?? null,
  speeds: [],
});
beforeEach(() => {
  fixture.models = [];
});

async function settings(effort: string | null = null) {
  return renderToString(
    createSSRApp({
      render: () => (
        <ModelSettings
          view={view(effort)}
          disabled={false}
          creation
          onSave={async () => undefined}
          onApplied={() => {}}
        />
      ),
    }),
  );
}
it('allows selecting a model with no independent reasoning setting', async () => {
  fixture.models = [model([])];
  const markup = await settings();
  expect(markup).toContain('<button class="primary">用于新会话</button>');
  expect(markup).not.toContain('aria-label="推理强度"');
});
it('still requires a supported reasoning choice when the model declares choices', async () => {
  fixture.models = [model(['high', 'low'])];
  expect(await settings()).toContain('<button class="primary" disabled>用于新会话</button>');
  expect(await settings('high')).toContain('<button class="primary">用于新会话</button>');
});
it('marks a required creation project without changing optional standalone creation', async () => {
  const render = (requireProject: boolean) =>
    renderToString(
      createSSRApp({
        render: () => (
          <NewConversation
            anchor="new"
            disabled={false}
            active={true}
            requireProject={requireProject}
            knownProjects={[{ id: 'project', name: 'Project', count: 0 }]}
            onCreate={() => {}}
            onDirtyChange={() => {}}
          />
        ),
      }),
    );
  expect(await render(true)).toMatch(/<option value(?:="")? disabled>请选择项目<\/option>/);
  expect(await render(false)).toMatch(/<option value(?:="")?>独立会话<\/option>/);
});

it('shows only the controls offered by the current backend', async () => {
  const render = (skills: boolean) =>
    renderToString(
      createSSRApp({
        render: () => (
          <ConversationControls
            id="thread"
            backend={
              {
                capabilities: {
                  skills: { state: skills ? 'experimental' : 'unsupported' },
                  plugins: { state: 'unsupported' },
                },
              } as BackendInfo
            }
            disabled={false}
            running={false}
            plan={false}
            onAction={() => {}}
            onMode={() => {}}
            onFile={() => {}}
            onSkills={() => {}}
            onPlugins={() => {}}
          />
        ),
      }),
    );
  const unsupported = await render(false);
  expect(unsupported).not.toContain('aria-label="会话权限"');
  expect(unsupported).not.toContain('aria-label="工具"');
  const selectable = await render(true);
  expect(selectable).toContain('aria-label="工具"');
  expect(selectable).toContain('>技能<');
  expect(selectable).not.toContain('>插件<');
});

it('offers interrupt while saving a draft on a running conversation that cannot be steered', async () => {
  const markup = await renderToString(
    createSSRApp({
      render: () => (
        <ChatComposer
          value={{ text: 'next message draft', uploads: [], skills: [], plugins: [] }}
          onChange={() => {}}
          onSubmit={() => {}}
          disabled={false}
          sendDisabled={false}
          running
          canSteer={false}
        />
      ),
    }),
  );
  expect(markup).toContain('>next message draft</textarea>');
  expect(markup).toContain('aria-label="中断任务"');
});
