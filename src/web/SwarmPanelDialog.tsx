import { tsxComponent } from './tsx-component';
import { shallowRef, onScopeDispose } from 'vue';
import { watchRender, writeRef } from './render-effects';
import { deviceSession } from './device-session';
import type { Message } from '../shared/types';
import { Dialog } from './shell/Dialog';
import { Icon } from './Icon';
import RichMessage from './RichMessage';
import { TranscriptMessages } from './TranscriptMessages';
import { SwarmAccessProvider, type SwarmTab } from './SwarmAccess';
import './swarm-panel.css';

export interface SwarmMemberSummary {
  name: string;
  role: string;
  model: string;
  workspaceMode?: string;
  wakeMode?: string;
  status: 'working' | 'waiting' | 'killed';
  killed: boolean;
  posts: number;
  unread: number;
  steps: number;
  activity?: string | null;
  failed?: boolean;
  lastPostSeq?: number | null;
  lastPostTime?: string | null;
  lastActivityAt?: string | null;
  task?: string | null;
  hasConversation: boolean;
}

export interface SwarmBoardMessage {
  seq: number;
  agent: string;
  text: string;
  time: string;
  kind?: string | null;
  mentions: string[];
  all: boolean;
}

export interface SwarmPlan {
  goal?: { title: string; line: string } | null;
  tasks?: Record<string, string>;
  threads?: { id: string; title: string; goal: string; tasks: string[] }[];
}

export interface SwarmOverview {
  headline?: string;
  asOfSeq?: number | null;
  updatedAt?: string | null;
  phase?: { label?: string; index?: number; total?: number } | null;
  attention?: { id?: string; kind?: string; severity?: string; title?: string; why?: string }[];
  workstreams?: { id?: string; title?: string; owners?: string[]; state?: string; note?: string }[];
  milestones?: { id?: string; text?: string }[];
  risks?: { id?: string; text?: string }[];
}

export interface SwarmSnapshot {
  id: string;
  title: string;
  createdAt?: string | null;
  head: number;
  truncated?: boolean;
  counts: { working: number; waiting: number; killed: number; total: number };
  plan?: SwarmPlan | null;
  overview?: SwarmOverview | null;
  members: SwarmMemberSummary[];
  messages: SwarmBoardMessage[];
}

export interface SwarmMemberTrajectory {
  member: {
    name: string;
    role: string;
    model: string;
    status: 'working' | 'waiting' | 'killed';
    steps: number;
    activity?: string | null;
    failed?: boolean;
    task?: string | null;
  };
  runtimeStatus: string;
  source: 'daemon' | 'transcript';
  messages: Message[];
}

const POLL_MS = 5000;
const COLLAPSE_THRESHOLD = 1400;

function statusLabel(status: string): string {
  if (status === 'working') return '工作中';
  if (status === 'waiting') return '等待中';
  return '已结束';
}

function roleLabel(role: string): string {
  if (role === 'coordinator') return '协调者';
  if (role === 'narrator') return '播报员';
  if (role === 'monitor') return '监控员';
  return 'Worker';
}

