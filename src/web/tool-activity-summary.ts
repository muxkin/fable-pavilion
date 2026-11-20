import type { Message, ToolAction } from '../shared/types';

const actionLabels: Record<ToolAction, string> = {
  'read-file': '读取文件',
  'list-files': '查找文件',
  'search-files': '搜索文件',
  'run-command': '执行命令',
  'web-search': '搜索网页',
  'open-page': '浏览网页',
  'find-in-page': '在网页中查找',
  'edit-file': '修改文件',
  'load-tool': '加载工具',
  'find-tool': '查找工具',
  'call-tool': '调用工具',
};

const toolActions = new Map([
  ['read_file', '读取文件'],
  ['read_files', '读取文件'],
  ['read_text_file', '读取文件'],
  ['read_multiple_files', '读取文件'],
  ['list_directory', '查找文件'],
  ['list_files', '查找文件'],
  ['search_files', '搜索文件'],
  ['grep', '搜索文件'],
  ['apply_patch', '修改文件'],
  ['edit_file', '修改文件'],
  ['write_file', '修改文件'],
  ['fileChange', '修改文件'],
  ['webSearch', '搜索网页'],
  ['web_search', '搜索网页'],
  ['web_search_call', '搜索网页'],
  ['search_query', '搜索网页'],
  ['exec_command', '执行命令'],
  ['shell_command', '执行命令'],
  ['load_tool', '加载工具'],
  ['tool_search', '查找工具'],
]);

function leadingCommand(script: string) {
  let quote = '';
  for (let index = 0; index < script.length; index++) {
    const character = script[index];
    if (character === '\\' && quote !== "'") {
      index++;
      continue;
    }
    if (character === quote) quote = '';
    else if (!quote && (character === "'" || character === '"')) quote = character;
    else if (quote !== "'" && (character === '`' || script.startsWith('$(', index))) return;
    else if (!quote && (character === '<' || character === '>')) return;
    else if (!quote && /[;&|\n\r]/.test(character)) {
      // Only the leading operation is known. A conditional suffix may never execute.
      return { command: script.slice(0, index).trimEnd(), compound: true };
    }
  }
  if (!quote && !script.endsWith('…')) return { command: script, compound: false };
}

function commandActions(text: string) {
  // Rust's preview joins argv with spaces. A shell script may have no outer quotes.
  const shell = /^(?:[^\s]+\/)?(?:ba|z|da)?sh\s+-(?:l?c|cl)\s+([\s\S]*)$/.exec(text);
  const payload = (shell?.[1] ?? text).trim();
  const quoted = shell && /^(['"])([\s\S]*)\1$/.exec(payload);
  const leading = leadingCommand(quoted?.[2].trim() ?? payload);
  if (!leading) return ['执行命令'];

  const { command, compound } = leading;
  const simple = /^(?:[^\s]+\/)?(cat|head|tail|rg|grep|ls|curl)(?:\s+(\S.*))?$/.exec(command);
  const program = simple?.[1];
  const args = simple?.[2] ?? '';
  let action: string | undefined;
  if (!/(?:^|\s)--(?:help|version)(?:\s|$)/.test(args)) {
    if (program === 'cat' || program === 'head' || program === 'tail') {
      if (args.split(/\s+/).some((arg) => arg && !arg.startsWith('-') && !/^\+?\d+$/.test(arg)))
        action = '读取文件';
    } else if (program === 'ls' || (program === 'rg' && /(?:^|\s)--files(?:\s|$)/.test(args))) {
      action = '查找文件';
    } else if (args && (program === 'rg' || program === 'grep')) {
      action = '搜索文件';
    } else if (program === 'curl' && /(?:^|\s)['"]?https?:\/\//.test(args)) {
      action = '请求网络资源';
    }
  }
  if (/^(?:[^\s]+\/)?sed\s+-n\s+(['"]?)\d+(?:,\d+)?p\1\s+[^-\s]\S*$/.test(command)) action = '读取文件';
  if (!action) return ['执行命令'];
  return compound ? [action, '执行命令'] : [action];
}

function fallbackActions(message: Message): string[] {
  if (message.codex?.kind === 'memory') return ['引用记忆'];
  if (message.changes?.length) return ['修改文件'];
  const separator = ' · ';
  const index = message.text.indexOf(separator);
  const kind = index < 0 ? message.text : message.text.slice(0, index);
  if (kind === '命令') {
    const command = index < 0 ? '' : message.text.slice(index + separator.length);
    const status = command.lastIndexOf(separator);
    return commandActions(status > 0 ? command.slice(0, status) : command);
  }
  if (kind === '文件修改') return ['修改文件'];
  if (kind === '网页搜索') return ['搜索网页'];
  if (kind === '工具' || kind === '工具调用') {
    const name = index < 0 ? '' : message.text.slice(index + separator.length).split(separator, 1)[0];
    return [toolActions.get(name.split('__').at(-1) ?? '') ?? '调用工具'];
  }
  return [];
}

export function summarizeToolActivity(messages: readonly Message[]): string | undefined {
  const actions = new Set<string>();
  for (const message of messages) {
    const known = message.toolActions?.filter((action) => Object.hasOwn(actionLabels, action));
    if (known?.length && !(known.length === 1 && known[0] === 'run-command')) {
      for (const action of known) actions.add(actionLabels[action]);
    } else {
      const fallback = fallbackActions(message);
      for (const action of fallback.length ? fallback : (known?.map((kind) => actionLabels[kind]) ?? []))
        actions.add(action);
    }
  }
  return actions.size ? [...actions].join('、') : undefined;
}
