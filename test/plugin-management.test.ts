import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_PLUGIN_SETTINGS, TERMINAL_BACKEND_ID } from '../src/shared/plugins';
import { apiCall } from '../src/shared/rpc';
import { parentRoute, readRoute, routeURL } from '../src/web/shell/routes';
import { escapeShellPath } from '../src/web/terminal/shell-escape';
import { DEFAULT_NERD_FONT_STACK, TERMINAL_THEMES } from '../src/web/terminal/terminal-prefs';

describe('Plugin management & built-in terminal defaults', () => {
  it('keeps the built-in terminal plugin disabled by default', () => {
    expect(DEFAULT_TERMINAL_PLUGIN_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_TERMINAL_PLUGIN_SETTINGS.allowX11Forwarding).toBe(false);
    expect(DEFAULT_TERMINAL_PLUGIN_SETTINGS.allowWaylandForwarding).toBe(false);
    expect(DEFAULT_TERMINAL_PLUGIN_SETTINGS.allowPortForwarding).toBe(false);
    expect(DEFAULT_TERMINAL_PLUGIN_SETTINGS.allowOsc52Clipboard).toBe(true);
    expect(TERMINAL_BACKEND_ID).toBe('terminal-local');
  });

  it('routes plugin management and terminal RPC methods through the fixed whitelist', () => {
    expect(apiCall('/api/plugins/manage', 'GET').method).toBe('plugins.manage.read');
    expect(apiCall('/api/plugins/manage/builtin', 'POST', { id: 'terminal', enabled: true }).method).toBe(
      'plugins.manage.builtin.update',
    );
    expect(apiCall('/api/plugins/manage/instances', 'POST', {}).method).toBe(
      'plugins.manage.instance.upsert',
    );
    expect(apiCall('/api/plugins/manage/instances/my-dsh/toggle', 'POST', {}).method).toBe(
      'plugins.manage.instance.toggle',
    );
    expect(apiCall('/api/plugins/manage/instances/my-dsh/delete', 'POST', {}).method).toBe(
      'plugins.manage.instance.delete',
    );
    expect(apiCall('/api/terminal/sessions', 'GET').method).toBe('terminal.sessions.list');
    expect(apiCall('/api/terminal/sessions', 'POST', {}).method).toBe('terminal.session.create');
    expect(apiCall('/api/terminal/sessions/abc/upload', 'POST', {}).method).toBe('terminal.session.upload');
    expect(apiCall('/api/terminal/sessions/abc/fs/list', 'POST', {}).method).toBe('terminal.fs.list');
    expect(apiCall('/api/terminal/sessions/abc/fs/mkdir', 'POST', {}).method).toBe('terminal.fs.mkdir');
    expect(apiCall('/api/terminal/sessions/abc/fs/rename', 'POST', {}).method).toBe('terminal.fs.rename');
    expect(apiCall('/api/terminal/sessions/abc/fs/delete', 'POST', {}).method).toBe('terminal.fs.delete');
    expect(apiCall('/api/terminal/forwards', 'POST', {}).method).toBe('terminal.forward.create');
  });

  it('provides Nerd Font fallback stack and Pavilion terminal theme presets', () => {
    expect(DEFAULT_NERD_FONT_STACK).toContain('MesloLGS NF');
    expect(DEFAULT_NERD_FONT_STACK).toContain('MesloLGS Nerd Font Mono');
    expect(TERMINAL_THEMES['pavilion-night'].canvasBg).toBe('#0e1d21');
    expect(TERMINAL_THEMES['pavilion-day'].light).toBe(true);
  });

  it('places plugins settings page under settings hierarchy', () => {
    const route = readRoute(new URL('https://app.example.com/?page=plugins'));
    expect(route).toEqual({ page: 'plugins' });
    expect(parentRoute(route)).toEqual({ page: 'settings' });
    expect(routeURL(route)).toBe('/?page=plugins');
  });

  it('escapes uploaded file paths safely on both POSIX and Windows shells', () => {
    expect(escapeShellPath("/tmp/my 'photo'.png", 'linux')).toBe("'/tmp/my '\\''photo'\\''.png'");
    expect(escapeShellPath("C:\\Users\\Bob\\it's.png", 'windows')).toBe("'C:\\Users\\Bob\\it''s.png'");
  });
});
