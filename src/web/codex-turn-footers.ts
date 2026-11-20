import type { Message } from '../shared/types';

/** The reply belongs to the turn, even when its tool or agent notices arrived afterwards. */
export function codexTurnFooters(groups: readonly Message[], activeTurnId?: string | null) {
  const footers = new Map<number, Message>();
  let turn: string | undefined;
  let reply: Message | undefined;
  let priority = -1;

  const endTurn = (index: number, last = false) => {
    if (reply && (!activeTurnId || (turn !== activeTurnId && (turn || !last)))) {
      footers.set(index, reply);
    }
    reply = undefined;
    priority = -1;
  };

  groups.forEach((message, index) => {
    const id = message.turnId;
    if (message.role === 'user' || (id && turn && id !== turn)) {
      if (!(message.role === 'user' && id && id === turn)) {
        endTurn(index - 1);
        turn = undefined;
      } else {
        reply = undefined;
        priority = -1;
      }
    }
    turn = id ?? turn;

    if (message.role !== 'assistant' || (!message.text && !message.turnBoundary)) return;
    const rank = message.turnBoundary ? 2 : message.phase === 'final_answer' ? 1 : !message.phase ? 0 : -1;
    if (rank >= 0 && rank >= priority) {
      priority = rank;
      reply = message;
    }
  });

  endTurn(groups.length - 1, true);
  return footers;
}