export default tsxComponent(function SwarmPanelDialog(_props: {
  threadId: string;
  backendId: string;
  online: boolean;
  initialTab?: SwarmTab;
  initialMember?: string;
  onClose: () => void;
}) {
  const swarmState = shallowRef<SwarmSnapshot | null>(null);
  const setSwarm = writeRef(swarmState);
  const loadingState = shallowRef(true);
  const setLoading = writeRef(loadingState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const tabState = shallowRef<SwarmTab>('board');
  const setTab = writeRef(tabState);
  const searchState = shallowRef('');
  const setSearch = writeRef(searchState);
  const agentFilterState = shallowRef<string>('');
  const setAgentFilter = writeRef(agentFilterState);
  const showKilledState = shallowRef(false);
  const setShowKilled = writeRef(showKilledState);
  const expandedPostsState = shallowRef<Record<number, boolean>>({});
  const setExpandedPosts = writeRef(expandedPostsState);

  const selectedMemberState = shallowRef<string | null>(null);
  const setSelectedMember = writeRef(selectedMemberState);
  const memberDataState = shallowRef<SwarmMemberTrajectory | null>(null);
  const setMemberData = writeRef(memberDataState);
  const memberLoadingState = shallowRef(false);
  const setMemberLoading = writeRef(memberLoadingState);
  const memberErrorState = shallowRef('');
  const setMemberError = writeRef(memberErrorState);

  const watchInit = watchRender();
  const watchPoll = watchRender();
  const watchMember = watchRender();
  const requestSeq = { current: 0 };
  const memberSeq = { current: 0 };
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  onScopeDispose(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  return ({ threadId, backendId, online, initialTab, initialMember, onClose }) => {
    const swarm = swarmState.value;
    const loading = loadingState.value;
    const error = errorState.value;
    const tab = tabState.value;
    const search = searchState.value;
    const agentFilter = agentFilterState.value;
    const showKilled = showKilledState.value;
    const expandedPosts = expandedPostsState.value;
    const selectedMember = selectedMemberState.value;
    const memberData = memberDataState.value;
    const memberLoading = memberLoadingState.value;
    const memberError = memberErrorState.value;

    async function loadSwarm(silent = false) {
      const seq = ++requestSeq.current;
      if (!silent) setLoading(true);
      try {
        const res = await deviceSession.api<{ swarm: SwarmSnapshot | null }>(
          `/threads/${encodeURIComponent(threadId)}/swarm`,
          undefined,
          backendId,
        );
        if (seq !== requestSeq.current) return;
        setSwarm(res.swarm ?? null);
        setError('');
      } catch (e) {
        if (seq !== requestSeq.current) return;
        setError((e as Error).message || '无法读取 Swarm 面板');
      } finally {
        if (seq === requestSeq.current && !silent) setLoading(false);
      }
    }

    async function loadMember(name: string, silent = false) {
      const seq = ++memberSeq.current;
      if (!silent) {
        setMemberLoading(true);
        setMemberError('');
      }
      try {
        const res = await deviceSession.api<SwarmMemberTrajectory>(
          `/threads/${encodeURIComponent(threadId)}/swarm/member?member=${encodeURIComponent(name)}`,
          undefined,
          backendId,
        );
        if (seq !== memberSeq.current) return;
        setMemberData(res);
        setMemberError('');
      } catch (e) {
        if (seq !== memberSeq.current) return;
        setMemberError((e as Error).message || '无法读取成员对话轨迹');
      } finally {
        if (seq === memberSeq.current && !silent) setMemberLoading(false);
      }
    }

    function openMember(name: string) {
      setSelectedMember(name);
      setMemberData(null);
      setMemberError('');
    }

    watchInit(() => {
      setTab(initialTab ?? 'board');
      setSelectedMember(initialMember ?? null);
      setMemberData(null);
      setSearch('');
      setAgentFilter('');
      void loadSwarm(false);
    }, [threadId, backendId, initialTab, initialMember]);

    watchMember(() => {
      if (!selectedMember) return;
      void loadMember(selectedMember, false);
    }, [threadId, backendId, selectedMember]);

    watchPoll(() => {
      if (pollTimer) clearInterval(pollTimer);
      if (!online) return;
      pollTimer = setInterval(() => {
        void loadSwarm(true);
        if (selectedMemberState.value) {
          void loadMember(selectedMemberState.value, true);
        }
      }, POLL_MS);
      return () => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
      };
    }, [threadId, backendId, online]);

    const hasOverview = !!(swarm?.plan || swarm?.overview);
    const needle = search.trim().toLowerCase();
    const filteredMessages = (swarm?.messages ?? []).filter((m) => {
      if (agentFilter && m.agent !== agentFilter && !m.mentions.includes(agentFilter.toLowerCase())) {
        return false;
      }
      if (!needle) return true;
      return (
        m.agent.toLowerCase().includes(needle) ||
        m.text.toLowerCase().includes(needle) ||
        m.mentions.some((t) => t.toLowerCase().includes(needle))
      );
    });
    const visibleMembers = (swarm?.members ?? []).filter((m) => showKilled || !m.killed);
    const killedMembersCount = swarm?.counts.killed ?? 0;

    return (
      <SwarmAccessProvider value={null}>
        <Dialog
          title={swarm?.title || 'Swarm 协作面板'}
          titleIcon={<Icon name="grid" size={18} />}
          className="swarm-dialog"
          onClose={onClose}
        >
          {selectedMember ? (
            <>
              <div class="swarm-member-view-head">
                <div class="swarm-counts">
                  <button
                    type="button"
                    class="swarm-back-btn"
                    onClick={() => {
                      setSelectedMember(null);
                      setMemberData(null);
                      setMemberError('');
                    }}
                  >
                    <Icon name="back" size={16} />
                    <span>返回 Swarm</span>
                  </button>
                  <span class={`swarm-dot ${memberData?.member.status ?? 'waiting'}`} />
                  <strong>{selectedMember}</strong>
                  {memberData?.member.role && (
                    <span class="swarm-role-badge">{roleLabel(memberData.member.role)}</span>
                  )}
                  {memberData?.member.model && (
                    <span class="swarm-model-badge">{memberData.member.model}</span>
                  )}
                </div>
                <button
                  type="button"
                  class="icon-button"
                  aria-label="刷新成员轨迹"
                  title="刷新成员轨迹"
                  disabled={memberLoading || !online}
                  onClick={() => void loadMember(selectedMember, false)}
                >
                  <Icon name="refresh" size={18} />
                </button>
              </div>
              {memberData?.member.task && (
                <div class="swarm-overview-card">
                  <strong>任务分工</strong>
                  <p>{memberData.member.task}</p>
                </div>
              )}
              {memberError && (
                <p role="alert" class="error">
                  {memberError}
                </p>
              )}
              {memberLoading && !memberData ? (
                <div class="swarm-empty" role="status">
                  正在读取成员对话轨迹…
                </div>
              ) : memberData && memberData.messages.length > 0 ? (
                <div class="swarm-member-transcript">
                  <TranscriptMessages
                    agent={{ name: selectedMember }}
                    messages={memberData.messages}
                    threadId={threadId}
                    codex={false}
                  />
                </div>
              ) : (
                !memberError && <div class="swarm-empty">该成员暂无可展示的对话轨迹。</div>
              )}
            </>
          ) : (
            <>
              {swarm && (
                <div class="swarm-statusbar">
                  <div class="swarm-counts">
                    <span class="swarm-count-pill">
                      <span class="swarm-dot working" />
                      工作中 {swarm.counts.working}
                    </span>
                    <span class="swarm-count-pill">
                      <span class="swarm-dot waiting" />
                      等待中 {swarm.counts.waiting}
                    </span>
                    {killedMembersCount > 0 && (
                      <span class="swarm-count-pill">
                        <span class="swarm-dot killed" />
                        已结束 {killedMembersCount}
                      </span>
                    )}
                    <span class="swarm-count-pill">公告板 #{swarm.head}</span>
                  </div>
                  <button
                    type="button"
                    class="icon-button"
                    aria-label="刷新 Swarm"
                    title="刷新 Swarm"
                    disabled={loading || !online}
                    onClick={() => void loadSwarm(false)}
                  >
                    <Icon name="refresh" size={18} />
                  </button>
                </div>
              )}

              {error && (
                <p role="alert" class="error">
                  {error}
                </p>
              )}

              {loading && !swarm ? (
                <div class="swarm-empty" role="status">
                  正在读取 Swarm 协作状态…
                </div>
              ) : !swarm ? (
                <div class="swarm-empty">当前会话没有活跃的 Swarm 协作面板。</div>
              ) : (
                <>
                  <div class="swarm-tabs" role="tablist" aria-label="Swarm 面板视图">
                    <button
                      type="button"
                      role="tab"
                      class="swarm-tab"
                      aria-selected={tab === 'board'}
                      onClick={() => setTab('board')}
                    >
                      <span>公告板</span>
                      <span class="swarm-tab-badge">{swarm.messages.length}</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      class="swarm-tab"
                      aria-selected={tab === 'members'}
                      onClick={() => setTab('members')}
                    >
                      <span>成员</span>
                      <span class="swarm-tab-badge">{swarm.members.length}</span>
                    </button>
                    {hasOverview && (
                      <button
                        type="button"
                        role="tab"
                        class="swarm-tab"
                        aria-selected={tab === 'overview'}
                        onClick={() => setTab('overview')}
                      >
                        <span>总览</span>
                      </button>
                    )}
                  </div>

                  {tab === 'board' && (
                    <>
                      <div class="swarm-toolbar">
                        <label class="swarm-search">
                          <Icon name="search" size={16} />
                          <input
                            type="search"
                            aria-label="搜索公告板消息"
                            placeholder="搜索公告板内容或成员…"
                            value={search}
                            onInput={(e) => setSearch((e.currentTarget as HTMLInputElement).value)}
                          />
                        </label>
                        <div class="swarm-filter-chips">
                          <button
                            type="button"
                            class={`swarm-chip ${agentFilter === '' ? 'active' : ''}`}
                            onClick={() => setAgentFilter('')}
                          >
                            全部
                          </button>
                          {swarm.members.map((m) => (
                            <button
                              key={m.name}
                              type="button"
                              class={`swarm-chip ${agentFilter === m.name ? 'active' : ''}`}
                              onClick={() => setAgentFilter(agentFilter === m.name ? '' : m.name)}
                            >
                              {m.name}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div class="swarm-feed">
                        {filteredMessages.length === 0 ? (
                          <div class="swarm-empty">没有匹配的公告板消息。</div>
                        ) : (
                          filteredMessages.map((msg) => {
                            const isLong = msg.text.length > COLLAPSE_THRESHOLD;
                            const isExpanded = !!expandedPosts[msg.seq];
                            const displayText =
                              isLong && !isExpanded
                                ? `${msg.text.slice(0, COLLAPSE_THRESHOLD).trimEnd()}\n\n…`
                                : msg.text;
                            const member = swarm.members.find((m) => m.name === msg.agent);
                            return (
                              <article key={msg.seq} class="swarm-post">
                                <header class="swarm-post-head">
                                  <div class="swarm-post-sender">
                                    {member?.hasConversation ? (
                                      <button
                                        type="button"
                                        class="swarm-agent-btn"
                                        title={`查看 ${msg.agent} 对话轨迹`}
                                        onClick={() => openMember(msg.agent)}
                                      >
                                        {msg.agent}
                                      </button>
                                    ) : (
                                      <strong>{msg.agent}</strong>
                                    )}
                                    {(msg.all || msg.mentions.length > 0) && (
                                      <span class="swarm-mentions">
                                        → {msg.all ? '@all ' : ''}
                                        {msg.mentions.map((t) => `@${t}`).join(' ')}
                                      </span>
                                    )}
                                  </div>
                                  <div class="swarm-post-meta">
                                    <span>#{msg.seq}</span>
                                    {msg.time && <time>{msg.time}</time>}
                                  </div>
                                </header>
                                <div class="swarm-post-body">
                                  <RichMessage text={displayText} threadId={threadId} />
                                </div>
                                {isLong && (
                                  <button
                                    type="button"
                                    class="swarm-expand-btn"
                                    onClick={() =>
                                      setExpandedPosts({
                                        ...expandedPosts,
                                        [msg.seq]: !isExpanded,
                                      })
                                    }
                                  >
                                    {isExpanded ? '收起内容' : '展开全文'}
                                  </button>
                                )}
                              </article>
                            );
                          })
                        )}
                      </div>
                    </>
                  )}

                  {tab === 'members' && (
                    <div class="swarm-members-list">
                      {killedMembersCount > 0 && (
                        <div class="swarm-toolbar">
                          <button
                            type="button"
                            class={`swarm-chip ${showKilled ? 'active' : ''}`}
                            onClick={() => setShowKilled(!showKilled)}
                          >
                            {showKilled
                              ? `隐藏已结束成员 (${killedMembersCount})`
                              : `显示已结束成员 (${killedMembersCount})`}
                          </button>
                        </div>
                      )}
                      {visibleMembers.map((m) => (
                        <button
                          key={m.name}
                          type="button"
                          class={`swarm-member-card ${m.killed ? 'killed' : ''}`}
                          disabled={!m.hasConversation}
                          onClick={() => m.hasConversation && openMember(m.name)}
                        >
                          <div class="swarm-member-main">
                            <div class="swarm-member-title">
                              <span class={`swarm-dot ${m.status}`} />
                              <strong>{m.name}</strong>
                              <span class="swarm-role-badge">{roleLabel(m.role)}</span>
                              {m.model && <span class="swarm-model-badge">{m.model}</span>}
                            </div>
                            <div class="swarm-member-stats">
                              <span>状态：{statusLabel(m.status)}</span>
                              <span>步数：{m.steps}</span>
                              <span>发言：{m.posts}</span>
                              {m.unread > 0 && <span>未读：{m.unread}</span>}
                            </div>
                            {m.task && <div class="swarm-member-task">{m.task}</div>}
                            {m.activity && (
                              <div class={`swarm-member-activity ${m.failed ? 'failed' : ''}`}>
                                {m.activity}
                              </div>
                            )}
                          </div>
                          {m.hasConversation && (
                            <span class="swarm-member-cta">
                              <span>查看轨迹</span>
                              <Icon name="chevron" size={14} />
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {tab === 'overview' && hasOverview && (
                    <div class="swarm-overview">
                      {swarm.plan?.goal && (
                        <section class="swarm-overview-card">
                          <h3>{swarm.plan.goal.title || swarm.title}</h3>
                          {swarm.plan.goal.line && <p>{swarm.plan.goal.line}</p>}
                        </section>
                      )}
                      {swarm.overview?.headline && (
                        <section class="swarm-overview-card">
                          <h3>最新进展</h3>
                          <p>{swarm.overview.headline}</p>
                        </section>
                      )}
                      {!!swarm.plan?.threads?.length && (
                        <section class="swarm-overview-card">
                          <h3>工作分组</h3>
                          <div class="swarm-thread-list">
                            {swarm.plan.threads.map((group) => (
                              <div key={group.id || group.title} class="swarm-thread-item">
                                <strong>{group.title}</strong>
                                {group.goal && <p>{group.goal}</p>}
                                {!!group.tasks?.length && (
                                  <div class="swarm-thread-owners">
                                    {group.tasks.map((memberName) => (
                                      <button
                                        key={memberName}
                                        type="button"
                                        class="swarm-chip"
                                        onClick={() => openMember(memberName)}
                                      >
                                        {memberName}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </section>
                      )}
                      {!!swarm.overview?.attention?.length && (
                        <section class="swarm-overview-card">
                          <h3>需要关注</h3>
                          <div class="swarm-thread-list">
                            {swarm.overview.attention.map((item, idx) => (
                              <div key={item.id || idx} class="swarm-thread-item">
                                <strong>{item.title || item.kind}</strong>
                                {item.why && <p>{item.why}</p>}
                              </div>
                            ))}
                          </div>
                        </section>
                      )}
                      {!!swarm.overview?.milestones?.length && (
                        <section class="swarm-overview-card">
                          <h3>里程碑</h3>
                          <div class="swarm-thread-list">
                            {swarm.overview.milestones.map((item, idx) => (
                              <div key={item.id || idx} class="swarm-thread-item">
                                <p>{item.text}</p>
                              </div>
                            ))}
                          </div>
                        </section>
                      )}
                      {!!swarm.overview?.risks?.length && (
                        <section class="swarm-overview-card">
                          <h3>风险提示</h3>
                          <div class="swarm-thread-list">
                            {swarm.overview.risks.map((item, idx) => (
                              <div key={item.id || idx} class="swarm-thread-item">
                                <p>{item.text}</p>
                              </div>
                            ))}
                          </div>
                        </section>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </Dialog>
      </SwarmAccessProvider>
    );
  };
});
