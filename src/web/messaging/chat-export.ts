import type { ChatConversation, ChatMessage } from '../../shared/messaging';

export type ChatExportFormat = 'markdown' | 'json';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatExportTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function exportFilename(conversationName: string, format: ChatExportFormat, now = Date.now()): string {
  const d = new Date(now);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  const safeName = conversationName
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
    .slice(0, 48) || 'chat';
  return `${safeName}-聊天记录-${stamp}.${format === 'json' ? 'json' : 'md'}`;
}

export function formatChatExportMarkdown(
  conversation: Pick<ChatConversation, 'id' | 'name' | 'kind' | 'members'>,
  messages: ChatMessage[],
  exportedAt = Date.now(),
): string {
  const sorted = [...messages].sort((a, b) => a.sequence - b.sequence || a.createdAt - b.createdAt);
  const byId = new Map(sorted.map((m) => [m.id, m]));
  const lines: string[] = [
    `# ${conversation.name}`,
    '',
    `- 会话类型：${conversation.kind === 'group' ? '群聊' : '私聊'}`,
    `- 成员数：${conversation.members.length}`,
    `- 消息数：${sorted.length}`,
    `- 导出时间：${formatExportTimestamp(exportedAt)}`,
    `- 说明：云端仅保留近 7 天记录，本导出合并了本机缓存与云端可用消息。`,
    '',
    '---',
    '',
  ];
  let currentDay = '';
  for (const msg of sorted) {
    const day = formatExportTimestamp(msg.createdAt).slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      lines.push(`## ${day}`, '');
    }
    const sender = conversation.members.find((m) => m.id === msg.senderId) ?? msg.sender;
    const senderLabel = sender?.displayName
      ? `${sender.displayName} (@${sender.username})`
      : msg.senderId;
    const time = formatExportTimestamp(msg.createdAt).slice(11);
    lines.push(`### ${senderLabel} · ${time}`);
    if (msg.replyTo) {
      const target = byId.get(msg.replyTo);
      if (target) {
        const snippet = (target.text || (target.attachments.length ? '[附件]' : ''))
          .replace(/\s+/g, ' ')
          .slice(0, 80);
        lines.push(`> 回复 ${target.sender?.displayName ?? target.senderId}：${snippet}`);
        lines.push('');
      }
    }
    if (msg.text.trim()) {
      lines.push(msg.text.trim());
      lines.push('');
    }
    if (msg.sticker) {
      lines.push('*[表情包]*', '');
    }
    if (msg.attachments.length) {
      for (const file of msg.attachments) {
        const kb = file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`;
        lines.push(`- 附件：${file.name} (${file.mime}, ${kb}${file.removed ? ', 云端已清理' : ''})`);
      }
      lines.push('');
    }
    if (msg.interaction) {
      lines.push(`- 交互卡片：${msg.interaction.title}（状态：${msg.interaction.status}）`, '');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function formatChatExportJson(
  conversation: Pick<ChatConversation, 'id' | 'name' | 'kind' | 'members'>,
  messages: ChatMessage[],
  exportedAt = Date.now(),
): string {
  const sorted = [...messages].sort((a, b) => a.sequence - b.sequence || a.createdAt - b.createdAt);
  return JSON.stringify(
    {
      version: 1,
      exportedAt,
      exportedAtIso: new Date(exportedAt).toISOString(),
      conversation: {
        id: conversation.id,
        name: conversation.name,
        kind: conversation.kind,
        members: conversation.members.map((m) => ({
          id: m.id,
          username: m.username,
          displayName: m.displayName,
          kind: m.kind,
        })),
      },
      messageCount: sorted.length,
      messages: sorted.map((m) => ({
        id: m.id,
        sequence: m.sequence,
        createdAt: m.createdAt,
        createdAtIso: new Date(m.createdAt).toISOString(),
        senderId: m.senderId,
        senderName: m.sender?.displayName ?? '',
        senderUsername: m.sender?.username ?? '',
        text: m.text,
        replyTo: m.replyTo,
        sticker: Boolean(m.sticker),
        state: m.state,
        attachments: m.attachments.map((a) => ({
          id: a.id,
          name: a.name,
          mime: a.mime,
          size: a.size,
          removed: Boolean(a.removed),
        })),
        ...(m.interaction
          ? {
              interaction: {
                kind: m.interaction.kind,
                title: m.interaction.title,
                status: m.interaction.status,
              },
            }
          : {}),
      })),
    },
    null,
    2,
  );
}

export function triggerTextDownload(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
