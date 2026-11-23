import { RpcError } from '../../shared/rpc';
import type { Operation, ThreadView } from '../../shared/types';
import { mergeOperation } from '../operation-state';

const OPEN_FOR_SEND_TIMEOUT = 30_000;
const RECEIPT_POLL_INTERVAL = 750;
const unavailable = '暂时无法打开会话，消息未发送。请重试。';
export const openedThreadBlocked = '消息未发送。请查看当前会话状态，草稿已保留。';

type OpenResult = { state: 'ready' | 'cancelled' } | { state: 'blocked'; message: string };

export function canResumeThread(view: ThreadView | null, threadId: string) {
  return !!(
    view?.id === threadId &&
    view.synchronized &&
    view.canSend &&
    !view.owner &&
    (view.runtimeStatus === 'notLoaded' || view.runtimeStatus === 'idle') &&
    view.canResumeForSend === true
  );
}

function isOpenedThread(view: ThreadView | null, threadId: string): view is ThreadView {
  return !!(
    view?.id === threadId &&
    view.synchronized &&
    ((view.owner && view.runtimeStatus !== 'notLoaded') || canResumeThread(view, threadId))
  );
}

export function canSendOpenedThread(view: ThreadView | null, threadId: string) {
  return isOpenedThread(view, threadId) && view.canSend && !view.activeTurnId && view.pendingRequests === 0;
}

function rejectedMessage(reason?: string | null) {
  const message = reason?.trim();
  if (!message) return unavailable;
  return `${message}${/[。！？.!?]$/.test(message) ? '' : '。'}消息未发送，草稿已保留。`;
}

/** Use the live subscription for both confirmations and snapshots, with a receipt lookup as fallback. */
export function openForSend(options: {
  threadId: string;
  requestId: string;
  signal: AbortSignal;
  current: () => boolean;
  open: () => Promise<Operation>;
  lookup: () => Promise<Operation>;
  observed: () => Operation | undefined;
  view: () => ThreadView | null;
  subscribe: (check: () => void) => () => void;
  awaitingSync: () => void;
}): Promise<OpenResult> {
  const { threadId, requestId, signal } = options;
  return new Promise((resolve) => {
    let finished = false;
    let receipt: Operation | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const deadline = performance.now() + OPEN_FOR_SEND_TIMEOUT;
    const deadlineTimer = setTimeout(
      () => finish({ state: 'blocked', message: unavailable }),
      OPEN_FOR_SEND_TIMEOUT,
    );

    function cancel() {
      finish({ state: 'cancelled' });
    }

    function finish(result: OpenResult) {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      clearTimeout(pollTimer);
      signal.removeEventListener('abort', cancel);
      unsubscribe?.();
      resolve(result);
    }

    function remember(incoming?: Operation) {
      if (
        incoming?.kind !== 'open' ||
        incoming.id !== requestId ||
        incoming.threadId !== threadId ||
        (receipt && incoming.updatedAt < receipt.updatedAt) ||
        (receipt?.state === 'uncertain' &&
          incoming.updatedAt === receipt.updatedAt &&
          (incoming.state === 'received' || incoming.state === 'dispatching'))
      )
        return;
      receipt = mergeOperation(receipt ? [receipt] : [], incoming)[0];
    }

    function check() {
      if (finished) return;
      if (signal.aborted || !options.current()) return cancel();
      if (performance.now() >= deadline) return finish({ state: 'blocked', message: unavailable });
      remember(options.observed());
      if (receipt?.state === 'failed' || receipt?.state === 'rejected')
        return finish({ state: 'blocked', message: rejectedMessage(receipt.error) });
      const currentView = options.view();
      if (
        currentView?.id === threadId &&
        currentView.synchronized &&
        currentView.textOnlySend === true &&
        !canSendOpenedThread(currentView, threadId)
      )
        return finish({ state: 'blocked', message: currentView.reason || openedThreadBlocked });
      if (receipt?.state !== 'completed' && receipt?.state !== 'uncertain') return;
      if (!isOpenedThread(currentView, threadId)) return options.awaitingSync();
      finish(
        canSendOpenedThread(currentView, threadId)
          ? { state: 'ready' }
          : { state: 'blocked', message: openedThreadBlocked },
      );
    }

    async function poll() {
      check();
      if (finished || receipt?.state === 'completed') return;
      try {
        remember(await options.lookup());
      } catch {
        // A delayed or missing lookup does not replace evidence from the subscription.
      }
      check();
      if (!finished) pollTimer = setTimeout(poll, RECEIPT_POLL_INTERVAL);
    }

    unsubscribe = options.subscribe(check);
    signal.addEventListener('abort', cancel, { once: true });
    check();
    if (finished) return;
    void options.open().then(
      (operation) => {
        remember(operation);
        check();
      },
      (error: unknown) => {
        if (error instanceof RpcError && error.status >= 400 && error.status < 500)
          finish({ state: 'blocked', message: rejectedMessage(error.message) });
        else check();
      },
    );
    pollTimer = setTimeout(poll, RECEIPT_POLL_INTERVAL);
  });
}
