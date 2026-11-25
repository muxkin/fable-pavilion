import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { watchRender, writeRef } from './render-effects';
import { remoteFetch } from './device-session';
import { Dialog } from './shell/Dialog';
import { Icon } from './Icon';
import './folder-picker-dialog.css';

export interface CreatedProject {
  id: string;
  name: string;
  path: string;
}

interface DirectoryEntry {
  name: string;
  path: string;
  isGit?: boolean;
}

interface DirectoryRoot {
  label: string;
  path: string;
}

interface DirectoryListing {
  path: string;
  parent: string | null;
  home: string | null;
  roots: DirectoryRoot[];
  entries: DirectoryEntry[];
  truncated?: boolean;
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || path || '项目';
}

export const FolderPickerDialog = tsxComponent(function FolderPickerDialog(_props: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: CreatedProject) => void;
}) {
  const listingState = shallowRef<DirectoryListing | null>(null);
  const setListing = writeRef(listingState);
  const loadingState = shallowRef(false);
  const setLoading = writeRef(loadingState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const filterState = shallowRef('');
  const setFilter = writeRef(filterState);
  const includeHiddenState = shallowRef(false);
  const setIncludeHidden = writeRef(includeHiddenState);
  const mkdirOpenState = shallowRef(false);
  const setMkdirOpen = writeRef(mkdirOpenState);
  const mkdirNameState = shallowRef('');
  const setMkdirName = writeRef(mkdirNameState);
  const mkdirBusyState = shallowRef(false);
  const setMkdirBusy = writeRef(mkdirBusyState);
  const projectNameState = shallowRef('');
  const setProjectName = writeRef(projectNameState);
  const customNameState = shallowRef(false);
  const setCustomName = writeRef(customNameState);
  const savingState = shallowRef(false);
  const setSaving = writeRef(savingState);
  const watchOpen = watchRender();
  const requestSeq = { current: 0 };

  return ({ open, onClose, onCreated }) => {
    const listing = listingState.value;
    const loading = loadingState.value;
    const error = errorState.value;
    const filter = filterState.value;
    const includeHidden = includeHiddenState.value;
    const mkdirOpen = mkdirOpenState.value;
    const mkdirName = mkdirNameState.value;
    const mkdirBusy = mkdirBusyState.value;
    const projectName = projectNameState.value;
    const saving = savingState.value;

    async function load(targetPath?: string, hidden = includeHiddenState.value) {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError('');
      try {
        const res = await remoteFetch('/api/fs/directories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(targetPath ? { path: targetPath } : {}),
            includeHidden: hidden,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Error(data.error || '无法读取电脑文件夹');
        if (seq !== requestSeq.current) return;
        const next = data as DirectoryListing;
        setListing(next);
        setFilter('');
        if (!customNameState.value) {
          setProjectName(basenameOf(next.path));
        }
      } catch (e) {
        if (seq === requestSeq.current) {
          setError((e as Error).message || '无法读取电脑文件夹');
        }
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }

    watchOpen(() => {
      if (!open) return;
      setCustomName(false);
      setProjectName('');
      setFilter('');
      setMkdirOpen(false);
      setMkdirName('');
      setError('');
      void load(listingState.value?.path, includeHiddenState.value);
    }, [open]);

    if (!open) return null;

    const currentPath = listing?.path ?? '';
    const trimmedFilter = filter.trim().toLowerCase();
    const visibleEntries = (listing?.entries ?? []).filter((entry) =>
      trimmedFilter ? entry.name.toLowerCase().includes(trimmedFilter) : true,
    );

    async function handleCreateFolder(event: Event) {
      event.preventDefault();
      const name = mkdirNameState.value.trim();
      if (!currentPath || !name || mkdirBusyState.value) return;
      setMkdirBusy(true);
      setError('');
      try {
        const res = await remoteFetch('/api/fs/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parent: currentPath, name }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Error(data.error || '创建文件夹失败');
        setMkdirOpen(false);
        setMkdirName('');
        setCustomName(false);
        await load(data.path, includeHiddenState.value);
      } catch (e) {
        setError((e as Error).message || '创建文件夹失败');
      } finally {
        setMkdirBusy(false);
      }
    }

    async function handleConfirm() {
      if (!currentPath || savingState.value) return;
      setSaving(true);
      setError('');
      try {
        const res = await remoteFetch('/api/projects/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: currentPath,
            name: projectNameState.value.trim() || undefined,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Error(data.error || '添加项目失败');
        if (!data.project?.id) throw Error('添加项目失败');
        onCreated(data.project as CreatedProject);
        onClose();
      } catch (e) {
        setError((e as Error).message || '添加项目失败');
      } finally {
        setSaving(false);
      }
    }

    return (
      <Dialog
        title="选择电脑文件夹"
        titleIcon={<Icon name="folderPlus" size={18} />}
        className="folder-picker-dialog"
        onClose={onClose}
      >
        <div class="folder-picker">
          {!!listing?.roots.length && (
            <div class="folder-picker-roots" aria-label="常用目录">
              {listing.roots.map((root) => (
                <button
                  key={root.path}
                  type="button"
                  class={`folder-root-chip${currentPath === root.path ? ' active' : ''}`}
                  disabled={loading}
                  onClick={() => {
                    setCustomName(false);
                    void load(root.path);
                  }}
                >
                  {root.label}
                </button>
              ))}
            </div>
          )}

          <div class="folder-picker-bar">
            <button
              type="button"
              class="secondary folder-bar-btn"
              disabled={loading || !listing?.parent}
              onClick={() => {
                if (!listing?.parent) return;
                setCustomName(false);
                void load(listing.parent);
              }}
            >
              <Icon name="up" size={16} />
              <span>上级目录</span>
            </button>
            <button
              type="button"
              class="secondary folder-bar-btn"
              disabled={loading || !currentPath}
              onClick={() => {
                setMkdirOpen((v) => !v);
                setError('');
              }}
            >
              <Icon name="folderPlus" size={16} />
              <span>新建文件夹</span>
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="刷新目录"
              title="刷新目录"
              disabled={loading}
              onClick={() => void load(currentPath || undefined)}
            >
              <Icon name="refresh" size={16} />
            </button>
          </div>

          <div class="folder-picker-path" title={currentPath}>
            <span>当前位置</span>
            <code>{currentPath || '正在读取电脑目录…'}</code>
          </div>

          {mkdirOpen && (
            <form class="folder-mkdir-form" onSubmit={(e) => void handleCreateFolder(e)}>
              <input
                type="text"
                placeholder="输入新文件夹名称"
                aria-label="新文件夹名称"
                maxlength={120}
                value={mkdirName}
                disabled={mkdirBusy}
                onInput={(e) => setMkdirName((e.currentTarget as HTMLInputElement).value)}
              />
              <button type="submit" disabled={mkdirBusy || !mkdirName.trim()}>
                {mkdirBusy ? '创建中…' : '创建'}
              </button>
            </form>
          )}

          <div class="folder-picker-filter">
            <label class="search-field folder-filter-input">
              <Icon name="search" size={16} />
              <input
                type="search"
                aria-label="筛选当前目录文件夹"
                placeholder="筛选当前目录下的文件夹"
                value={filter}
                onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label class="folder-hidden-toggle">
              <input
                type="checkbox"
                checked={includeHidden}
                disabled={loading}
                onChange={(e) => {
                  const next = (e.currentTarget as HTMLInputElement).checked;
                  setIncludeHidden(next);
                  void load(currentPath || undefined, next);
                }}
              />
              <span>显示隐藏文件夹</span>
            </label>
          </div>

          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}

          <div class="folder-picker-list" role="list" aria-label="子文件夹列表">
            {loading && !listing ? (
              <p class="hint">正在读取电脑目录…</p>
            ) : !visibleEntries.length ? (
              <p class="hint">
                {trimmedFilter ? '当前目录下没有匹配的文件夹' : '此文件夹下没有子文件夹，可直接选择当前位置或新建文件夹'}
              </p>
            ) : (
              visibleEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  role="listitem"
                  class="folder-entry"
                  disabled={loading}
                  onClick={() => {
                    setCustomName(false);
                    void load(entry.path);
                  }}
                >
                  <Icon name="folder" size={18} />
                  <span class="folder-entry-name">{entry.name}</span>
                  {entry.isGit && <span class="folder-git-badge">Git</span>}
                  <Icon name="chevron" size={16} />
                </button>
              ))
            )}
            {listing?.truncated && <p class="hint">仅显示前 500 个子文件夹，可使用筛选快速定位。</p>}
          </div>

          <div class="folder-picker-footer">
            <label class="folder-name-field">
              <span>项目名称</span>
              <input
                type="text"
                aria-label="项目名称"
                placeholder="默认使用当前文件夹名"
                maxlength={120}
                value={projectName}
                disabled={saving || !currentPath}
                onInput={(e) => {
                  setCustomName(true);
                  setProjectName((e.currentTarget as HTMLInputElement).value);
                }}
              />
            </label>
            <div class="folder-picker-actions">
              <button type="button" class="secondary" onClick={onClose} disabled={saving}>
                取消
              </button>
              <button
                type="button"
                disabled={saving || loading || !currentPath}
                onClick={() => void handleConfirm()}
              >
                {saving ? '添加中…' : '选择此文件夹'}
              </button>
            </div>
          </div>
        </div>
      </Dialog>
    );
  };
});
