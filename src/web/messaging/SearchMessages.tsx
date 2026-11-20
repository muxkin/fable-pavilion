import { shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { writeRef } from '../render-effects';
import type { ChatMessage } from '../../shared/messaging';
import { messaging } from './context';
import { Dialog, Notice, errorText } from './ui';

export const SearchMessages = tsxComponent(function SearchMessages(_props: {
  id: string;
  onClose: () => void;
  onSelect: (message: ChatMessage) => void;
}) {
  const qState = shallowRef('');
  const setQ = writeRef(qState);
  const resultsState = shallowRef<ChatMessage[]>([]);
  const setResults = writeRef(resultsState);
  const beforeState = shallowRef<number>();
  const setBefore = writeRef(beforeState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const submittedState = shallowRef('');
  const setSubmitted = writeRef(submittedState);
  return ({ id, onClose, onSelect }) => {
    const q = qState.value;
    const results = resultsState.value;
    const before = beforeState.value;
    const error = errorState.value;
    const busy = busyState.value;
    const submitted = submittedState.value;
    async function run(older = false) {
      setBusy(true);
      setError('');
      try {
        const result = await messaging.search(id, older ? submitted : q, older ? before : undefined);
        setResults((old) => (older ? [...old, ...result.messages] : result.messages));
        setBefore(result.before);
        if (!older) setSubmitted(q);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    }
    return (
      <Dialog title="搜索聊天记录" onClose={onClose}>
        {() => (
          <>
            <form
              class="im-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run();
              }}
            >
              <input
                aria-label="搜索关键词"
                autofocus
                onVnodeMounted={(vnode) => (vnode.el as HTMLElement).focus()}
                value={q}
                onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
                maxlength={100}
                placeholder="输入关键词"
              />
              <button class="primary" disabled={busy || !q.trim()}>
                搜索
              </button>
            </form>
            <Notice text={error} />
            <div class="im-search-results">
              {results.map((m) => (
                <button key={m.id} onClick={() => onSelect(m)}>
                  <small>
                    {m.sender?.displayName} · {new Date(m.createdAt).toLocaleString('zh-CN')}
                  </small>
                  <span>{m.text.slice(0, 300)}</span>
                </button>
              ))}
              {submitted && !results.length && !busy && <p class="im-help">没有找到相关消息</p>}
              {before && (
                <button class="secondary" disabled={busy} onClick={() => void run(true)}>
                  加载更多结果
                </button>
              )}
            </div>
          </>
        )}
      </Dialog>
    );
  };
});
