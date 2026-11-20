import { onScopeDispose, shallowRef } from 'vue';
import { Icon } from '../Icon';
import { watchRender } from '../render-effects';
import { tsxComponent } from '../tsx-component';
import type { ChatInteraction, ChatMessage } from '../../shared/messaging';
import { messaging } from './context';
import { Dialog, Notice, errorText } from './ui';
import './approval-panel.css';

type Filter = 'pending' | 'processed';
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const labels = {
  pending: '待审批',
  approved: '已允许本次',
  rejected: '已拒绝',
  answered: '已回答',
  cancelled: '已撤回',
  expired: '已过期',
};
const currentStatus = (request: ChatInteraction, now: number) =>
  request.status === 'pending' && request.expiresAt <= now ? 'expired' : request.status;

export default tsxComponent(function ApprovalPanel(_props: {
  id: string;
  name: string;
  userId: string;
  readonly: boolean;
  updates: ChatMessage[];
  recovery: number;
  onUpdate: (message: ChatMessage) => void;
  onClose: () => void;
}) {
  const filter = shallowRef<Filter>('pending');
  const records = shallowRef(new Map<string, ChatMessage>());
  const before = shallowRef<number>();
  const selected = shallowRef<string>();
  const error = shallowRef('');
  const loading = shallowRef(false);
  const refreshed = shallowRef<Filter>();
  const acting = shallowRef(false);
  const now = shallowRef(Date.now());
  const watchUpdates = watchRender();
  const watchLoad = watchRender();
  const watchExpiry = watchRender();
  const unverifiedRevisions = new Map<string, number>();
  let fetchRequest: AbortController | undefined;
  onScopeDispose(() => fetchRequest?.abort());

  return ({ id, name, userId, readonly, updates, recovery, onUpdate, onClose }) => {
    function isOwnApproval(message: ChatMessage) {
      const request = message.interaction;
      return message.conversationId === id && request?.kind === 'approval' &&
        (message.senderId === userId || request.recipientId === userId);
    }

    function merge(messages: ChatMessage[], previous = records.value) {
      const next = new Map(previous);
      for (const message of messages) {
        if (
          isOwnApproval(message) &&
          (unverifiedRevisions.get(message.id) ?? -1) < message.revision &&
          (next.get(message.id)?.revision ?? -1) <= message.revision
        )
          next.set(message.id, message);
      }
      records.value = next;
    }

    async function load(cursor?: number) {
      fetchRequest?.abort();
      const request = new AbortController();
      const requested = filter.value;
      const snapshot = records.value;
      fetchRequest = request;
      loading.value = true;
      error.value = '';
      if (cursor === undefined) {
        before.value = undefined;
        refreshed.value = undefined;
      }
      try {
        const page = await messaging.approvals(id, requested, cursor, request.signal);
        if (request.signal.aborted) return;
        const loadedAt = Date.now();
        const retained = new Map(records.value);
        const verified = page.messages.filter(isOwnApproval);
        const loaded = new Set(verified.map(({ id }) => id));
        function discard(message: ChatMessage) {
          const rejected = Math.max(unverifiedRevisions.get(message.id) ?? -1, message.revision);
          unverifiedRevisions.set(message.id, rejected);
          const current = retained.get(message.id);
          if (current && current.revision <= rejected) retained.delete(message.id);
        }
        for (const message of page.messages) {
          if (message.conversationId === id && !loaded.has(message.id)) discard(message);
        }
        if (cursor === undefined) {
          // A newer snapshot can resolve a request while this panel is disconnected.
          for (const [messageId, message] of snapshot) {
            const pending = currentStatus(message.interaction!, loadedAt) === 'pending';
            if (
              pending === (requested === 'pending') &&
              !loaded.has(messageId) &&
              (page.before === undefined || message.sequence >= page.before) &&
              retained.get(messageId) === message
            )
              discard(message);
          }
        }
        for (const message of verified) {
          if (message.revision >= (unverifiedRevisions.get(message.id) ?? Infinity)) {
            unverifiedRevisions.delete(message.id);
          }
        }
        merge(verified, retained);
        before.value = page.before;
        now.value = loadedAt;
        refreshed.value = requested;
      } catch (cause) {
        if (!request.signal.aborted) error.value = errorText(cause);
      } finally {
        if (!request.signal.aborted) loading.value = false;
      }
    }

    const activeFilter = filter.value;
    watchUpdates(() => merge(updates), [updates]);
    watchLoad(() => void load(), [id, activeFilter, recovery]);
    const all = [...records.value.values()];
    const deadline = all.reduce(
      (next, { interaction }) =>
        interaction?.status === 'pending' && interaction.expiresAt > now.value
          ? Math.min(next, interaction.expiresAt)
          : next,
      Infinity,
    );
    watchExpiry(() => {
      if (!Number.isFinite(deadline)) return;
      const timer = setTimeout(() => (now.value = Date.now()), Math.max(0, deadline - Date.now()) + 10);
      return () => clearTimeout(timer);
    }, [deadline]);
    const visible = all
      .filter(
        ({ interaction }) =>
          (currentStatus(interaction!, now.value) === 'pending') === (activeFilter === 'pending'),
      )
      .sort((left, right) => right.sequence - left.sequence);
    const item = visible.find((message) => message.id === selected.value);
    const request = item?.interaction;
    const actionsAvailable = activeFilter === 'pending' && refreshed.value === 'pending' && !readonly;
    const canDecide = actionsAvailable && request?.recipientId === userId;
    const canCancel = actionsAvailable && item?.senderId === userId;

    function choose(next: Filter) {
      if (acting.value || next === filter.value) return;
      selected.value = undefined;
      filter.value = next;
    }

    async function act(decision?: 'approve' | 'reject') {
      if (!item || !request || acting.value || currentStatus(request, Date.now()) !== 'pending') return;
      if (decision ? !canDecide : !canCancel) return;
      acting.value = true;
      error.value = '';
      try {
        const result = decision
          ? await messaging.respond(id, item.id, { decision })
          : await messaging.cancelInteraction(id, item.id);
        merge([result.message]);
        onUpdate(result.message);
        filter.value = 'processed';
      } catch (cause) {
        error.value = errorText(cause);
      } finally {
        acting.value = false;
      }
    }

    return (
      <Dialog
        title="审批面板"
        titleIcon={<Icon name="approval" size={20} />}
        className="im-approval-panel"
        onClose={() => !acting.value && onClose()}
      >
        {() => (
          <>
            <div class="im-approval-toolbar">
              <span class="im-approval-conversation">{name}</span>
              <div class="im-approval-filters" role="group" aria-label="审批记录状态">
                <button
                  type="button"
                  aria-pressed={activeFilter === 'pending'}
                  onClick={() => choose('pending')}
                >
                  待审批
                </button>
                <button
                  type="button"
                  aria-pressed={activeFilter === 'processed'}
                  onClick={() => choose('processed')}
                >
                  已处理
                </button>
              </div>
            </div>
            <Notice text={error.value} />
            <div class={`im-approval-workspace${request ? ' has-selection' : ''}`}>
              <div class="im-approval-list" aria-label="审批记录">
                {visible.map((message) => {
                  const approval = message.interaction!;
                  const status = currentStatus(approval, now.value);
                  return (
                    <button
                      class="im-approval-row"
                      key={message.id}
                      type="button"
                      aria-pressed={message.id === selected.value}
                      onClick={() => {
                        if (!acting.value) selected.value = message.id;
                      }}
                    >
                      <strong>{approval.title}</strong>
                      <small>
                        {message.sender.displayName} · {time(message.createdAt)}
                      </small>
                      <span class={`im-approval-status ${status}`}>{labels[status]}</span>
                    </button>
                  );
                })}
                {!visible.length && (
                  <p class="im-approval-empty" role="status">
                    {loading.value
                      ? '正在读取审批记录…'
                      : error.value
                        ? '暂时无法读取记录'
                        : activeFilter === 'pending'
                          ? '暂无待审批记录'
                          : '暂无已处理记录'}
                  </p>
                )}
                {before.value !== undefined && (
                  <button
                    class="secondary"
                    type="button"
                    disabled={loading.value}
                    onClick={() => void load(before.value)}
                  >
                    {loading.value ? '正在加载…' : '加载更早记录'}
                  </button>
                )}
                {error.value && !visible.length && (
                  <button
                    class="secondary"
                    type="button"
                    disabled={loading.value}
                    onClick={() => void load()}
                  >
                    重试
                  </button>
                )}
              </div>
              <section class="im-approval-detail" aria-label="审批详情">
                {item && request ? (
                  <>
                    <button
                      class="secondary im-approval-back"
                      type="button"
                      disabled={acting.value}
                      onClick={() => (selected.value = undefined)}
                    >
                      <Icon name="back" size={15} />
                      返回记录
                    </button>
                    <h3>{request.title}</h3>
                    <span class={`im-approval-status ${currentStatus(request, now.value)}`} role="status">
                      {labels[currentStatus(request, now.value)]}
                    </span>
                    <dl>
                      <div>
                        <dt>发起人</dt>
                        <dd>{item.sender.displayName}</dd>
                      </div>
                      <div>
                        <dt>授权范围</dt>
                        <dd>本次操作</dd>
                      </div>
                      <div>
                        <dt>{request.respondedAt ? '处理时间' : '截止时间'}</dt>
                        <dd>{time(request.respondedAt ?? request.expiresAt)}</dd>
                      </div>
                    </dl>
                    <pre class="im-approval-description">{request.description}</pre>
                    {activeFilter === 'pending' && (
                      <div class="im-approval-actions">
                        {canCancel && (
                          <button
                            class="secondary"
                            type="button"
                            disabled={acting.value}
                            onClick={() => void act()}
                          >
                            撤回请求
                          </button>
                        )}
                        {canDecide && (
                          <>
                            <button
                              class="secondary"
                              type="button"
                              disabled={acting.value}
                              onClick={() => void act('reject')}
                            >
                              拒绝
                            </button>
                            <button
                              class="primary"
                              type="button"
                              disabled={acting.value}
                              onClick={() => void act('approve')}
                            >
                              {acting.value ? '提交中…' : '允许本次'}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <p class="im-approval-empty">{visible.length ? '选择一条记录查看详情' : '审批详情'}</p>
                )}
              </section>
            </div>
          </>
        )}
      </Dialog>
    );
  };
});
