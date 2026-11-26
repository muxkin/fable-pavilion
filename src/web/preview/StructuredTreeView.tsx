import { shallowRef, type VNodeChild } from 'vue';
import { tsxComponent } from '../tsx-component';
import { writeRef } from '../render-effects';

const MAX_CHILDREN_PER_NODE = 200;

function primitiveSummary(value: unknown): { text: string; kind: string } {
  if (value === null) return { text: 'null', kind: 'null' };
  if (typeof value === 'boolean') return { text: String(value), kind: 'bool' };
  if (typeof value === 'number') return { text: String(value), kind: 'num' };
  if (typeof value === 'string') {
    const clipped = value.length > 240 ? `${value.slice(0, 240)}…` : value;
    return { text: JSON.stringify(clipped), kind: 'str' };
  }
  return { text: String(value), kind: 'other' };
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object';
}

export const StructuredTreeView = tsxComponent(function StructuredTreeView(_props: {
  value: unknown;
}) {
  const expandedState = shallowRef<Record<string, boolean>>({ $: true });
  const setExpanded = writeRef(expandedState);
  const filterState = shallowRef('');
  const setFilter = writeRef(filterState);
  const copiedPathState = shallowRef('');
  const setCopiedPath = writeRef(copiedPathState);

  return ({ value }) => {
    const expanded = expandedState.value;
    const query = filterState.value.trim().toLowerCase();

    function toggle(path: string, current: boolean) {
      setExpanded({ ...expanded, [path]: !current });
    }

    function setAllDepth(open: boolean) {
      if (!open) {
        setExpanded({ $: true });
        return;
      }
      const next: Record<string, boolean> = {};
      const walk = (node: unknown, path: string, depth: number) => {
        if (!isContainer(node) || depth > 5) return;
        next[path] = true;
        if (Array.isArray(node)) {
          node.slice(0, 60).forEach((item, idx) => walk(item, `${path}[${idx}]`, depth + 1));
        } else {
          Object.entries(node)
            .slice(0, 60)
            .forEach(([k, v]) => walk(v, `${path}.${k}`, depth + 1));
        }
      };
      walk(value, '$', 0);
      setExpanded(next);
    }

    function matchesQuery(key: string, node: unknown, depth = 0): boolean {
      if (!query) return true;
      if (key.toLowerCase().includes(query)) return true;
      if (!isContainer(node)) return String(node ?? 'null').toLowerCase().includes(query);
      if (depth > 4) return false;
      if (Array.isArray(node)) {
        return node.slice(0, 100).some((item, i) => matchesQuery(String(i), item, depth + 1));
      }
      return Object.entries(node)
        .slice(0, 100)
        .some(([k, v]) => matchesQuery(k, v, depth + 1));
    }

    async function copyNode(path: string, node: unknown) {
      try {
        const text = typeof node === 'string' ? node : JSON.stringify(node, null, 2);
        await navigator.clipboard.writeText(text);
        setCopiedPath(path);
        setTimeout(() => {
          if (copiedPathState.value === path) setCopiedPath('');
        }, 1600);
      } catch {
        /* ignore clipboard errors */
      }
    }

    function renderNode(label: string | null, node: unknown, path: string, depth: number): VNodeChild {
      if (query && label !== null && !matchesQuery(label, node)) return null;
      if (!isContainer(node)) {
        const { text, kind } = primitiveSummary(node);
        return (
          <div class="fp-tree-row" key={path}>
            {label !== null && <span class="fp-tree-key">{label}: </span>}
            <span class={`fp-tree-val fp-tree-${kind}`}>{text}</span>
            <button
              type="button"
              class="fp-tree-copy"
              title={`复制 ${path}`}
              onClick={() => void copyNode(path, node)}
            >
              {copiedPathState.value === path ? '已复制' : '复制'}
            </button>
          </div>
        );
      }
      const isArr = Array.isArray(node);
      const entries = isArr
        ? node.map((item, idx) => [String(idx), item] as const)
        : Object.entries(node);
      const isOpen = expanded[path] ?? (query ? true : depth < 1);
      const summary = isArr ? `Array(${entries.length})` : `Object(${entries.length})`;
      const visibleEntries = entries.slice(0, MAX_CHILDREN_PER_NODE);
      return (
        <div class="fp-tree-node" key={path}>
          <div class="fp-tree-row">
            <button
              type="button"
              class="fp-tree-toggle"
              aria-expanded={isOpen}
              onClick={() => toggle(path, isOpen)}
            >
              <span class="fp-tree-caret">{isOpen ? '▾' : '▸'}</span>
              {label !== null && <span class="fp-tree-key">{label}: </span>}
              <span class="fp-tree-meta">{summary}</span>
            </button>
            <button
              type="button"
              class="fp-tree-copy"
              title={`复制 ${path}`}
              onClick={() => void copyNode(path, node)}
            >
              {copiedPathState.value === path ? '已复制' : '复制'}
            </button>
          </div>
          {isOpen && (
            <div class="fp-tree-children">
              {visibleEntries.map(([k, v]) =>
                renderNode(k, v, isArr ? `${path}[${k}]` : `${path}.${k}`, depth + 1),
              )}
              {entries.length > MAX_CHILDREN_PER_NODE && (
                <div class="fp-tree-more">
                  … 还有 {entries.length - MAX_CHILDREN_PER_NODE} 项（可切换源码或下载查看全部）
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    return (
      <div class="fp-structured">
        <div class="fp-subbar">
          <input
            type="search"
            class="fp-filter-input"
            placeholder="过滤键名或值…"
            value={filterState.value}
            onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
          />
          <div class="fp-subbar-actions">
            <button type="button" onClick={() => setAllDepth(true)}>
              全部展开
            </button>
            <button type="button" onClick={() => setAllDepth(false)}>
              全部折叠
            </button>
          </div>
        </div>
        <div class="fp-tree-root">{renderNode(null, value, '$', 0)}</div>
      </div>
    );
  };
});
