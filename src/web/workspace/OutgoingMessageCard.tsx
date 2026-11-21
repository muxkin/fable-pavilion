import { tsxComponent } from '../tsx-component';
import { bcp47Locale, t } from '../../shared/i18n';
import type { Operation } from '../../shared/types';
import type { ChatDraft } from '../chat-drafts';
import { MessageContent } from '../MessageContent';
import { OperationFeedback, operationActivity } from '../OperationFeedback';
import { OutgoingContent, OutgoingStatus } from '../OutgoingMessage';

export const OutgoingMessageCard = tsxComponent(function OutgoingMessageCard(_props: {
  threadId: string;
  codex: boolean;
  operation: Operation;
  draft: ChatDraft;
  hasFailure: boolean;
  draftHasContent: boolean;
  onCheck: () => Promise<void>;
  onRetry?: () => void;
  onMoveToDraft: () => void;
  onDismiss: () => void;
}) {
  return ({
    threadId,
    codex,
    operation,
    draft,
    hasFailure,
    draftHasContent,
    onCheck,
    onRetry,
    onMoveToDraft,
    onDismiss,
  }) => (
    <article class="message user outgoing-message" data-outgoing-id={operation.id}>
      <div class="message-role">{t('你', 'You')}</div>
      <OutgoingContent text="" files={draft.uploads}>
        {() => (
          <>
            {(!!draft.skills.length || !!draft.plugins.length) && (
              <div class="selected-skills">
                {[...draft.skills, ...draft.plugins].map((item) => (
                  <span class="skill-chip" key={item.id}>
                    {item.name}
                  </span>
                ))}
              </div>
            )}
            {draft.text && (
              <MessageContent
                message={{ id: operation.id, role: 'user', text: draft.text }}
                threadId={threadId}
                streaming={false}
                codex={codex}
              />
            )}
          </>
        )}
      </OutgoingContent>
      <OutgoingStatus activity={operationActivity(operation)}>
        {() => (
          <>
            {operation.createdAt > 0 && (
              <time
                class="message-time"
                datetime={new Date(operation.createdAt).toISOString()}
                title={new Date(operation.createdAt).toLocaleString(bcp47Locale())}
              >
                {new Date(operation.createdAt).toLocaleTimeString(bcp47Locale(), {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </time>
            )}
            {operation.state === 'accepted' && <span>{t('已发送', 'Sent')}</span>}
            <OperationFeedback operation={operation} onCheck={onCheck} onRetry={onRetry} />
            {hasFailure && (
              <div class="outgoing-actions">
                {operation.state === 'rejected' && !draftHasContent && (
                  <button type="button" onClick={onMoveToDraft}>
                    移回输入框
                  </button>
                )}
                <button type="button" onClick={onDismiss}>
                  移除发送记录
                </button>
              </div>
            )}
          </>
        )}
      </OutgoingStatus>
    </article>
  );
});
