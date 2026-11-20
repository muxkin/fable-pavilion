import { tsxComponent } from '../tsx-component';
import type { Operation, ThreadView } from '../../shared/types';
import { OperationFeedback } from '../OperationFeedback';
import { SessionOperationHistory, SessionToolActions, type SessionToolAction } from '../SessionTools';
import { ThreadTools } from '../ThreadTools';

export const SessionToolsSheet = tsxComponent(function SessionToolsSheet(_props: {
  open: boolean;
  title: string;
  stream: boolean;
  canOpenForSend: boolean;
  busy: boolean;
  pending: boolean;
  view: ThreadView | null;
  actions: SessionToolAction[];
  operations: Operation[];
  onClose: () => void;
  onCheckOperation: (id: string) => Promise<void>;
  onRemoveQueue: (messageId: string) => void;
  onOpenThread: (threadId: string) => void;
}) {
  return ({
    open,
    title,
    stream,
    canOpenForSend,
    busy,
    pending,
    view,
    actions,
    operations,
    onClose,
    onCheckOperation,
    onRemoveQueue,
    onOpenThread,
  }) => (
    <ThreadTools open={open} onClose={onClose} title={title} className="session-tools">
      {() => (
        <>
          {stream && !canOpenForSend && view?.reason && (
            <p class="session-tool-status" role="status">
              {view.reason}
            </p>
          )}
          <SessionToolActions actions={actions} />
          {operations[0]?.kind === 'settings' && (
            <OperationFeedback
              operation={operations[0]}
              onCheck={() => onCheckOperation(operations[0].id)}
            />
          )}
          {!!view?.queuedMessages?.length && (
            <details class="native-queue" open>
              <summary>会话队列 · {view.queuedMessages.length}</summary>
              {view.queuedMessages.map((m) => (
                <div key={m.id}>
                  <p>{m.text}</p>
                  <small>{m.reason ?? m.status}</small>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      pending ||
                      !stream ||
                      !view.owner ||
                      !view.synchronized ||
                      !view.queueFingerprint ||
                      ['sending', 'outcome-unknown'].includes(m.status)
                    }
                    onClick={() => onRemoveQueue(m.id)}
                  >
                    移除
                  </button>
                </div>
              ))}
            </details>
          )}
          <SessionOperationHistory operations={operations} onOpenThread={onOpenThread} />
        </>
      )}
    </ThreadTools>
  );
});
