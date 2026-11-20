import { defineAsyncComponent as lazy, Suspense } from 'vue';
import { tsxComponent } from '../tsx-component';
import type { ChatMessage } from '../../shared/messaging';
import { ChatFiles } from './ChatFiles';
import { InteractionCard } from './InteractionCard';
import { Dialog } from './ui';

const RichMessage = lazy(() => import('../RichMessage'));

export const QuotedMessageDialog = tsxComponent(function QuotedMessageDialog(_props: {
  id: string;
  message: ChatMessage;
  userId: string;
  disabled: boolean;
  onClose: () => void;
  onUpdate: (message: ChatMessage) => void;
}) {
  return ({ id, message, userId, disabled, onClose, onUpdate }) => (
    <Dialog title="消息详情" onClose={onClose}>
      {() => (
        <>
          <p class="im-help">
            {message.sender?.displayName} · {new Date(message.createdAt).toLocaleString('zh-CN')}
          </p>
          <Suspense timeout={0}>
            {{
              fallback: () => message.text,
              default: () => (
                <>
                  <RichMessage
                    preserveLineBreaks={message.sender?.kind !== 'agent'}
                    text={message.text}
                    threadId={id}
                    streaming={message.state === 'streaming'}
                  />
                </>
              ),
            }}
          </Suspense>
          {message.interaction && (
            <InteractionCard
              message={message}
              userId={userId}
              disabled={disabled}
              onUpdate={onUpdate}
            />
          )}
          <ChatFiles files={message.attachments} id={id} />
        </>
      )}
    </Dialog>
  );
});
