import { tsxComponent } from '../tsx-component';
import type { ChatAttachment } from '../../shared/messaging';
import { FileAttachment } from '../FileAttachment';
import { Media } from '../MediaAttachment';

export const ChatFiles = tsxComponent(function ChatFiles(_props: {
  files: ChatAttachment[];
  id: string;
  compact?: boolean;
  onRemove?: (file: ChatAttachment) => void;
}) {
  return ({ files, id, compact = false, onRemove }) => {
    const siblings = files
      .filter((item) => !item.removed)
      .map((item) => ({ name: item.name, url: item.url, mime: item.mime }));
    return (
      <div class={`user-attachments im-files ${compact ? 'compact' : ''}`}>
        {files.map((file) =>
          file.removed ? (
            <span class="im-resource-removed" key={file.id}>
              {file.name} · 附件已清理
            </span>
          ) : /^(image|audio|video)\//.test(file.mime) ? (
            <Media
              key={file.id}
              src={file.url}
              mediaType={file.mime.split('/')[0] as 'image' | 'audio' | 'video'}
              label={file.name}
              threadId={id}
              compact={compact}
              onRemove={onRemove ? () => onRemove(file) : undefined}
            />
          ) : (
            <FileAttachment
              key={file.id}
              href={file.url}
              name={file.name}
              threadId={id}
              siblingFiles={siblings}
              card
              compact={compact}
              onRemove={onRemove ? () => onRemove(file) : undefined}
            />
          ),
        )}
      </div>
    );
  };
});
