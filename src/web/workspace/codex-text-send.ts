import type { ThreadView } from '../../shared/types';
import type { ChatDraft } from '../chat-drafts';

export const textOnlySendHint =
  '当前仅可发送文本。带附件或使用所选技能、插件或模型的消息，请在电脑上的 Codex 发送。';
export const fileReferenceExtrasHint = '请在电脑上的 Codex 发送使用所选技能、插件或模型的消息。';
export const activeTurnChanged = '当前任务已变化或暂不可追加。消息未发送，草稿已保留。';

export function requiresFullSend(draft: ChatDraft, allowsFileReferences: boolean) {
  return !!(
    (!allowsFileReferences && draft.uploads.length) ||
    draft.skills.length ||
    draft.plugins.length ||
    draft.model
  );
}

export function canSendFileReferences(view: ThreadView | null, threadId: string) {
  return view?.id === threadId && view.synchronized && view.canSendFileReferences === true;
}

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

export function onlySendsText(view: ThreadView | null, threadId: string) {
  return !!(view?.id === threadId && view.synchronized && view.textOnlySend === true);
}

export function textSteeringTurnId(view: ThreadView | null, threadId: string) {
  if (
    view?.id === threadId &&
    view.synchronized &&
    view.textOnlySend === true &&
    view.runtimeStatus === 'active' &&
    view.canSteer === true &&
    view.pendingRequests === 0 &&
    !view.requests?.length &&
    typeof view.activeTurnId === 'string' &&
    view.activeTurnId.length
  )
    return view.activeTurnId;
}
