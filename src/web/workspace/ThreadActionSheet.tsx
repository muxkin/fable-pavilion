import { tsxComponent } from '../tsx-component';
import type { Operation } from '../../shared/types';
import { OperationFeedback, operationActivity } from '../OperationFeedback';
import { ThreadTools } from '../ThreadTools';

export type WorkspaceThreadAction = {
  kind: 'rename' | 'fork';
  threadId: string;
  title: string;
  lastTurnId?: string;
  requestId?: string;
};

export const ThreadActionSheet = tsxComponent(function ThreadActionSheet(_props: {
  threadTitle: string;
  action: WorkspaceThreadAction;
  operation?: Operation;
  busy: boolean;
  pending: boolean;
  stream: boolean;
  error: string;
  onTitleChange: (title: string) => void;
  onSubmit: () => void;
  onCheck?: () => Promise<void>;
  onClose: () => void;
}) {
  return ({
    threadTitle,
    action,
    operation,
    busy,
    pending,
    stream,
    error,
    onTitleChange,
    onSubmit,
    onCheck,
    onClose,
  }) => (
    <ThreadTools
      open
      title={threadTitle}
      heading={action.kind === 'rename' ? '会话改名' : '创建会话分支'}
      onClose={onClose}
    >
      {() => (
        <form
          class="thread-action-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {action.kind === 'rename' ? (
            <label>
              会话名称
              <input
                required
                autofocus
                onVnodeMounted={(vnode) => (vnode.el as HTMLElement).focus()}
                maxlength={160}
                value={action.title}
                onInput={(event) => onTitleChange((event.currentTarget as HTMLInputElement).value)}
                disabled={busy || pending}
              />
            </label>
          ) : (
            <p class="hint">
              {action.lastTurnId
                ? '保留截至这条回复的历史，在同一目录创建一条独立的 Codex 会话。'
                : '使用当前会话历史，在同一目录创建一条独立的 Codex 会话。'}
            </p>
          )}
          <OperationFeedback operation={operation} onCheck={onCheck} />
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <button
            class="primary"
            disabled={
              !stream ||
              busy ||
              pending ||
              operation?.state === 'completed' ||
              (action.kind === 'rename' && (!action.title.trim() || action.title.trim() === threadTitle))
            }
            type="submit"
          >
            {operationActivity(operation) ?? (action.kind === 'rename' ? '保存名称' : '创建分支')}
          </button>
        </form>
      )}
    </ThreadTools>
  );
});
