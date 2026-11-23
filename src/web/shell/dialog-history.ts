import { appViewport } from './app-zoom';

const dialogs = new Map<string, HTMLDialogElement>();
let traversing = false;
let pendingNavigation: (() => void) | undefined;
let trimScheduled = false;

export const usesMobileHistory = () =>
  appViewport().windowWidth <= 700 || matchMedia('(hover: none) and (pointer: coarse)').matches;

function historyDialogs(): string[] {
  return history.state?.pocketDialogs ?? [];
}

function dismiss(id: string) {
  const dialog = dialogs.get(id);
  dialogs.delete(id);
  if (dialog?.open && dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
}

function trimClosedDialogs() {
  if (trimScheduled) return;
  trimScheduled = true;
  queueMicrotask(() => {
    trimScheduled = false;
    if (traversing) return;
    const top = historyDialogs().at(-1);
    // An explicit close consumes its temporary entry. A replacement dialog can reuse it first.
    if (top && !dialogs.has(top)) {
      traversing = true;
      history.back();
    } else if (!top && pendingNavigation) {
      const navigate = pendingNavigation;
      pendingNavigation = undefined;
      navigate();
    }
  });
}

export function handleDialogBack() {
  traversing = false;
  const remaining = new Set(historyDialogs());
  for (const id of [...dialogs.keys()].reverse()) if (!remaining.has(id)) dismiss(id);
  trimClosedDialogs();
}

export function afterDialogs(navigate: () => void) {
  if (!historyDialogs().length && !traversing) {
    navigate();
    return;
  }
  pendingNavigation = navigate;
  for (const id of [...dialogs.keys()].reverse()) dismiss(id);
  trimClosedDialogs();
}

/** Mobile browser Back closes the top modal through its ordinary cancel handler. */
export function showBackDialog(dialog: HTMLDialogElement) {
  dialog.showModal();
  if (!usesMobileHistory() || location.hash) return () => dialog.close();

  const id = crypto.randomUUID();
  const previous = historyDialogs();
  const active = previous.filter((item) => dialogs.has(item));
  const state = { ...history.state, pocketDialogs: [...active, id] };
  if (active.length < previous.length) history.replaceState(state, '');
  else history.pushState(state, '');
  dialogs.set(id, dialog);
  return () => {
    dialog.close();
    if (dialogs.delete(id)) trimClosedDialogs();
  };
}
