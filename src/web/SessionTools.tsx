import { shallowRef, useId } from 'vue';
import type { Operation } from '../shared/types';
import type { IconName } from './icon-paths';
import { Icon } from './Icon';
import { tsxComponent } from './tsx-component';
import './session-tools.css';

export interface SessionToolAction {
  id: string;
  label: string;
  description: string;
  icon: IconName;
  disabled?: boolean;
  onSelect: () => void;
}

export const SessionToolActions = tsxComponent(function SessionToolActions(_props: {
  actions: SessionToolAction[];
}) {
  const id = useId();
  return ({ actions }) => (
    <div class="session-tool-actions">
      {actions.map((action) => (
        <button
          type="button"
          class="session-tool-action"
          key={action.id}
          aria-label={action.label}
          aria-describedby={`${id}-${action.id}`}
          disabled={action.disabled}
          onClick={action.onSelect}
        >
          <span class="session-tool-symbol">
            <Icon name={action.icon} size={21} />
          </span>
          <span class="session-tool-copy">
            <strong>{action.label}</strong>
            <small id={`${id}-${action.id}`}>{action.description}</small>
          </span>
          <Icon name="chevron" size={17} />
        </button>
      ))}
    </div>
  );
});

const operationNames: Record<Operation['kind'], string> = {
  create: '新建会话',
  open: '打开会话',
  rename: '会话改名',
  fork: '创建分支',
  queue: '加入队列',
  'queue-remove': '移除排队',
  steer: '追加指令',
  send: '发送消息',
  settings: '模型设置',
  control: '会话控制',
  respond: '提交回复',
  interrupt: '停止任务',
};
const labels: Record<Operation['state'], string> = {
  received: '已接收',
  dispatching: '等待确认',
  accepted: '已接受',
  completed: '已完成',
  interrupted: '已中断',
  failed: '未完成',
  rejected: '未发送',
  uncertain: '待确认',
};
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

export const SessionOperationHistory = tsxComponent(function SessionOperationHistory(_props: {
  operations: Operation[];
  onOpenThread: (id: string) => void;
}) {
  const visibleCount = shallowRef(8);
  return ({ operations, onOpenThread }) => (
    <details class="session-operation-history">
      <summary>
        <Icon name="clock" size={18} />
        <span>操作记录</span>
        <span class="session-history-count">{operations.length}</span>
        <Icon name="down" size={17} />
      </summary>
      {operations.length ? (
        <div class="session-history-scroll">
          <ol>
            {operations.slice(0, visibleCount.value).map((operation) => {
              const failed = operation.state === 'failed' || operation.state === 'rejected';
              const date = new Date(operation.updatedAt);
              const validDate = Number.isFinite(date.getTime());
              const time = validDate
                ? (date.toDateString() === new Date().toDateString() ? '' : dateFormat.format(date) + ' ') +
                  timeFormat.format(date)
                : '';
              return (
                <li key={operation.id} data-state={operation.state}>
                  <span class="session-history-symbol">
                    <Icon
                      name={failed ? 'close' : operation.state === 'completed' ? 'check' : 'clock'}
                      size={15}
                    />
                  </span>
                  <div class="session-history-copy">
                    <div>
                      <span>{operationNames[operation.kind] ?? '操作'}</span>
                      <small>{labels[operation.state]}</small>
                    </div>
                    {operation.error && <p>{operation.error}</p>}
                    {operation.kind === 'create' &&
                      operation.resultThreadId &&
                      operation.state === 'uncertain' && (
                        <button type="button" onClick={() => onOpenThread(operation.resultThreadId!)}>
                          查看已建立的会话
                        </button>
                      )}
                  </div>
                  {validDate && <time datetime={date.toISOString()}>{time}</time>}
                </li>
              );
            })}
          </ol>
          {visibleCount.value < operations.length && (
            <button
              class="session-history-more"
              type="button"
              onClick={() => {
                visibleCount.value += 8;
              }}
            >
              显示更多记录
              <Icon name="down" size={15} />
            </button>
          )}
        </div>
      ) : (
        <p class="session-history-empty">暂无操作记录</p>
      )}
    </details>
  );
});
