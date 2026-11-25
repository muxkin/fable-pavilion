/** The only public business methods. Paths are a UI compatibility mapping, not an HTTP proxy. */
export const RPC_ROUTES = {
  'security.backup.status': ['GET', '/api/security/backup'],
  'security.backup.import': ['POST', '/api/security/backup'],
  'security.backup.challenge': ['POST', '/api/security/backup/challenge'],
  'desktop.claim': ['POST', '/api/desktop/claim'],
  'controls.read': ['GET', '/api/threads/:id/controls'],
  'control.execute': ['POST', '/api/threads/:id/control'],
  'log.export': ['POST', '/api/threads/:id/export'],
  'references.list': ['GET', '/api/threads/:id/references'],
  'backends.list': ['GET', '/api/backends'],
  'backends.appearance.read': ['GET', '/api/backends/:id/appearance'],
  'backends.appearance.update': ['POST', '/api/backends/:id/appearance'],
  'plugins.manage.read': ['GET', '/api/plugins/manage'],
  'plugins.manage.builtin.update': ['POST', '/api/plugins/manage/builtin'],
  'plugins.manage.instance.upsert': ['POST', '/api/plugins/manage/instances'],
  'plugins.manage.instance.delete': ['POST', '/api/plugins/manage/instances/:id/delete'],
  'plugins.manage.instance.toggle': ['POST', '/api/plugins/manage/instances/:id/toggle'],
  'plugins.manage.switch': ['POST', '/api/plugins/manage/switch'],
  'terminal.sessions.list': ['GET', '/api/terminal/sessions'],
  'terminal.session.create': ['POST', '/api/terminal/sessions'],
  'terminal.session.resize': ['POST', '/api/terminal/sessions/:id/resize'],
  'terminal.session.close': ['POST', '/api/terminal/sessions/:id/close'],
  'terminal.session.upload': ['POST', '/api/terminal/sessions/:id/upload'],
  'terminal.session.download': ['POST', '/api/terminal/sessions/:id/download'],
  'terminal.fs.list': ['POST', '/api/terminal/sessions/:id/fs/list'],
  'terminal.fs.mkdir': ['POST', '/api/terminal/sessions/:id/fs/mkdir'],
  'terminal.fs.delete': ['POST', '/api/terminal/sessions/:id/fs/delete'],
  'terminal.fs.rename': ['POST', '/api/terminal/sessions/:id/fs/rename'],
  'terminal.forwards.list': ['GET', '/api/terminal/forwards'],
  'terminal.forward.create': ['POST', '/api/terminal/forwards'],
  'terminal.forward.close': ['POST', '/api/terminal/forwards/:id/close'],
  'terminal.forward.http': ['POST', '/api/terminal/forwards/:id/http'],
  'session.read': ['GET', '/api/session'],
  'device.revoke': ['POST', '/api/logout'],
  'status.read': ['GET', '/api/status'],
  'projects.list': ['GET', '/api/projects'],
  'threads.list': ['GET', '/api/threads'],
  'thread.read': ['GET', '/api/threads/:id'],
  'history.read': ['GET', '/api/threads/:id/history'],
  'content.read': ['GET', '/api/threads/:id/content'],
  'models.list': ['GET', '/api/models'],
  'usage.read': ['GET', '/api/usage'],
  'usage.reset': ['POST', '/api/usage/reset'],
  'skills.list': ['GET', '/api/threads/:id/skills'],
  'plugins.list': ['GET', '/api/threads/:id/plugins'],
  'creation.projects': ['GET', '/api/threads/:id/projects'],
  'thread.create': ['POST', '/api/threads/:id/create'],
  'thread.rename': ['POST', '/api/threads/:id/rename'],
  'thread.fork': ['POST', '/api/threads/:id/fork'],
  'thread.open': ['POST', '/api/threads/:id/open'],
  'message.send': ['POST', '/api/threads/:id/messages'],
  'turn.steer': ['POST', '/api/threads/:id/steer'],
  'turn.interrupt': ['POST', '/api/threads/:id/interrupt'],
  'request.respond': ['POST', '/api/threads/:id/responses'],
  'settings.update': ['POST', '/api/threads/:id/settings'],
  'queue.add': ['POST', '/api/threads/:id/queue'],
  'queue.remove': ['POST', '/api/threads/:id/queue-remove'],
  'operation.read': ['GET', '/api/operations/:id'],
  'operations.list': ['GET', '/api/threads/:id/operations'],
  'media.describe': ['POST', '/api/threads/:id/media'],
  'upload.begin': ['POST', '/api/threads/:id/uploads'],
  'upload.chunk': ['POST', '/api/threads/:id/uploads/:uploadId/chunk'],
  'upload.finish': ['POST', '/api/threads/:id/uploads/:uploadId/complete'],
} as const;
export type RpcMethod = keyof typeof RPC_ROUTES;
export interface RpcCall {
  backendId?: string;
  method: RpcMethod;
  params: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
}
export function apiCall(path: string, method = 'GET', body?: unknown): RpcCall {
  const url = new URL(path.startsWith('/api/') ? path : `/api${path}`, 'https://local.invalid');
  if (url.origin !== 'https://local.invalid') throw Error('External URL is not a business method');
  for (const [name, [verb, pattern]] of Object.entries(RPC_ROUTES)) {
    if (method.toUpperCase() !== verb) continue;
    const keys: string[] = [];
    const expression = pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    const match = new RegExp(`^${expression}$`).exec(url.pathname);
    if (match)
      return {
        method: name as RpcMethod,
        params: Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])])),
        query: Object.fromEntries(url.searchParams),
        body,
      };
  }
  throw Error('Unsupported business method');
}
export class RpcError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}
