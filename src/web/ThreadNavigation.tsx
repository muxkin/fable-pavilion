import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { writeRef, watchRender } from './render-effects';
import { remoteFetch } from './device-session';
import type { ProjectSummary, ThreadSummary } from '../shared/types';
import { Icon } from './Icon';
import type { BackendInfo } from '../shared/backends';
import { backendAppearanceDefaults } from '../shared/backend-appearance';
import { BackendIcon } from './BackendIcon';
import { appPixels, appViewport } from './shell/app-zoom';
import './thread-navigation.css';
type Page = { threads: ThreadSummary[]; nextCursor: string | null };
type ProjectOrder = 'default' | 'activity' | 'name';
const projectOrderKey = 'pocket-project-order';
const projectNames = new Intl.Collator('zh-CN', { numeric: true });

function savedProjectOrder(): ProjectOrder {
  try {
    const value = localStorage.getItem(projectOrderKey);
    if (value === 'activity' || value === 'name') return value;
  } catch {}
  return 'default';
}

export const ThreadNavigation = tsxComponent(function ThreadNavigation(_props: {
  panelId: string;
  projects: { projects: ProjectSummary[]; total: number; ungrouped: number };
  threads: ThreadSummary[];
  cursor: string | null;
  selected: ThreadSummary | null;
  online: boolean;
  active: boolean;
  loading: boolean;
  onSelect: (t: ThreadSummary) => void;
  onRefresh: () => void;
  onMore: () => void;
  onCreate: (projectId?: string) => void;
  pendingQuestions: number;
  agentName?: string;
  backend?: BackendInfo;
  onWorkbench?: () => void;
  canCreate?: boolean;
  canCreateProject?: boolean;
  onCreateProject?: () => void;
  canRename?: boolean;
  canFork?: boolean;
  canExportLog?: boolean;
  onRenameThread?: (t: ThreadSummary) => void;
  onForkThread?: (t: ThreadSummary) => void;
  onExportThread?: (t: ThreadSummary) => void;
  onReloadThread?: (t: ThreadSummary) => void;
}) {
  const tabState = shallowRef<'recent' | 'projects'>('recent');
  const setTab = writeRef(tabState);
  const orderState = shallowRef(savedProjectOrder());
  const activityState = shallowRef(new Map<string, number>());
  const queryState = shallowRef('');
  const setQuery = writeRef(queryState);
  const searchState = shallowRef('');
  const setSearch = writeRef(searchState);
  const expandedState = shallowRef(new Set<string>());
  const setExpanded = writeRef(expandedState);
  const pagesState = shallowRef<Record<string, Page>>({});
  const setPages = writeRef(pagesState);
  const searchPageState = shallowRef<Page>();
  const setSearchPage = writeRef(searchPageState);
  const searchingState = shallowRef(false);
  const setSearching = writeRef(searchingState);
  const busyState = shallowRef(new Set<string>());
  const setBusy = writeRef(busyState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const menuState = shallowRef<{ x: number; y: number; thread: ThreadSummary | null } | null>(null);
  const menuRef = shallowRef<HTMLDivElement | null>(null);
  const generation = { current: 0 };
  const searchGeneration = { current: 0 };
  const watchTimeout = watchRender();
  const watchSearchPage = watchRender();
  const watchPages = watchRender();
  const watchExpanded = watchRender();
  const watchActivity = watchRender();
  const watchRecentActivity = watchRender();
  const watchContextMenu = watchRender();
  return ({
    panelId,
    projects,
    threads,
    cursor,
    selected,
    online,
    active,
    loading,
    onSelect,
    onRefresh,
    onMore,
    onCreate,
    pendingQuestions,
    agentName = 'Codex',
    backend,
    onWorkbench,
    canCreate,
    canCreateProject,
    onCreateProject,
    canRename,
    canFork,
    canExportLog,
    onRenameThread,
    onForkThread,
    onExportThread,
    onReloadThread,
  }) => {
    const tab = tabState.value;
    const query = queryState.value;
    const search = searchState.value;
    const expanded = expandedState.value;
    const pages = pagesState.value;
    const searchPage = searchPageState.value;
    const searching = searchingState.value;
    const busy = busyState.value;
    const error = errorState.value;
    const order = orderState.value;
    const menu = menuState.value;
    const closeMenu = () => {
      menuState.value = null;
    };
    function openContextMenu(event: MouseEvent, thread: ThreadSummary | null) {
      event.preventDefault();
      event.stopPropagation();
      const menuWidth = 200;
      const estimatedHeight = thread ? 280 : 140;
      const margin = 8;
      const viewport = appViewport();
      const x = Math.max(
        viewport.left + margin,
        Math.min(appPixels(event.clientX), viewport.right - menuWidth - margin),
      );
      const y = Math.max(
        viewport.top + margin,
        Math.min(appPixels(event.clientY), viewport.bottom - estimatedHeight - margin),
      );
      menuState.value = { x, y, thread };
    }
    watchContextMenu(() => {
      if (!menu) return;
      const onPointerDown = (event: PointerEvent) => {
        if (menuRef.value && event.target instanceof Node && menuRef.value.contains(event.target)) return;
        closeMenu();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') closeMenu();
      };
      const onDismiss = () => closeMenu();
      window.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', onDismiss);
      window.addEventListener('blur', onDismiss);
      window.addEventListener('scroll', onDismiss, true);
      return () => {
        window.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('resize', onDismiss);
        window.removeEventListener('blur', onDismiss);
        window.removeEventListener('scroll', onDismiss, true);
      };
    }, [!!menu]);

    watchRecentActivity(() => {
      if (order !== 'activity') return;
      const next = new Map(activityState.value);
      for (const { projectId, updatedAt } of threads)
        if (projectId && updatedAt > (next.get(projectId) ?? 0)) next.set(projectId, updatedAt);
      if (
        next.size !== activityState.value.size ||
        [...next].some(([id, time]) => activityState.value.get(id) !== time)
      )
        activityState.value = next;
    }, [threads, order]);
    watchActivity(() => {
      if (!active || !online || tab !== 'projects' || order !== 'activity') return;
      const controller = new AbortController();
      const { signal } = controller;
      // The catalog has counts; each project's first page has its latest activity.
      const known = new Set(threads.map((thread) => thread.projectId));
      const missing = projects.projects.filter((project) => project.count > 0 && !known.has(project.id));
      const update = async () => {
        const latest = new Map<string, number>();
        for (let offset = 0; offset < missing.length && !signal.aborted; offset += 3) {
          await Promise.allSettled(
            missing.slice(offset, offset + 3).map(async ({ id }) => {
              const response = await remoteFetch(`/api/threads?${new URLSearchParams({ project: id })}`, {
                signal,
              });
              if (!response.ok) return;
              const page: Page = await response.json();
              latest.set(id, page.threads[0]?.updatedAt ?? 0);
            }),
          );
        }
        if (!signal.aborted && latest.size) {
          activityState.value = new Map([...activityState.value, ...latest]);
        }
      };
      void update();
      return () => controller.abort();
    }, [active, online, tab, order, projects]);

    function changeOrder(value: ProjectOrder) {
      orderState.value = value;
      try {
        localStorage.setItem(projectOrderKey, value);
      } catch {}
    }

    watchTimeout(() => {
      const timer = setTimeout(() => setSearch(query.trim()), 250);
      return () => clearTimeout(timer);
    }, [query]);
    watchSearchPage(() => {
      searchGeneration.current++;
      if (!search) {
        setSearchPage(undefined);
        return;
      }
      const controller = new AbortController();
      setSearching(true);
      remoteFetch(`/api/threads?q=${encodeURIComponent(search)}`, { signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) throw Error('搜索失败，请重试');
          return r.json();
        })
        .then(setSearchPage)
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
      return () => controller.abort();
    }, [search]);
    // New server catalog invalidates group pages only on explicit refresh, not on every render.
    watchPages(() => {
      generation.current++;
      setPages({});
      setBusy(new Set());
    }, [projects]);
    async function loadGroup(id: string, next?: string) {
      if (busy.has(id)) return;
      const epoch = generation.current;
      setBusy((old) => new Set(old).add(id));
      setError('');
      try {
        const q = new URLSearchParams({ project: id });
        if (next) q.set('cursor', next);
        const r = await remoteFetch(`/api/threads?${q}`);
        if (!r.ok) throw Error('项目会话加载失败');
        const data: Page = await r.json();
        if (epoch === generation.current)
          setPages((old) => ({
            ...old,
            [id]: { ...data, threads: next ? [...(old[id]?.threads ?? []), ...data.threads] : data.threads },
          }));
      } catch (e) {
        if (epoch === generation.current) setError((e as Error).message);
      } finally {
        if (epoch === generation.current)
          setBusy((old) => {
            const next = new Set(old);
            next.delete(id);
            return next;
          });
      }
    }
    watchExpanded(() => {
      for (const id of expanded) if (!pages[id] && !busy.has(id)) void loadGroup(id);
    }, [expanded, pages, projects]);
    function toggle(id: string) {
      setExpanded((old) => {
        const next = new Set(old);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }
    async function moreSearch() {
      if (!searchPage?.nextCursor) return;
      const epoch = searchGeneration.current;
      const current = search;
      setSearching(true);
      try {
        const r = await remoteFetch(
          `/api/threads?${new URLSearchParams({ q: current, cursor: searchPage.nextCursor })}`,
        );
        if (!r.ok) throw Error('搜索失败，请重试');
        const data: Page = await r.json();
        if (epoch !== searchGeneration.current) return;
        setSearchPage((old) => ({ ...data, threads: [...(old?.threads ?? []), ...data.threads] }));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        if (epoch === searchGeneration.current) setSearching(false);
      }
    }
    const rows = (items: ThreadSummary[], grouped = false) =>
      items.map((t) => (
        <button
          key={t.id}
          class={`thread-button ${selected?.id === t.id ? 'selected' : ''}${menu?.thread?.id === t.id ? ' context-active' : ''}`}
          onClick={() => onSelect(t)}
          onContextmenu={(event: MouseEvent) => openContextMenu(event, t)}
        >
          {grouped && <span class="thread-node" />}
          <span class="thread-label">
            <strong>{t.title || '未命名会话'}</strong>
            <small>
              {grouped
                ? t.cwd.split(/[\\/]/).filter(Boolean).at(-1) || '本地会话'
                : (t.projectName ?? '未分类')}
            </small>
          </span>
          <span class="thread-meta">
            <time>{relativeTime(t.updatedAt)}</time>
            {t.id === selected?.id && pendingQuestions > 0 && <small class="awaiting">待回答</small>}
          </span>
        </button>
      ));
    const activity = activityState.value;
    const latestByProject = new Map<string, number>();
    for (const thread of threads) {
      if (thread.projectId && !latestByProject.has(thread.projectId))
        latestByProject.set(thread.projectId, thread.updatedAt);
    }
    const latest = (project: ProjectSummary) =>
      latestByProject.get(project.id) ?? (project.count ? (activity.get(project.id) ?? 0) : 0);
    const groups = [...projects.projects];
    if (order === 'name') groups.sort((a, b) => projectNames.compare(a.name, b.name));
    if (order === 'activity')
      groups.sort((a, b) => latest(b) - latest(a) || projectNames.compare(a.name, b.name));
    groups.push({ id: 'none', name: '未分类', count: projects.ungrouped });
    return (
      <aside id={panelId} class="sidebar">
        <header class="sidebar-head">
          <div class="workspace-heading">
            {onWorkbench && (
              <button
                class="workspace-back"
                type="button"
                aria-label="返回工作台"
                title="返回工作台"
                onClick={onWorkbench}
              >
                <Icon name="back" size={22} />
              </button>
            )}
            <h1>工作台</h1>
          </div>
          <button
            class="new-thread-button"
            disabled={canCreate === undefined ? !threads.length && !selected : !canCreate}
            onClick={() => onCreate([...expanded].find((id) => id !== 'none'))}
          >
            <Icon name="plusCircle" size={20} />
            新会话
          </button>
        </header>
        <div class="workspace-tool">
          <BackendIcon
            icon={
              backend
                ? (backend.appearance ?? backendAppearanceDefaults(backend)).icon
                : { kind: 'builtin', value: 'puzzle' }
            }
            product={backend?.product}
          />
          <div>
            <strong>{agentName}</strong>
            <span>项目与任务</span>
          </div>
        </div>
        <label class="search-field nav-search">
          <Icon name="search" size={20} />
          <input
            type="search"
            aria-label="搜索项目或会话"
            placeholder="搜索项目或会话"
            maxlength={120}
            value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <div class="nav-tabs">
          <div role="tablist" aria-label="会话视图">
            <button role="tab" aria-selected={tab === 'recent'} onClick={() => setTab('recent')}>
              最近
            </button>
            <button role="tab" aria-selected={tab === 'projects'} onClick={() => setTab('projects')}>
              项目
            </button>
          </div>
          {tab === 'projects' && (
            <select
              class="project-order"
              aria-label="项目排序"
              value={order}
              onChange={(event) =>
                changeOrder((event.currentTarget as HTMLSelectElement).value as ProjectOrder)
              }
            >
              <option value="default">默认顺序</option>
              <option value="activity">最近活动</option>
              <option value="name">项目名称</option>
            </select>
          )}
          <button
            type="button"
            class="icon-button refresh-list"
            aria-label="刷新会话列表"
            aria-busy={loading}
            title="刷新会话列表"
            disabled={loading}
            onClick={onRefresh}
          >
            <Icon name="refresh" size={18} />
          </button>
        </div>
        <nav aria-label="会话列表" onContextmenu={(event: MouseEvent) => openContextMenu(event, null)}>
          {error && (
            <p role="alert" class="error">
              {error}
            </p>
          )}
          {search ? (
            <>
              {searching && (
                <p class="list-label" role="status">
                  正在搜索…
                </p>
              )}
              {!searching && !searchPage?.threads.length && <p class="list-label">没有匹配的项目或会话</p>}
              {rows(searchPage?.threads ?? [])}
              {searchPage?.nextCursor && (
                <button class="secondary more" disabled={searching} onClick={() => void moreSearch()}>
                  更多搜索结果
                </button>
              )}
            </>
          ) : tab === 'recent' ? (
            <>
              {loading && (
                <p class="list-label" role="status">
                  正在加载…
                </p>
              )}
              {rows(threads)}
              {!loading && !threads.length && <p class="list-label">暂无会话</p>}
              {cursor && (
                <button class="secondary more" disabled={loading} onClick={onMore}>
                  加载更多会话
                </button>
              )}
            </>
          ) : (
            <>
              {canCreateProject && onCreateProject && (
                <button
                  type="button"
                  class="new-project-row"
                  disabled={!online}
                  onClick={onCreateProject}
                >
                  <Icon name="folderPlus" size={20} />
                  <span>新建项目（选择电脑文件夹）</span>
                </button>
              )}
              {groups.map((p) => (
              <section class="project-group" key={p.id}>
                <button
                  class="project-heading"
                  aria-expanded={expanded.has(p.id)}
                  onClick={() => toggle(p.id)}
                >
                  <Icon name={expanded.has(p.id) ? 'down' : 'chevron'} size={17} />
                  <Icon name={p.id === 'none' ? 'stack' : 'folder'} size={23} />
                  <strong>{p.name}</strong>
                  <span>{p.count}</span>
                </button>
                {expanded.has(p.id) && (
                  <div class="project-threads">
                    {rows(pages[p.id]?.threads ?? [], true)}
                    {busy.has(p.id) && (
                      <p class="list-label" role="status">
                        正在加载…
                      </p>
                    )}
                    {!busy.has(p.id) && pages[p.id]?.threads.length === 0 && (
                      <p class="list-label">此项目暂无会话</p>
                    )}
                    {pages[p.id]?.nextCursor && (
                      <button
                        class="secondary more"
                        onClick={() => void loadGroup(p.id, pages[p.id].nextCursor!)}
                        disabled={busy.has(p.id)}
                      >
                        加载更多会话
                      </button>
                    )}
                  </div>
                )}
              </section>
            ))}
            </>
          )}
        </nav>
        {menu && (
          <div
            ref={menuRef}
            class="thread-context-menu"
            role="menu"
            aria-label={menu.thread ? '会话操作菜单' : '会话列表菜单'}
            style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
            onContextmenu={(event: MouseEvent) => event.preventDefault()}
          >
            {menu.thread ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const target = menu.thread!;
                    closeMenu();
                    if (selected?.id === target.id && onReloadThread) onReloadThread(target);
                    else onSelect(target);
                  }}
                >
                  <Icon name={selected?.id === menu.thread.id ? 'refresh' : 'chat'} size={15} />
                  <span>{selected?.id === menu.thread.id ? '重新加载会话' : '打开会话'}</span>
                </button>
                {canRename && onRenameThread && menu.thread.id !== 'new' && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!online}
                    onClick={() => {
                      const target = menu.thread!;
                      closeMenu();
                      onRenameThread(target);
                    }}
                  >
                    <Icon name="document" size={15} />
                    <span>会话改名</span>
                  </button>
                )}
                {canFork && onForkThread && menu.thread.id !== 'new' && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!online}
                    onClick={() => {
                      const target = menu.thread!;
                      closeMenu();
                      onForkThread(target);
                    }}
                  >
                    <Icon name="branch" size={15} />
                    <span>创建会话分支</span>
                  </button>
                )}
                {canExportLog && onExportThread && menu.thread.id !== 'new' && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!online}
                    onClick={() => {
                      const target = menu.thread!;
                      closeMenu();
                      onExportThread(target);
                    }}
                  >
                    <Icon name="download" size={15} />
                    <span>{backend?.product === 'antigravity' ? '导出会话日志' : '下载日志 ZIP'}</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const title = menu.thread!.title || '未命名会话';
                    closeMenu();
                    void navigator.clipboard?.writeText(title).catch(() => {});
                  }}
                >
                  <Icon name="copy" size={15} />
                  <span>复制会话标题</span>
                </button>
                <div class="thread-context-divider" role="separator" />
                {canCreate && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const projectId = menu.thread?.projectId ?? undefined;
                      closeMenu();
                      onCreate(projectId);
                    }}
                  >
                    <Icon name="plusCircle" size={15} />
                    <span>在此项目新建会话</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  disabled={loading}
                  onClick={() => {
                    closeMenu();
                    onRefresh();
                  }}
                >
                  <Icon name="refresh" size={15} />
                  <span>刷新会话列表</span>
                </button>
              </>
            ) : (
              <>
                {canCreate && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMenu();
                      onCreate([...expanded].find((id) => id !== 'none'));
                    }}
                  >
                    <Icon name="plusCircle" size={15} />
                    <span>新建会话</span>
                  </button>
                )}
                {canCreateProject && onCreateProject && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!online}
                    onClick={() => {
                      closeMenu();
                      onCreateProject();
                    }}
                  >
                    <Icon name="folderPlus" size={15} />
                    <span>新建项目</span>
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  disabled={loading}
                  onClick={() => {
                    closeMenu();
                    onRefresh();
                  }}
                >
                  <Icon name="refresh" size={15} />
                  <span>刷新会话列表</span>
                </button>
                <div class="thread-context-divider" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    setTab(tab === 'recent' ? 'projects' : 'recent');
                  }}
                >
                  <Icon name={tab === 'recent' ? 'folder' : 'clock'} size={15} />
                  <span>{tab === 'recent' ? '按项目分组查看' : '按最近会话查看'}</span>
                </button>
              </>
            )}
          </div>
        )}
      </aside>
    );
  };
});
function relativeTime(ms: number) {
  if (!ms || ms <= 0) return '';
  const date = new Date(ms);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
