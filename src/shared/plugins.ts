export type BuiltInPluginId = 'terminal';

export type HostPlatform = 'linux' | 'macos' | 'windows' | 'unknown';

export interface TerminalPluginSettings {
  enabled: boolean;
  defaultShell: string;
  defaultCwd: string;
  allowX11Forwarding: boolean;
  allowWaylandForwarding: boolean;
  allowPortForwarding: boolean;
  allowOsc52Clipboard: boolean;
  maxSessions: number;
}

export const DEFAULT_TERMINAL_PLUGIN_SETTINGS: Readonly<TerminalPluginSettings> = Object.freeze({
  enabled: false,
  defaultShell: '',
  defaultCwd: '',
  allowX11Forwarding: false,
  allowWaylandForwarding: false,
  allowPortForwarding: false,
  allowOsc52Clipboard: true,
  maxSessions: 8,
});

export interface TerminalShellOption {
  id: string;
  name: string;
  path: string;
  args?: string[];
  platform: HostPlatform;
}

export interface TerminalHostCapabilities {
  ptyBackend: 'conpty' | 'posix-pty';
  x11HostDisplay: string | null;
  waylandHostDisplay: string | null;
  hasXvfb: boolean;
  hasXpra: boolean;
  hasWaypipe: boolean;
  hasWsl: boolean;
}

export interface BuiltInPluginInfo {
  id: BuiltInPluginId;
  packageName: string;
  name: string;
  description: string;
  product: string;
  defaultEnabled: boolean;
  enabled: boolean;
  configurable: boolean;
  features: string[];
  config: TerminalPluginSettings;
  hostCapabilities?: TerminalHostCapabilities;
}

export interface InstalledPluginPackage {
  key: string;
  name: string;
  version: string;
  product: string;
  stateVersion: number;
  official: boolean;
}

export interface ManagedPluginInstance {
  id: string;
  name: string;
  plugin: string;
  version: string | null;
  enabled: boolean;
  connected: boolean;
  builtin: boolean;
  editable: boolean;
  currentPackage: string | null;
  previousPackage: string | null;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface PluginManagementSnapshot {
  platform: HostPlatform;
  builtins: BuiltInPluginInfo[];
  packages: InstalledPluginPackage[];
  instances: ManagedPluginInstance[];
  availableShells: TerminalShellOption[];
}

export interface TerminalForwardSummary {
  id: string;
  kind: 'tcp' | 'x11' | 'wayland';
  sessionId: string | null;
  targetHost: string;
  targetPort: number;
  display: string | null;
  activeConnections: number;
  bytesIn: number;
  bytesOut: number;
  createdAt: number;
}

export interface TerminalSessionSummary {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  platform: HostPlatform;
  running: boolean;
  exitCode: number | null;
  createdAt: number;
  x11Display: string | null;
  waylandDisplay: string | null;
}

export const TERMINAL_BACKEND_ID = 'terminal-local';
export const TERMINAL_PRODUCT = 'terminal';
