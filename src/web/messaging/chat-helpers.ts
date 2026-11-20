import type { ChatMessage } from '../../shared/messaging';

export const mobileComposer = window.matchMedia('(max-width: 700px)');
export const attachmentLimit = 10 * 1024 * 1024;

export const activityNames = {
  read: '读取资料',
  search: '搜索资料',
  fetch: '获取资料',
  execute: '运行工具',
  edit: '编辑内容',
  other: '处理任务',
} as const;

export const activityStates = {
  pending: '待执行',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
} as const;

export function subscribeComposerLayout(listener: () => void) {
  mobileComposer.addEventListener('change', listener);
  return () => mobileComposer.removeEventListener('change', listener);
}

export function mergeMessages(old: ChatMessage[], next: ChatMessage[]) {
  const map = new Map(old.map((m) => [m.id, m]));
  for (const m of next) {
    if (!map.has(m.id) || map.get(m.id)!.revision <= m.revision) map.set(m.id, m);
  }
  return [...map.values()].sort((a, b) => a.sequence - b.sequence);
}

export function quoteLabel(message: ChatMessage | undefined, fallback = '查看引用消息') {
  if (message?.interaction?.kind === 'approval') return '审批记录';
  return message?.text.slice(0, 100) || fallback;
}
