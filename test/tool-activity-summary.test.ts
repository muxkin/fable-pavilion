import { expect, it } from 'vitest';
import { summarizeToolActivity } from '../src/web/tool-activity-summary';
import type { Message } from '../src/shared/types';

function activities(...previews: string[]): Message[] {
  return previews.map((text, index) => ({ id: String(index), role: 'tool', text }));
}

it('shows deduplicated action types in first-seen order without copying command arguments', () => {
  const messages = activities(
    "命令 · /bin/bash -lc 'cat fixture.txt' · inProgress",
    '工具 · mcp__filesystem__read_file · completed',
    '命令 · python fixture.py · failed',
    '网页搜索 · 已记录',
    '命令 · head -n 10 another.txt · completed',
  );
  expect(summarizeToolActivity(messages)).toBe('读取文件、执行命令、搜索网页');
});

it('recognizes file, web and tool names from native and older transcript entries', () => {
  expect(
    summarizeToolActivity(
      activities(
        '工具调用 · tool_search',
        '工具结果 · function_call_output',
        '工具调用 · web_search_call',
        '工具 · fileChange · completed',
        '工具 · example_opaque · completed',
      ),
    ),
  ).toBe('查找工具、搜索网页、修改文件、调用工具');
});

it('keeps complex or indeterminate commands generic and tolerates unknown older records', () => {
  expect(
    summarizeToolActivity(
      activities(
        '命令 · cat file.txt > other.txt · completed',
        "命令 · /bin/sh -c 'node verify.js && ls' · completed",
        "命令 · sed -n '1p' file.txt -i · completed",
        '命令 · cat --help · completed',
      ),
    ),
  ).toBe('执行命令');
  expect(summarizeToolActivity(activities('未分类活动', '工具结果 · function_call_output'))).toBeUndefined();
});

it('separates simple file search and directory listing from reading a file', () => {
  expect(
    summarizeToolActivity(
      activities(
        '命令 · rg --files · completed',
        '命令 · ls · completed',
        '命令 · grep pattern file · completed',
        "命令 · sed -n '1,9p' x · completed",
      ),
    ),
  ).toBe('查找文件、搜索文件、读取文件');
});

it('uses typed operations from within a single command and distinguishes web searches and page actions', () => {
  const messages = activities(
    '命令 · arbitrary script · completed',
    '网页搜索 · 已记录',
    '网页搜索 · 已记录',
  );
  messages[0].toolActions = ['list-files', 'read-file', 'search-files', 'run-command'];
  messages[1].toolActions = ['open-page', 'find-in-page'];
  messages[2].toolActions = ['web-search'];
  expect(summarizeToolActivity(messages)).toBe(
    '查找文件、读取文件、搜索文件、执行命令、浏览网页、在网页中查找、搜索网页',
  );
});

it('keeps recognizable simple operations when Codex reports a generic command', () => {
  const messages = activities(
    '命令 · /bin/zsh -lc tail -n 5 results.txt · completed',
    '命令 · /bin/bash -lc curl -fsS https://example.test/health · completed',
    '命令 · node verify.mjs · completed',
  );
  for (const message of messages) message.toolActions = ['run-command'];
  expect(summarizeToolActivity(messages)).toBe('读取文件、请求网络资源、执行命令');
});

it('shows verified leading operations in compound shell previews and leaves other steps generic', () => {
  const messages = activities(
    '命令 · /bin/zsh -lc tail -n 5 results.txt; node verify.mjs · completed',
    '命令 · /bin/zsh -lc rg FIXTURE .; sed -n 5p notes.md; git status · completed',
    '命令 · /bin/zsh -lc cat "literal; in a filename.txt" && do_something · completed',
  );
  for (const message of messages) message.toolActions = ['run-command'];
  expect(summarizeToolActivity(messages)).toBe('读取文件、执行命令、搜索文件');
});
