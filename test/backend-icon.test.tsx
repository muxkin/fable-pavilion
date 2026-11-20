import { expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { BackendIcon } from '../src/web/BackendIcon';
import { backendAppearanceDefaults, backendStyle } from '../src/shared/backend-appearance';
import type { BackendIcon as IconValue } from '../src/shared/backends';

const render = (icon: IconValue, product = 'antigravity') =>
  renderToString(createSSRApp({ render: () => <BackendIcon product={product} icon={icon} /> }));

it('identifies Antigravity and renders its official mark without changing stored default icon keys', async () => {
  expect(backendStyle('Antigravity')).toBe('antigravity');
  const defaults = backendAppearanceDefaults({ product: 'antigravity', name: 'My agent' });
  expect(defaults.icon).toEqual({ kind: 'builtin', value: 'puzzle' });
  const markup = await render(defaults.icon);
  expect(markup).toContain('builtin official');
  expect(markup).toContain('data-agent-style="antigravity"');
  expect(markup).toContain('antigravity.png');
  expect(markup).not.toContain('<svg');
});

it('preserves custom emoji, images, and other built-in icons for Antigravity instances', async () => {
  const emoji = await render({ kind: 'emoji', value: '🚀' });
  expect(emoji).toContain('🚀');
  expect(emoji).not.toContain(' official');
  expect(emoji).not.toContain('<img');
  const custom = 'data:image/png;base64,c3ludGhldGlj';
  const image = await render({ kind: 'image', value: custom });
  expect(image).toContain(custom);
  expect(image).not.toContain(' official');
  const builtin = await render({ kind: 'builtin', value: 'terminal' });
  expect(builtin).toContain('<svg');
  expect(builtin).not.toContain(' official');
});

it('keeps the Codex official mark and generic third-party defaults separate', async () => {
  expect(await render({ kind: 'builtin', value: 'code' }, 'codex')).toContain('codex.png');
  const generic = await render({ kind: 'builtin', value: 'puzzle' }, 'third-party');
  expect(generic).toContain('data-agent-style="generic"');
  expect(generic).not.toContain(' official');
});
