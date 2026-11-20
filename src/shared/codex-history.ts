import type { Message } from './types.js';

const rolloutId = /^rollout-\d+$/;
const desktopUserId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function identity(message: Message) {
  const id = message.nativeItemId ?? message.id;
  const notice = message.role === 'tool' ? message.codex : undefined;
  return JSON.stringify([
    message.role,
    id,
    notice?.kind,
    notice && notice.kind !== 'turn-timing' && 'state' in notice ? notice.state : undefined,
  ]);
}

function sameContent(history: Message, live: Message) {
  return (
    (!!history.text || !!history.attachments?.length) &&
    history.text === live.text &&
    JSON.stringify(history.attachments ?? []) === JSON.stringify(live.attachments ?? [])
  );
}

function userAlias(history: Message, live: Message) {
  if (!history.turnId || history.turnId !== live.turnId || live.role !== 'user') return false;
  // The rollout's provider message and the desktop's user item can have different IDs.
  const providerEcho =
    history.nativeItemId?.startsWith('msg_') && desktopUserId.test(live.nativeItemId ?? live.id);
  const pendingInput = !live.nativeItemId && live.id === `${live.turnId}:input`;
  return (providerEcho || pendingInput) && sameContent(history, live);
}

function legacyMatch(history: Message, live: Message) {
  return (
    !history.nativeItemId &&
    rolloutId.test(history.id) &&
    history.role === live.role &&
    !history.codex &&
    !live.codex &&
    (!history.turnId || history.turnId === live.turnId) &&
    (!history.phase || !live.phase || history.phase === live.phase) &&
    !!history.text &&
    sameContent(history, live)
  );
}

function preserveArchivedMetadata(saved: Message, displayed: Message): Message {
  const sameTurn = !displayed.turnId || displayed.turnId === saved.turnId;
  const boundary =
    saved.turnBoundary &&
    saved.turnId &&
    !displayed.turnBoundary &&
    sameTurn &&
    displayed.role === 'assistant' &&
    (!displayed.phase || displayed.phase === 'final_answer');
  const toolActions =
    displayed.role === 'tool' && !displayed.toolActions?.length && sameTurn ? saved.toolActions : undefined;
  if (!boundary && !toolActions?.length) return displayed;
  return {
    ...displayed,
    ...(boundary ? { turnBoundary: true, turnId: saved.turnId } : {}),
    ...(toolActions?.length ? { toolActions } : {}),
  };
}

function isPlacementAnchor(message: Message) {
  return message.codex?.kind !== 'turn-timing';
}

// A tool can be completed in a different order from the order in which Codex lists it.
// Keep the largest set of common items with consistent ordering, using the live copy for display.
function orderedAnchors(pairs: Map<number, number>, history: Message[]) {
  const tails: { row: number; position: number }[] = [];
  const previous = new Map<number, number>();

  for (let row = 0; row < history.length; row++) {
    const position = pairs.get(row);
    if (position === undefined || !isPlacementAnchor(history[row])) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (tails[mid].position < position) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous.set(row, tails[low - 1].row);
    tails[low] = { row, position };
  }

  const anchors: number[] = [];
  for (let row = tails.at(-1)?.row; row !== undefined; row = previous.get(row)) anchors.push(row);
  return anchors.reverse();
}

/** Merge overlapping Codex snapshots without moving archive-only items to the start of the chat. */
export function mergeCodexHistory(history: Message[], live: Message[]): Message[] {
  if (!history.length) return live;
  if (!live.length) return history;

  const positions = new Map(live.map((message, position) => [identity(message), position]));
  const pairs = new Map<number, number>();
  const used = new Set<number>();
  for (let row = 0; row < history.length; row++) {
    const position = positions.get(identity(history[row]));
    if (position === undefined) continue;
    pairs.set(row, position);
    used.add(position);
  }

  // Match repeated steering inputs one-to-one within their turn, starting at the latest page.
  const lastUser = new Map<string, number>();
  for (let row = history.length - 1; row >= 0; row--) {
    const message = history[row];
    if (message.role !== 'user' || !message.turnId) continue;
    const match = pairs.get(row);
    if (match !== undefined) {
      lastUser.set(message.turnId, match);
      continue;
    }
    for (let position = (lastUser.get(message.turnId) ?? live.length) - 1; position >= 0; position--) {
      if (used.has(position) || !userAlias(message, live[position])) continue;
      pairs.set(row, position);
      used.add(position);
      lastUser.set(message.turnId, position);
      break;
    }
  }

  // On older adapters the archive only had byte offsets. Keep the conservative suffix
  // match, requiring a common item, a known turn, or multiple matching non-user rows.
  const legacy = new Map<number, number>();
  let upperBound = live.length;
  let supportingRows = 0;
  let anchored = false;
  for (let row = history.length - 1; row >= 0 && upperBound > 0; row--) {
    const message = history[row];
    if (!isPlacementAnchor(message) || message.codex?.kind === 'subagent') continue;
    const match = pairs.get(row);
    if (match !== undefined) {
      anchored = true;
      upperBound = Math.min(match, upperBound);
      continue;
    }
    if (message.nativeItemId || !rolloutId.test(message.id)) break;
    let position = upperBound - 1;
    while (position >= 0 && (used.has(position) || !legacyMatch(message, live[position]))) position--;
    if (position < 0) break;
    legacy.set(row, position);
    if (message.turnId) anchored = true;
    else if (message.role !== 'user') supportingRows++;
    upperBound = position;
  }
  if (anchored || supportingRows >= 2) {
    for (const [row, position] of legacy) pairs.set(row, position);
  }

  const anchors = orderedAnchors(pairs, history);
  const gaps = new Map<number, Message[]>();
  let nextAnchor = 0;
  let after = -1;
  let latestMatch = -1;
  for (let row = 0; row < history.length; row++) {
    const position = pairs.get(row);
    if (position !== undefined) {
      if (isPlacementAnchor(history[row])) latestMatch = Math.max(latestMatch, position);
      if (anchors[nextAnchor] === row) {
        after = position;
        nextAnchor++;
      }
      continue;
    }
    // Even a crossed match can constrain a later row once it fits before the next anchor.
    if (latestMatch < (pairs.get(anchors[nextAnchor]) ?? live.length)) after = latestMatch;
    const gap = gaps.get(after);
    if (gap) gap.push(history[row]);
    else gaps.set(after, [history[row]]);
  }

  const savedByPosition = new Map([...pairs].map(([row, position]) => [position, history[row]]));
  const merged = [...(gaps.get(-1) ?? [])];
  for (let position = 0; position < live.length; position++) {
    const saved = savedByPosition.get(position);
    merged.push(
      saved ? preserveArchivedMetadata(saved, live[position]) : live[position],
      ...(gaps.get(position) ?? []),
    );
  }
  return merged;
}
