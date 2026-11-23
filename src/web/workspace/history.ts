import { codexDisplayMessage } from '../../shared/codex-transcript';
import type { Message, ThreadSummary, ThreadView } from '../../shared/types';

export const HISTORY_TOP_THRESHOLD = 160;
export const TRANSCRIPT_BOTTOM_TOLERANCE = 2;
export const HISTORY_PAGES_PER_LOAD = 8;
export const HISTORY_VISIBLE_TARGET = 40;
export const RECENT_REFRESH_INTERVAL = 10_000;
export const antigravityImages = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export type ThreadPage = { threads: ThreadSummary[]; nextCursor: string | null };
export type HistoryRevision = Pick<ThreadView, 'historyTrajectoryId' | 'historyStepCount'>;

export const codexMessages = (messages: Message[], activeTurnId?: string | null) =>
  messages.flatMap((message) =>
    codexDisplayMessage(message, !!activeTurnId && message.turnId === activeTurnId) ?? [],
  );

export function antigravityStep(message: Message | undefined) {
  const index = /^antigravity-step-(\d+)$/.exec(message?.id ?? '')?.[1];
  return index === undefined ? undefined : Number(index);
}

export function mergeAntigravityHistory(older: Message[], updates: Message[]) {
  const records = new Map(older.map((message) => [message.id, message]));
  for (const message of updates) records.set(message.id, message);
  return [...records.values()].sort(
    (left, right) => (antigravityStep(left) ?? 0) - (antigravityStep(right) ?? 0),
  );
}

export function historyChanged(previous: HistoryRevision | null, next: HistoryRevision) {
  if (!previous?.historyTrajectoryId || !next.historyTrajectoryId) return false;
  return (
    previous.historyTrajectoryId !== next.historyTrajectoryId ||
    (previous.historyStepCount !== undefined &&
      next.historyStepCount !== undefined &&
      next.historyStepCount < previous.historyStepCount)
  );
}
