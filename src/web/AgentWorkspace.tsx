import { tsxComponent } from './tsx-component';
import { defineAsyncComponent, onScopeDispose, shallowRef, watch } from 'vue';
import { watchRender, writeRef, useExternalSnapshot } from './render-effects';
import { UsagePanel } from './UsagePanel';
import { uploadItems, type UploadItem } from './UploadProgress';
import { ConversationHeader } from './shell/ConversationHeader';
import { appPixels } from './shell/app-zoom';
import { NetworkConnection } from './NetworkConnection';
import { ConversationControls, type ControlSection } from './ConversationControls';
import type { ControlAction } from '../shared/controls';
import { capabilityEnabled, DEFAULT_BACKEND, type BackendInfo } from '../shared/backends';
import { mergeCodexHistory } from '../shared/codex-history';
import { downloadFile, exportSessionLog, uploadFile } from './file-client';
import { deviceSession } from './device-session';
import { RpcError as ApiError } from '../shared/rpc';
import { contentVersion } from '../shared/sync';
import type {
  GatewayStatus,
  ThreadSummary,
  ThreadView,
  Operation,
  ServerEvent,
  Message,
  ProjectSummary,
  SkillChoice,
  PluginChoice,
} from '../shared/types';
import { applyViewDelta } from '../shared/delta';
import { mergeOperation, readPending, rememberOperation } from './operation-state';
import { ModelSettings, modelLabel, settingsUpdate, type ModelUpdate } from './ModelSettings';
import { RequestCards, type RequestResponse } from './RequestCards';
import { NewConversation, type NewConversationInput } from './NewConversation';
import { FolderPickerDialog } from './FolderPickerDialog';
import { TranscriptMessages } from './TranscriptMessages';
import { TurnNavigation } from './TurnNavigation';
import { ThreadTools } from './ThreadTools';
import type { SessionToolAction } from './SessionTools';
import { ComposerToolPicker } from './ComposerToolPicker';
import { Icon } from './Icon';
import { ChatComposer } from './ChatComposer';
import { OperationFeedback, operationActivity } from './OperationFeedback';
import BrandIcon from './theme/BrandIcon.vue';
import { ThreadNavigation } from './ThreadNavigation';
import { useChatDrafts, type ChatDraft } from './chat-drafts';
import { backDestination, backTo, previousHistoryRoute, routeURL, type AppRoute } from './shell/routes';
import { usesMobileHistory } from './shell/dialog-history';
import { recordDiagnostic } from './diagnostics';
import type { CodexVoiceMode } from '../shared/codex-voice';
import {
  HISTORY_PAGES_PER_LOAD,
  HISTORY_TOP_THRESHOLD,
  HISTORY_VISIBLE_TARGET,
  RECENT_REFRESH_INTERVAL,
  TRANSCRIPT_BOTTOM_TOLERANCE,
  antigravityImages,
  antigravityStep,
  codexMessages,
  historyChanged,
  mergeAntigravityHistory,
  type HistoryRevision,
  type ThreadPage,
} from './workspace/history';
import { PairingView } from './workspace/PairingView';
import { OutgoingMessageCard } from './workspace/OutgoingMessageCard';
import { ThreadActionSheet, type WorkspaceThreadAction } from './workspace/ThreadActionSheet';
import { SessionToolsSheet } from './workspace/SessionToolsSheet';
import { useWorkbenchSidebar, WorkbenchSidebarToggle } from './workspace/WorkbenchSidebarToggle';
import { ConversationGoalSummary } from './workspace/GoalControls';
import { useConversationControlCatalog } from './workspace/conversation-control-catalog';
import { canSendOpenedThread, openForSend, openedThreadBlocked } from './workspace/open-for-send';
import {
  activeTurnChanged,
  canSendFileReferences,
  fileReferenceExtrasHint,
  onlySendsText,
  requiresFullSend,
  textOnlySendHint,
  textSteeringTurnId,
} from './workspace/codex-text-send';

const CodexVoice = defineAsyncComponent(() => import('./CodexVoice'));
const subscribeConnection = (notify: () => void) => deviceSession.onChange(notify);
const connectionSnapshot = () => deviceSession.online;

export default tsxComponent(function AgentWorkspace(_props: {
  route: AppRoute;
  navigate: (route: AppRoute, replace?: boolean) => void;
  onBusy: (busy: boolean) => void;
  onUpdateBlocked: (blocked: boolean) => void;
  active?: boolean;
}) {
  onScopeDispose(() => {
    _props.onBusy(false);
    _props.onUpdateBlocked(false);
  });
  const sidebar = useWorkbenchSidebar();
  const readControlCatalog = useConversationControlCatalog();
  const backendState = shallowRef<BackendInfo>();
  const setBackend = writeRef(backendState);
  const pairedState = shallowRef(false);
  const setPaired = writeRef(pairedState);
  const loadingState = shallowRef(true);
  const setLoading = writeRef(loadingState);
  const nameState = shallowRef('我的手机');
  const setName = writeRef(nameState);
  const deviceIdState = shallowRef('');
  const setDeviceId = writeRef(deviceIdState);
  const pairLink = new URLSearchParams(location.hash.slice(1));
  const codeState = shallowRef(pairLink.get('pair') ?? '');
  const setCode = writeRef(codeState);
  const fromPairLinkState = shallowRef(pairLink.has('pair') && !!pairLink.get('pair'));
  const setFromPairLink = writeRef(fromPairLinkState);
  const manualPairOpen = shallowRef(false);
  const statusState = shallowRef<GatewayStatus | null>(null);
  const setStatus = writeRef(statusState);
  const threadsState = shallowRef<ThreadSummary[]>([]);
  const setThreads = writeRef(threadsState);
  const cursorState = shallowRef<string | null>(null);
  const setCursor = writeRef(cursorState);
  const voiceState = shallowRef<{
    hostId: string;
    threadId: string;
    backendId: string;
    mode: CodexVoiceMode;
  }>();
  const toolsOpenState = shallowRef(false);
  const setToolsOpen = writeRef(toolsOpenState);
  const threadActionState = shallowRef<WorkspaceThreadAction>();
  const setThreadAction = writeRef(threadActionState);
  const configOpenState = shallowRef(false);
  const setConfigOpen = writeRef(configOpenState);
  const skillsOpenState = shallowRef(false);
  const setSkillsOpen = writeRef(skillsOpenState);
  const pluginsOpenState = shallowRef(false);
  const setPluginsOpen = writeRef(pluginsOpenState);
  const pickerDirtyState = shallowRef(false);
  const setPickerDirty = writeRef(pickerDirtyState);
  const newOpenState = shallowRef(false);
  const setNewOpen = writeRef(newOpenState);
  const folderPickerOpenState = shallowRef(false);
  const setFolderPickerOpen = writeRef(folderPickerOpenState);
  const newProjectState = shallowRef<string>();
  const setNewProject = writeRef(newProjectState);
  const newDirtyState = shallowRef(false);
  const setNewDirty = writeRef(newDirtyState);
  const controlRequestState = shallowRef<{
    target: ControlSection;
    sequence: number;
    threadId: string;
    anchor?: HTMLElement;
  }>();
  const setControlRequest = writeRef(controlRequestState);
  const goalOperationId = shallowRef<string>();
  const dismissedDeliveryIds = shallowRef<Set<string>>(new Set());
  const settingsDirtyState = shallowRef(false);
  const setSettingsDirty = writeRef(settingsDirtyState);
  const projectsState = shallowRef<{ projects: ProjectSummary[]; total: number; ungrouped: number }>({
    projects: [],
    total: 0,
    ungrouped: 0,
  });
  const setProjects = writeRef(projectsState);
  const projectState = shallowRef('');
  const projectRef = { current: projectState.value };
  const listRequest = { current: 0, projects: 0, running: false, paged: false };
  const listLoadingState = shallowRef(false);
  const setListLoading = writeRef(listLoadingState);
  const selectedThread = shallowRef<ThreadSummary | null>(null);
  const updateSelected = writeRef(selectedThread);
  const creationRequest: { current: string | undefined } = { current: undefined };
  const selectedId: { current: string | null } = { current: null };
  const openedCreations = { current: new Set<string>() };
  const receivedViewState = shallowRef<ThreadView | null>(null);
  const setView = writeRef(receivedViewState);
  const connection = useExternalSnapshot(subscribeConnection, connectionSnapshot);
  const hostIdState = shallowRef(pairLink.get('host') ?? '');
  const setHostId = writeRef(hostIdState);
  const readChatDrafts = useChatDrafts();
  const dispatchingDraft = { current: false };
  const uploadingState = shallowRef(false);
  const setUploading = writeRef(uploadingState);
  const uploadJobsState = shallowRef<UploadItem[]>([]);
  const setUploadJobs = writeRef(uploadJobsState);
  const uploadThreadState = shallowRef('');
  const setUploadThread = writeRef(uploadThreadState);
  const uploadLock = { current: false };
  const questionDraftsState = shallowRef(new Set<string>());
  const setQuestionDrafts = writeRef(questionDraftsState);
  const questionDraftChanged = (id: string, dirty: boolean) => {
    setQuestionDrafts((old) => {
      if (old.has(id) === dirty) return old;
      const next = new Set(old);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const threadErrorState = shallowRef('');
  const setThreadError = writeRef(threadErrorState);
  const openingForSendState = shallowRef<AbortController>();
  const waitingForOpenedThread = shallowRef(false);
  const sendPreparationError = shallowRef('');
  function cancelOpeningForSend() {
    openingForSendState.value?.abort();
    openingForSendState.value = undefined;
  }
  onScopeDispose(cancelOpeningForSend);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const operationsState = shallowRef<Operation[]>([]);
  const setOperations = writeRef(operationsState);
  const historyCursorState = shallowRef<string | null>(null);
  const setHistoryCursor = writeRef(historyCursorState);
  const historyLoadingState = shallowRef(false);
  const setHistoryLoading = writeRef(historyLoadingState);
  const historyError = shallowRef('');
  const subscriptionAttemptState = shallowRef(0);
  const setSubscriptionAttempt = writeRef(subscriptionAttemptState);
  const historyGeneration = { current: 0 };
  const historyScroll: {
    current: { top: number; height: number; anchor?: { element: Element; offset: number } } | null;
  } = { current: null };
  const olderState = shallowRef<Message[]>([]);
  const setOlder = writeRef(olderState);
  function restartHistoryPaging() {
    historyGeneration.current++;
    historyScroll.current = null;
    setHistoryLoading(false);
    setHistoryCursor('latest');
    historyError.value = '';
  }
  function resetHistory() {
    setOlder([]);
    restartHistoryPaging();
  }
  const transcriptRef = shallowRef<HTMLElement | null>(null);
  const transcriptContentRef = shallowRef<HTMLElement | null>(null);
  const followBottom = { current: true };
  const transcriptScroll = { top: 0, height: 0, maxTop: 0, touchY: undefined as number | undefined };
  function rememberTranscriptPosition(transcript: HTMLElement) {
    transcriptScroll.top = transcript.scrollTop;
    transcriptScroll.height = transcript.clientHeight;
    transcriptScroll.maxTop = transcript.scrollHeight - transcript.clientHeight;
  }
  function followTranscriptGesture(event: WheelEvent | TouchEvent, delta: number) {
    if (!delta) return;
    const transcript = event.currentTarget as HTMLElement;
    // Scrolling a code block or another inner pane may never move the transcript.
    for (
      let node = event.target instanceof Element ? event.target : null;
      node && node !== transcript;
      node = node.parentElement
    ) {
      if (node.scrollHeight > node.clientHeight && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY))
        return;
    }
    const maxTop = transcript.scrollHeight - transcript.clientHeight;
    // Stop following before a live update can undo the gesture's first scroll event.
    if (delta < 0 && maxTop > 0 && transcript.scrollTop > 0) followBottom.current = false;
    if (delta > 0 && maxTop - transcript.scrollTop <= TRANSCRIPT_BOTTOM_TOLERANCE)
      followBottom.current = true;
  }
  function scrollToLatest(transcript: HTMLElement) {
    transcript.scrollTop = transcript.scrollHeight;
    rememberTranscriptPosition(transcript);
  }
  const viewRef: { current: ThreadView | null } = { current: null };
  const operationSnapshots = { current: new Map<string, Operation>() };
  const recoveredDraft: { current: string | undefined } = { current: undefined };
  const watchBackend = watchRender();
  const watchRoute = watchRender();
  const watchControlRequest = watchRender();
  const watchRoute2 = watchRender();
  const watchToolsOpen = watchRender();
  const watchBackend2 = watchRender();
  const watchPaired = watchRender();
  const watchRecent = watchRender();
  const watchStatus = watchRender();
  const watchView = watchRender();
  const watchSlowHistory = watchRender();
  const watchModelCatalog = watchRender();
  const watchNewCreation = watchRender();
  const watchOlder = watchRender();
  const watchView2 = watchRender();
  const watchCodexActivity = watchRender();
  const watchTranscript = watchRender();
  const watchDeviceId = watchRender();
  const watchOutgoingOperation = watchRender();
  const watchOutgoingOperation2 = watchRender();
  const watchBusy = watchRender();
  const watchUpdateBlocked = watchRender();
  return ({ route, navigate, onBusy, onUpdateBlocked, active = true }) => {
    const backendId = route.backend ?? DEFAULT_BACKEND;
    const backend = backendState.value;
    const presentation = backend?.presentation;
    const codex = backend?.product === 'codex' || (!backend && backendId === DEFAULT_BACKEND);
    const antigravity = backend?.product === 'antigravity';
    const canAttach = !backend || capabilityEnabled(backend.capabilities.attachments);
    const imagesOnly = presentation?.attachmentMode === 'image';
    const emptyCreation = presentation?.creation.empty ?? false;
    const controlPlan = presentation?.plan === 'control';
    const agentName = backend?.name ?? 'Agent';
    const api = <T,>(path: string, init?: RequestInit) => deviceSession.api<T>(path, init, backendId);
    const paired = pairedState.value;
    watchBackend(() => {
      if (!paired) return;
      let alive = true;
      const refresh = () =>
        void deviceSession
          .api<{ backends: BackendInfo[] }>('/backends', undefined, backendId)
          .then((result) => {
            if (alive) setBackend(result.backends.find((b) => b.id === backendId));
          })
          .catch(() => {});
      refresh();
      const timer = setInterval(refresh, 15000);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, [
      paired,
      backendId,
      connection.value,
      statusState.value?.desktopVersion,
      JSON.stringify(statusState.value?.capabilities),
    ]);
    const loading = loadingState.value;
    const name = nameState.value;
    const deviceId = deviceIdState.value;
    const code = codeState.value;
    const fromPairLink = fromPairLinkState.value;
    const status = statusState.value;
    const canChangeModel = status?.capabilities.modelSettings === true;
    const canSelectMessageModel = status?.capabilities.nextMessageModel === true;
    const messageModelPicker = canSelectMessageModel && !canChangeModel;
    const threads = threadsState.value;
    const cursor = cursorState.value;
    const toolsOpen = toolsOpenState.value;
    const threadAction = threadActionState.value;
    const configOpen = configOpenState.value;
    const skillsOpen = skillsOpenState.value;
    const pluginsOpen = pluginsOpenState.value;
    const pickerDirty = pickerDirtyState.value;
    const newOpen = newOpenState.value;
    const newProject = newProjectState.value;
    const newDirty = newDirtyState.value;
    const controlRequest = controlRequestState.value;
    const settingsDirty = settingsDirtyState.value;

    const projects = projectsState.value;
    const project = projectState.value;

    projectRef.current = project;

    const listLoading = listLoadingState.value;
    const selectedState = selectedThread.value;
    // Replayed operation history is not a new navigation request.

    watchRoute(() => {
      creationRequest.current = undefined;
      voiceState.value = undefined;
      cancelOpeningForSend();
      sendPreparationError.value = '';
    }, [route.thread, route.host, backendId, active]);
    // The URL is the selection authority; previous cached metadata must never win a click.
    const selected =
      route.thread && (!route.host || route.host === deviceSession.host?.hostId)
        ? selectedState?.id === route.thread
          ? selectedState
          : (threads.find((thread) => thread.id === route.thread) ?? null)
        : null;
    watchControlRequest(() => {
      setControlRequest(undefined);
      setToolsOpen(false);
      setThreadAction(undefined);
    }, [selected?.id, deviceId, backendId]);
    function setSelected(thread: ThreadSummary | null, replace = false) {
      creationRequest.current = undefined;
      updateSelected(thread);
      navigate({ page: 'workbench', backend: backendId, ...(thread ? { thread: thread.id } : {}) }, replace);
    }
    watchRoute2(() => {
      if (route.page !== 'workbench') return;
      if (route.host && route.host !== deviceSession.host?.hostId) {
        updateSelected(null);
        return;
      }
      if (route.thread === 'new' && emptyCreation) {
        updateSelected({ id: 'new', title: `新建 ${agentName} 会话`, cwd: '', updatedAt: Date.now() });
        return;
      }
      if (!route.thread) {
        updateSelected(null);
        return;
      }
      if (selectedState?.id === route.thread) return;
      let alive = true;
      const known = threads.find((t) => t.id === route.thread);
      if (known) updateSelected(known);
      else
        void deviceSession
          .cachedThread(route.thread, backendId)
          .then(
            (cached) =>
              cached ??
              api<{ thread: ThreadSummary }>(`/threads/${encodeURIComponent(route.thread!)}`).then(
                (result) => result.thread,
              ),
          )
          .then((thread) => {
            if (alive && thread.id === route.thread) updateSelected(thread);
          })
          .catch((error: unknown) => {
            if (alive && error instanceof ApiError && [403, 404].includes(error.status))
              navigate({ page: 'workbench', backend: backendId }, true);
          });
      return () => {
        alive = false;
      };
    }, [
      route.page, route.thread, route.host, backendId, paired, emptyCreation, threads, selectedState?.id,
      connection.value,
    ]);

    selectedId.current = selected?.id ?? null;
    const receivedView = receivedViewState.value;
    const view = receivedView?.id === selected?.id ? receivedView : null;
    const currentModel =
      view?.modelName ?? (/^MODEL_PLACEHOLDER_/.test(view?.model ?? '') ? 'Antigravity 模型' : view?.model);
    const stream = connection.value;
    const voice = voiceState.value;
    const pairedHost = deviceSession.host;
    const voiceHost = pairedHost?.hostId;
    const sameSendScope = (threadId: string) =>
      _props.active !== false &&
      _props.route.page === 'workbench' &&
      _props.route.thread === threadId &&
      _props.route.host === route.host &&
      (_props.route.backend ?? DEFAULT_BACKEND) === backendId &&
      selectedId.current === threadId &&
      deviceIdState.value === deviceId &&
      deviceSession.host?.hostId === pairedHost?.hostId &&
      deviceSession.host?.deviceId === pairedHost?.deviceId &&
      deviceSession.online;
    const voiceMode = status?.capabilities.voice ? status.capabilities.voiceMode : undefined;
    const voiceOpen =
      active &&
      voice?.hostId === voiceHost &&
      voice?.threadId === selected?.id &&
      voice?.backendId === backendId;
    const hostId = hostIdState.value;
    const drafts = readChatDrafts(deviceId, selected?.id ?? null);
    const messageModel = drafts.draft.model;
    const textOnlySend = !!selected && onlySendsText(view, selected.id);
    const canSelectSkills = !textOnlySend && (!backend || capabilityEnabled(backend.capabilities.skills));
    const canSelectPlugins = !textOnlySend && (!backend || capabilityEnabled(backend.capabilities.plugins));
    const allowsFileReferences = (latest: ThreadView | null, threadId: string) => {
      const current = backendState.value;
      return current?.id === backendId && capabilityEnabled(current.capabilities.attachments) &&
        canSendFileReferences(latest, threadId);
    };
    const fileReferences = textOnlySend && !!selected && allowsFileReferences(view, selected.id);
    const canAttachToThread = textOnlySend ? fileReferences : canAttach;
    const running = !!view?.activeTurnId || (textOnlySend && view?.runtimeStatus === 'active');
    const canSteer = textOnlySend
      ? !!selected &&
        status?.writesEnabled === true &&
        status.capabilities.steer === true &&
        !!textSteeringTurnId(view, selected.id)
      : (status?.capabilities.steer ?? !antigravity) &&
        (!antigravity || (view?.synchronized === true && view.canSteer === true));
    const unsupportedSendDraft = textOnlySend && requiresFullSend(drafts.draft, fileReferences);

    const { text: draft, uploads, skills: selectedSkills, plugins: selectedPlugins } = drafts.draft;
    function setSelectedSkills(value: SkillChoice[] | ((old: SkillChoice[]) => SkillChoice[])) {
      if (selected)
        drafts.update(selected.id, (d) => ({
          ...d,
          skills: typeof value === 'function' ? value(d.skills) : value,
        }));
    }
    function setSelectedPlugins(value: PluginChoice[] | ((old: PluginChoice[]) => PluginChoice[])) {
      if (selected)
        drafts.update(selected.id, (d) => ({
          ...d,
          plugins: typeof value === 'function' ? value(d.plugins) : value,
        }));
    }

    const uploading = uploadingState.value;
    const uploadJobs = uploadJobsState.value;
    const uploadThread = uploadThreadState.value;

    watchToolsOpen(() => {
      setToolsOpen(false);
      setConfigOpen(false);
      setSkillsOpen(false);
      setPluginsOpen(false);
    }, [selected?.id]);
    const questionDrafts = questionDraftsState.value;

    const error = errorState.value;
    const threadError = threadErrorState.value;
    const openingForSend = !!openingForSendState.value;
    const openingActivity = openingForSend
      ? (waitingForOpenedThread.value ? '正在等待会话同步…' : '正在打开会话…')
      : undefined;
    const busy = busyState.value || openingForSend;
    const operations = operationsState.value;
    const latestOperation = operations[0];
    const controlCatalog = readControlCatalog({
      backendId,
      backend,
      deviceId,
      threadId: view?.id,
      connected: active && stream,
      state: view?.controls,
      refresh: latestOperation
        ? `${latestOperation.id}:${latestOperation.state}:${latestOperation.updatedAt}`
        : '',
      turnId: view?.activeTurnId,
    });
    const requestControl = (target: ControlSection, anchor?: HTMLElement) => {
      if (!view) return;
      setControlRequest((previous) => ({
        threadId: view.id,
        target,
        anchor,
        sequence: (previous?.sequence ?? 0) + 1,
      }));
    };
    const historyCursor = historyCursorState.value;
    const historyLoading = historyLoadingState.value;
    const subscriptionAttempt = subscriptionAttemptState.value;

    const older = olderState.value;

    function receiveOperation(operation: Operation) {
      const previous = operationSnapshots.current.get(operation.id);
      // Apply the same ordering rule before journal writes and draft side effects.
      // Otherwise a late receipt could resurrect a confirmed request after reload.
      if (previous && mergeOperation([previous], operation)[0] !== operation) return;
      operationSnapshots.current.set(operation.id, operation);
      if (creationRequest.current === operation.id && ['failed', 'rejected'].includes(operation.state))
        creationRequest.current = undefined;
      if (operationSnapshots.current.size > 256)
        operationSnapshots.current.delete(operationSnapshots.current.keys().next().value!);
      rememberOperation(deviceId, operation);
      drafts.settle(operation);
      if (operation.kind === 'rename' && operation.state === 'completed' && previous?.state !== 'completed') {
        void api<{ thread: ThreadSummary }>(`/threads/${encodeURIComponent(operation.threadId)}`)
          .then(({ thread }) => {
            updateSelected((old) => (old?.id === thread.id ? thread : old));
            setThreads((old) => old.map((item) => (item.id === thread.id ? thread : item)));
            setThreadAction((old) => (old?.requestId === operation.id ? undefined : old));
          })
          .catch(() => {
            if (selectedId.current === operation.threadId) setError('改名已确认，请刷新会话列表查看。');
          });
      }
      if (
        (operation.kind === 'create' || operation.kind === 'fork') &&
        creationRequest.current === operation.id &&
        operation.state === 'completed' &&
        operation.resultThreadId &&
        selectedId.current === operation.threadId &&
        !openedCreations.current.has(operation.id)
      ) {
        openedCreations.current.add(operation.id);
        if (operation.kind === 'create') {
          try {
            localStorage.removeItem(deviceSession.contentKey(`new-conversation:${operation.threadId}`));
          } catch {
            /* Keep live confirmation usable when storage is unavailable. */
          }
        }
        void api<{ thread: ThreadSummary }>(`/threads/${encodeURIComponent(operation.resultThreadId)}`)
          .then((result) => {
            if (creationRequest.current === operation.id && selectedId.current === operation.threadId) {
              setSelected(result.thread, selectedId.current === 'new');
              setNewOpen(false);
            }
            void loadThreads();
          })
          .catch(() => {
            if (creationRequest.current === operation.id) setError('新会话已建立，请刷新会话列表查看。');
          });
      }
      if (selectedId.current === operation.threadId) setOperations((old) => mergeOperation(old, operation));
    }
    watchBackend2(() => {
      if (location.hash) history.replaceState(history.state, '', routeURL(route));
      void api<{ device: { id: string }; status?: GatewayStatus }>('/session')
        .then((r) => {
          setDeviceId(backendId === DEFAULT_BACKEND ? r.device.id : `${r.device.id}:${backendId}`);
          setPaired(true);
          setStatus(r.status ?? null);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, []);
    function applyRecent(page: ThreadPage, keepPages: boolean) {
      const current = selectedThread.value;
      const fresh = current && page.threads.find((thread) => thread.id === current.id);
      if (
        fresh &&
        current &&
        (fresh.title !== current.title ||
          fresh.cwd !== current.cwd ||
          fresh.updatedAt !== current.updatedAt ||
          fresh.projectId !== current.projectId ||
          fresh.projectName !== current.projectName)
      )
        updateSelected(fresh);
      const old = threadsState.value;
      const incoming = new Set(page.threads.map((thread) => thread.id));
      const rows = keepPages
        ? [...page.threads, ...old.filter((thread) => !incoming.has(thread.id))].sort(
            (a, b) => b.updatedAt - a.updatedAt,
          )
        : page.threads;
      if (contentVersion(rows) !== contentVersion(old)) setThreads(rows);
      if (!keepPages) setCursor(page.nextCursor);
    }
    const loadThreads = async (next?: string, quiet = false, signal?: AbortSignal) => {
      if (quiet && (listRequest.running || !deviceSession.online)) return;
      const filter = projectRef.current;
      const generation = ++listRequest.current;
      const current = () =>
        !signal?.aborted && generation === listRequest.current && projectRef.current === filter;
      listRequest.running = true;
      if (!quiet) setListLoading(true);
      try {
        const query = new URLSearchParams();
        if (next) query.set('cursor', next);
        if (filter) query.set('project', filter);
        if (!next && !quiet && !threadsState.value.length) {
          const cached = await deviceSession.cached<ThreadPage>(`/threads?${query}`, backendId);
          if (cached && current()) applyRecent(cached, false);
          const cachedProjects = await deviceSession.cached<typeof projects>('/projects', backendId);
          if (cachedProjects && current()) setProjects(cachedProjects);
        }
        if (!next && !deviceSession.online) return;
        if (!next && !quiet) {
          const catalog = ++listRequest.projects;
          void api<typeof projects>('/projects')
            .then((result) => {
              if (catalog === listRequest.projects) setProjects({ ...result });
            })
            .catch(() => {});
        }
        const data = await api<ThreadPage>(`/threads?${query}`);
        if (!current()) return;
        if (next) {
          const combined = new Map(threadsState.value.map((thread) => [thread.id, thread]));
          for (const thread of data.threads) combined.set(thread.id, thread);
          setThreads([...combined.values()].sort((a, b) => b.updatedAt - a.updatedAt));
          setCursor(data.nextCursor);
          listRequest.paged = true;
        } else {
          applyRecent(data, quiet && listRequest.paged && data.nextCursor !== null);
          if (!quiet || data.nextCursor === null) listRequest.paged = false;
        }
      } catch {
        // Keep the cached list available. Reconnect or a manual refresh will check it again.
      } finally {
        if (generation === listRequest.current) {
          listRequest.running = false;
          if (!quiet) setListLoading(false);
        }
      }
    };
    watchPaired(() => {
      if (paired) void loadThreads();
    }, [paired, project, stream]);
    watchModelCatalog(() => {
      if (active && stream && view)
        void deviceSession.refreshModelCatalog(backendId).catch(() => {});
    }, [active, stream, !!view, deviceId, backendId]);
    watchRecent(() => {
      if (!active || !paired || !stream) return;
      const controller = new AbortController();
      const refresh = () => {
        if (document.visibilityState !== 'hidden') void loadThreads(undefined, true, controller.signal);
      };
      const timer = setInterval(refresh, RECENT_REFRESH_INTERVAL);
      document.addEventListener('visibilitychange', refresh);
      refresh();
      return () => {
        controller.abort();
        clearInterval(timer);
        document.removeEventListener('visibilitychange', refresh);
      };
    }, [active, paired, stream, project]);
    watchStatus(() => {
      const update = () => {
        setStatus(deviceSession.backendStatus(backendId) ?? null);
        if (!deviceSession.online) {
          cancelOpeningForSend();
          setView((old) =>
            old
              ? {
                  ...old,
                  synchronized: false,
                  boundedQuestionAvailable: false,
                  canResumeForSend: false,
                  textOnlySend: false,
                  canSendFileReferences: false,
                  canSend: false,
                  canInterrupt: false,
                  reason: null,
                }
              : old,
          );
        }
      };
      update();
      const unsubscribe = deviceSession.onChange(update);
      if (!active || !paired || !stream) return unsubscribe;
      const refresh = () => {
        if (document.visibilityState !== 'hidden') void api<GatewayStatus>('/status').catch(() => {});
      };
      refresh();
      const timer = setInterval(refresh, RECENT_REFRESH_INTERVAL);
      document.addEventListener('visibilitychange', refresh);
      return () => {
        unsubscribe();
        clearInterval(timer);
        document.removeEventListener('visibilitychange', refresh);
      };
    }, [active, paired, stream, backendId]);
    watchView(() => {
      if (!selected) return;
      const id = selected.id;
      let disposed = false;
      setView(null);
      viewRef.current = null;
      resetHistory();
      transcriptScroll.top = 0;
      transcriptScroll.touchY = undefined;
      const savedOperations = readPending(deviceId, id);
      setOperations(savedOperations);
      const savedCreation = id === 'new' && savedOperations.find((operation) => operation.kind === 'create');
      if (savedCreation) {
        creationRequest.current = savedCreation.id;
        setNewOpen(true);
      }
      setError('');
      setThreadError('');
      followBottom.current = true;
      for (const operation of savedOperations)
        void api<Operation>(`/operations/${operation.id}`)
          .then((result) => {
            if (!disposed) receiveOperation(result);
          })
          .catch(() => {});
      // The empty workspace has no native conversation to subscribe to.
      const unsubscribe =
        id === 'new'
          ? undefined
          : deviceSession.subscribe(
              id,
              (data) => {
                if (disposed || selectedId.current !== id) return;
                if (data.type === 'status') setStatus(data.status);
                else if (data.type === 'thread' && data.thread.id === id) {
                  const previous = viewRef.current;
                  const antigravityHistory =
                    backendState.value?.product === 'antigravity' && previous?.id === id;
                  if (antigravityHistory && historyChanged(previous, data.thread)) resetHistory();
                  if (
                    antigravityHistory &&
                    (historyCursorState.value !== 'latest' ||
                      historyLoadingState.value ||
                      olderState.value.length)
                  ) {
                    const incoming = data.thread.messages[0];
                    const first = antigravityStep(incoming);
                    const previousFirst = antigravityStep(previous.messages[0]);
                    const previousLast = antigravityStep(previous.messages.at(-1));
                    const last = antigravityStep(data.thread.messages.at(-1));
                    const overlap = previous.messages.find((message) => message.id === incoming?.id);
                    if (
                      first !== undefined &&
                      previousFirst !== undefined &&
                      first > previousFirst &&
                      previousLast !== undefined &&
                      last !== undefined &&
                      last >= previousLast
                    ) {
                      const sameTrajectory =
                        previous.historyTrajectoryId &&
                        previous.historyTrajectoryId === data.thread.historyTrajectoryId;
                      const sameHistory =
                        sameTrajectory || (overlap?.turnId && overlap.turnId === incoming?.turnId);
                      // A bounded live window can move past records the user has read.
                      // Older adapters prove continuity by an overlapping execution.
                      if (sameHistory) {
                        const evicted = previous.messages.filter(
                          (message) => (antigravityStep(message) ?? first) < first,
                        );
                        if (evicted.length) setOlder((older) => mergeAntigravityHistory(older, evicted));
                        if (first > previousLast + 1) restartHistoryPaging();
                      } else {
                        resetHistory();
                      }
                    }
                  }
                  viewRef.current = data.thread;
                  setView(data.thread);
                  if (data.thread.title && data.thread.title !== '未命名会话') {
                    const liveTitle = data.thread.title;
                    const liveUpdated = data.thread.updatedAt;
                    setThreads((old) => {
                      const idx = old.findIndex((item) => item.id === data.thread.id);
                      if (idx < 0) return old;
                      const current = old[idx];
                      if (current.title === liveTitle && current.updatedAt >= liveUpdated) return old;
                      const next = old.slice();
                      next[idx] = {
                        ...current,
                        title: liveTitle,
                        updatedAt: Math.max(current.updatedAt, liveUpdated),
                      };
                      return next;
                    });
                    updateSelected((old) =>
                      old?.id === data.thread.id && old.title !== liveTitle
                        ? { ...old, title: liveTitle, updatedAt: Math.max(old.updatedAt, liveUpdated) }
                        : old,
                    );
                  }
                  setThreadError('');
                } else if (data.type === 'error') setThreadError(data.message);
                else if (data.type === 'operation') receiveOperation(data.operation);
              },
              backendId,
            );
      return () => {
        disposed = true;
        historyGeneration.current++;
        unsubscribe?.();
      };
    }, [selected?.id, deviceId, backendId, subscriptionAttempt]);
    watchSlowHistory(() => {
      if (!active || !stream || view || threadError || !selected || selected.id === 'new') return;
      const id = selected.id;
      const timer = setTimeout(() => {
        if (selectedId.current !== id || viewRef.current) return;
        setThreadError('读取会话超时');
        const transport = deviceSession.networkStatus.control;
        if (transport)
          recordDiagnostic({ code: 'workbench-history-slow', page: 'workbench', transport, elapsedMs: 15000 });
      }, 15000);
      return () => clearTimeout(timer);
    }, [active, stream, deviceId, backendId, selected?.id, !!view, !!threadError, subscriptionAttempt]);
    watchOlder(() => {
      const previous = historyScroll.current;
      const transcript = transcriptRef.value;
      if (transcript && followBottom.current) {
        scrollToLatest(transcript);
      } else if (previous && transcript) {
        const anchor = previous.anchor;
        if (anchor && transcript.contains(anchor.element)) {
          const offset = anchor.element.getBoundingClientRect().top - transcript.getBoundingClientRect().top;
          transcript.scrollTop += appPixels(offset) - anchor.offset;
        } else {
          transcript.scrollTop = previous.top + transcript.scrollHeight - previous.height;
        }
        rememberTranscriptPosition(transcript);
      }
      historyScroll.current = null;
    }, [older]);
    watchView2(() => {
      const transcript = transcriptRef.value;
      if (followBottom.current && transcript) scrollToLatest(transcript);
    }, [view?.messages]);
    const transcript = transcriptRef.value;
    const transcriptContent = transcriptContentRef.value;
    watchTranscript(() => {
      if (!transcript || !transcriptContent) return;
      rememberTranscriptPosition(transcript);
      const observer = new ResizeObserver(() => {
        const height = transcript.clientHeight;
        if (!height) return;
        if (followBottom.current) scrollToLatest(transcript);
        else if (height !== transcriptScroll.height) {
          transcript.scrollTop = transcriptScroll.top;
          rememberTranscriptPosition(transcript);
        }
      });
      observer.observe(transcript);
      observer.observe(transcriptContent);
      return () => observer.disconnect();
    }, [transcript, transcriptContent]);
    async function pair(e: SubmitEvent) {
      e.preventDefault();
      if (busyState.value || !hostId.trim() || !code.trim() || !name.trim()) return;
      setBusy(true);
      setError('');
      try {
        const result = await deviceSession.pair(hostId.trim(), code.trim(), name);
        setDeviceId(backendId === DEFAULT_BACKEND ? result.deviceId : `${result.deviceId}:${backendId}`);
        setCode('');
        setPaired(true);
        setStatus(await api('/status'));
        navigate({ page: 'workbench', backend: backendId }, true);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    }
    async function act(
      kind: Exclude<Operation['kind'], 'open'>,
      settings?:
        | ModelUpdate
        | RequestResponse
        | NewConversationInput
        | { messageId: string }
        | { title: string }
        | { lastTurnId: string }
        | { control: ControlAction },
      retryDraft?: ChatDraft,
    ) {
      if (!selected || (!view && !['create', 'rename', 'fork'].includes(kind))) return;
      if (kind === 'respond') {
        const current = receivedViewState.value;
        if (current?.id !== selected.id || selectedId.current !== selected.id || !canRespondToRequests(current))
          return;
        const question = boundedAntigravityQuestion(current);
        if (
          question &&
          (!settings ||
            !('answers' in settings) ||
            !settings.answers ||
            settings.targetRequestId !== question.id ||
            settings.expectedTurnId !== question.turnId ||
            settings.expectedFingerprint !== question.fingerprint)
        )
          return;
      }
      const isSend = kind === 'send' || kind === 'steer' || kind === 'queue';
      if (isSend && dispatchingDraft.current) return;
      const submitted = retryDraft ?? drafts.draft;
      const latest = receivedViewState.value;
      if (kind === 'send' && onlySendsText(latest, selected.id)) {
        if (!canSendOpenedThread(latest, selected.id) || statusState.value?.writesEnabled !== true) {
          sendPreparationError.value = latest?.reason || openedThreadBlocked;
          return;
        }
        const allowsFiles = allowsFileReferences(latest, selected.id);
        if (requiresFullSend(submitted, allowsFiles)) {
          sendPreparationError.value = allowsFiles ? fileReferenceExtrasHint : textOnlySendHint;
          return;
        }
      }
      if (kind === 'steer' && (textOnlySend || onlySendsText(latest, selected.id))) {
        const threadDraft = drafts.readCurrent();
        const original = retryDraft ? threadDraft?.outgoing?.draft : threadDraft?.draft;
        if (original !== submitted || !sameSendScope(selected.id)) return;
        const liveStatus = statusState.value;
        if (
          !view?.activeTurnId ||
          textSteeringTurnId(latest, selected.id) !== view.activeTurnId ||
          liveStatus?.writesEnabled !== true ||
          liveStatus.capabilities.steer !== true
        ) {
          sendPreparationError.value = latest?.reason || activeTurnChanged;
          return;
        }
        const allowsFiles = allowsFileReferences(latest, selected.id);
        if (requiresFullSend(submitted, allowsFiles)) {
          sendPreparationError.value = allowsFiles ? fileReferenceExtrasHint : textOnlySendHint;
          return;
        }
      }
      if (isSend && submitted.model && (kind !== 'send' || !canSelectMessageModel)) {
        setError(
          kind === 'send'
            ? '当前适配器无法使用所选模型，请移除模型选择或重新连接后再试。'
            : '所选模型仅用于直接发送，请等待当前执行结束再发送。',
        );
        return;
      }
      setBusy(true);
      setError('');
      const requestId = crypto.randomUUID();
      if (kind === 'control' && settings && 'control' in settings && settings.control.action === 'goal')
        goalOperationId.value = requestId;
      const body =
        kind === 'queue'
          ? { requestId, text: submitted.text, expectedQueueFingerprint: view?.queueFingerprint }
          : kind === 'queue-remove'
            ? { requestId, ...settings, expectedQueueFingerprint: view?.queueFingerprint }
            : ['control', 'settings', 'respond', 'create', 'rename', 'fork'].includes(kind)
              ? { requestId, ...settings }
              : kind === 'send'
                ? {
                    requestId,
                    text: submitted.text,
                    uploadIds: submitted.uploads.map((u) => u.id),
                    skillIds: submitted.skills.map((s) => s.id),
                    pluginIds: submitted.plugins.map((s) => s.id),
                    ...(submitted.model && { model: submitted.model.id }),
                  }
                : kind === 'steer'
                  ? {
                      requestId,
                      text: submitted.text,
                      uploadIds: submitted.uploads.map((u) => u.id),
                      expectedTurnId: view?.activeTurnId,
                    }
                  : { requestId, expectedTurnId: view?.activeTurnId };
      const pendingOperation: Operation = {
        id: requestId,
        threadId: selected.id,
        kind,
        state: 'received',
        turnId: kind === 'interrupt' || kind === 'steer' ? (view?.activeTurnId ?? null) : null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      try {
        if (kind === 'create' || kind === 'fork') creationRequest.current = requestId;
        if (kind === 'rename' || kind === 'fork') {
          setThreadAction((old) => (old?.kind === kind ? { ...old, requestId } : old));
        }
        receiveOperation(pendingOperation);
        if (isSend) {
          drafts.submit(pendingOperation, submitted, !!retryDraft);
          dispatchingDraft.current = true;
          followBottom.current = true;
          if (!retryDraft) setUploadJobs([]);
        }
      } catch {
        if (creationRequest.current === requestId) creationRequest.current = undefined;
        if (operationSnapshots.current.has(requestId)) {
          // The request was never dispatched. Clean up its journal entry if the draft write failed.
          try {
            receiveOperation({ ...pendingOperation, state: 'rejected', updatedAt: Date.now() });
          } catch {}
        }
        setError('浏览器无法保存草稿或请求标识，本次操作未发送');
        setBusy(false);
        return;
      }
      try {
        const operation = await api<Operation>(
          `/threads/${encodeURIComponent(selected.id)}/${kind === 'send' ? 'messages' : kind === 'respond' ? 'responses' : kind}`,
          { method: 'POST', body: JSON.stringify(body) },
        );
        receiveOperation(operation);
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          receiveOperation({
            ...pendingOperation,
            state: 'rejected',
            error: e.message,
            updatedAt: Date.now(),
          });
          return;
        }
        try {
          receiveOperation(await api<Operation>(`/operations/${requestId}`));
        } catch {
          receiveOperation({
            ...pendingOperation,
            state: 'uncertain',
            error: '未获得最终结果，请在原实例核对',
            updatedAt: Date.now(),
          });
        }
      } finally {
        if (isSend) dispatchingDraft.current = false;
        setBusy(false);
      }
      return requestId;
    }
    async function uploadFiles(files: FileList | File[] | null) {
      if (!selected || !files || uploadLock.current) return;
      const latest = receivedViewState.value;
      if (onlySendsText(latest, selected.id) && !allowsFileReferences(latest, selected.id)) return;
      const threadId = selected.id,
        list = Array.from(files);
      if (!list.length) return;
      if (
        imagesOnly &&
        list.some((file) => {
          const genericType = !file.type || file.type === 'application/octet-stream';
          return genericType
            ? !/\.(?:png|jpe?g|webp|gif)$/i.test(file.name)
            : !antigravityImages.includes(file.type);
        })
      ) {
        setError('此会话只能添加 PNG、JPEG、WebP 或 GIF 图片');
        return;
      }
      if (uploads.length + list.length > 10) {
        setError('每条消息最多 10 个附件');
        return;
      }
      const jobs = uploadItems(list);
      uploadLock.current = true;
      setUploadThread(threadId);
      setUploadJobs(jobs);
      setUploading(true);
      setError('');
      const update = (index: number, value: Partial<UploadItem>) =>
        setUploadJobs((old) => old.map((job) => (job.id === jobs[index].id ? { ...job, ...value } : job)));
      try {
        for (let i = 0; i < list.length; i++) {
          update(i, { state: 'active' });
          try {
            const done = await uploadFile(threadId, list[i], (progress) => update(i, progress));
            drafts.update(threadId, (d) => ({ ...d, uploads: [...d.uploads, done] }));
            update(i, { state: 'done' });
          } catch (e) {
            update(i, { state: 'failed', error: (e as Error).message });
          }
        }
      } finally {
        uploadLock.current = false;
        setUploading(false);
      }
    }
    async function loadOlder() {
      let cursor = historyCursorState.value;
      if (!selected || !view || !cursor || historyLoadingState.value) return;
      const id = selected.id;
      const generation = ++historyGeneration.current;
      // Keep Codex overlaps as anchors, even when the live window currently contains them.
      const cached = olderState.value;
      const known = new Set(
        [...cached, ...(codex ? [] : (viewRef.current?.messages ?? []))].map((message) => message.id),
      );
      const cachedCodex = codex ? codexMessages(cached) : [];
      let added: Message[] = [];
      let visible = 0;
      setHistoryLoading(true);
      historyError.value = '';
      try {
        for (
          let index = 0;
          cursor && index < HISTORY_PAGES_PER_LOAD && visible < HISTORY_VISIBLE_TARGET;
          index++
        ) {
          const query: string = cursor === 'latest' ? '' : `?cursor=${encodeURIComponent(cursor)}`;
          const observedView = viewRef.current;
          const page: {
            messages: Message[];
            nextCursor: string | null;
            thread?: HistoryRevision;
          } = await api(`/threads/${encodeURIComponent(id)}/history${query}`);
          if (selectedId.current !== id || generation !== historyGeneration.current) return;
          // A history page may come from cache. Only the live subscription resets history.
          if (antigravity && page.thread && historyChanged(observedView, page.thread)) break;
          const unique = page.messages.filter((message) => {
            if (known.has(message.id)) return false;
            known.add(message.id);
            return true;
          });
          added = [...unique, ...added];
          if (codex) {
            const latest = viewRef.current;
            const current = codexMessages(latest?.messages ?? [], latest?.activeTurnId);
            visible =
              mergeCodexHistory([...codexMessages(added), ...cachedCodex], current).length -
              mergeCodexHistory(cachedCodex, current).length;
          } else visible += unique.length;
          cursor = page.nextCursor === cursor ? null : page.nextCursor;
        }
      } catch (e) {
        if (generation === historyGeneration.current && !(e instanceof ApiError && e.status === 0))
          historyError.value = (e as Error).message;
      } finally {
        if (selectedId.current === id && generation === historyGeneration.current) {
          const transcript = transcriptRef.value;
          if (transcript && (added.length || cursor !== historyCursorState.value)) {
            if (!followBottom.current) {
              const { top, bottom } = transcript.getBoundingClientRect();
              let anchor: NonNullable<typeof historyScroll.current>['anchor'];
              // Older Codex pages can insert rows below the current viewport as well as above it.
              if (codex && transcriptContentRef.value) {
                for (const element of transcriptContentRef.value.children) {
                  if (element.classList.contains('older')) continue;
                  const bounds = element.getBoundingClientRect();
                  if (bounds.bottom <= top || bounds.top >= bottom) continue;
                  anchor = { element, offset: appPixels(bounds.top - top) };
                  break;
                }
              }
              historyScroll.current = { top: transcript.scrollTop, height: transcript.scrollHeight, anchor };
            }
            setOlder((old) => (antigravity ? mergeAntigravityHistory(added, old) : [...added, ...old]));
          }
          setHistoryCursor(cursor);
          if (visible > 0 || !cursor)
            setView((previous) =>
              previous?.historyUnavailable
                ? {
                    ...previous,
                    historyUnavailable: false,
                    reason: '历史记录已读取。请在电脑上的 Codex 打开此会话后开始控制。',
                  }
                : previous,
            );
          setHistoryLoading(false);
        }
      }
    }
    const currentOperations = operations.filter((operation) => operation.threadId === selected?.id);
    const goalOperation = currentOperations.find((operation) => operation.id === goalOperationId.value);
    const goalOperationError =
      goalOperation && ['rejected', 'failed', 'uncertain'].includes(goalOperation.state)
        ? goalOperation.error || '无法确认目标操作结果'
        : undefined;
    const virtualCreation =
      selected?.id === 'new'
        ? currentOperations.find(
            (operation) =>
              operation.kind === 'create' && ['received', 'dispatching', 'accepted'].includes(operation.state),
          )?.id
        : undefined;
    watchNewCreation(() => {
      if (!virtualCreation || !stream) return;
      let disposed = false;
      let timer: ReturnType<typeof setTimeout>;
      const check = async () => {
        try {
          const operation = await api<Operation>(`/operations/${virtualCreation}`);
          if (!disposed && selectedId.current === 'new') receiveOperation(operation);
        } catch {
          // The receipt might not have reached the adapter yet, or the link may be reconnecting.
        }
        if (!disposed) timer = setTimeout(check, 1000);
      };
      timer = setTimeout(check, 1000);
      return () => {
        disposed = true;
        clearTimeout(timer);
      };
    }, [virtualCreation, stream, deviceId, backendId]);
    const threadActionOperation = currentOperations.find(
      (operation) => operation.id === threadAction?.requestId,
    );
    const needsOpen = !!view && !textOnlySend && (!view.owner || view.runtimeStatus === 'notLoaded');
    const visibleOperations = currentOperations.filter((operation) => operation.kind !== 'open');
    const blocksSend = (operation?: Operation) =>
      !!operation &&
      operation.kind !== 'open' &&
      ['received', 'dispatching', 'uncertain'].includes(operation.state);
    const pending = [drafts.outgoing?.operation, ...currentOperations].some(blocksSend);
    function boundedAntigravityQuestion(current: ThreadView | null) {
      const currentBackend = backendState.value;
      if (
        currentBackend?.id !== backendId ||
        currentBackend.product !== 'antigravity' ||
        !deviceSession.backendStatus(backendId)?.capabilities.questions ||
        current?.boundedQuestionAvailable !== true ||
        current.owner ||
        current.synchronized ||
        current.requests?.length !== 1
      )
        return undefined;
      const [question] = current.requests;
      return question.kind === 'question' && question.actionable && question.fingerprint && question.questions?.length
        ? question
        : undefined;
    }
    function canRespondToRequests(current: ThreadView | null) {
      return (
        !busyState.value &&
        !openingForSendState.value &&
        !pending &&
        stream &&
        deviceSession.online &&
        !threadErrorState.value &&
        statusState.value?.writesEnabled === true &&
        ((current?.owner === true && current.synchronized === true) || !!boundedAntigravityQuestion(current))
      );
    }
    const canCreateConversation =
      !!status?.writesEnabled && status.capabilities.newThread && !busy && !uploading;
    const delivery =
      visibleOperations.find((x) => ['received', 'dispatching', 'uncertain'].includes(x.state)) ??
      visibleOperations[0];
    const canCompose =
      stream &&
      !!view?.synchronized &&
      (textOnlySend
        ? canSteer || (!!selected && canSendOpenedThread(view, selected.id) && status?.writesEnabled === true)
        : view.canSend || (view.canInterrupt && view.pendingRequests === 0));
    const canOpenForSend =
      stream && needsOpen && !canCompose && !!status?.writesEnabled && !!status.capabilities.openThread;
    async function sendDraft() {
      if (openingForSendState.value || !selected || (running && !canSteer)) return;
      sendPreparationError.value = '';
      if (!canOpenForSend) {
        await act(view?.activeTurnId ? 'steer' : 'send');
        return;
      }
      const threadId = selected.id;
      const submitted = drafts.draft;
      const draftUnchanged = () => drafts.readCurrent()?.draft === submitted;
      if (!draftUnchanged()) return;
      const requestId = crypto.randomUUID();
      const attempt = new AbortController();
      waitingForOpenedThread.value = false;
      openingForSendState.value = attempt;
      const current = () => openingForSendState.value === attempt && sameSendScope(threadId);
      let readyToSend = false;
      try {
        const result = await openForSend({
          threadId,
          requestId,
          signal: attempt.signal,
          current: () => current() && draftUnchanged(),
          open: () =>
            api<Operation>(`/threads/${encodeURIComponent(threadId)}/open`, {
              method: 'POST',
              body: JSON.stringify({ requestId }),
            }),
          lookup: () => api<Operation>(`/operations/${requestId}`),
          observed: () => operationSnapshots.current.get(requestId),
          view: () => receivedViewState.value,
          subscribe: (check) =>
            watch([receivedViewState, operationsState, () => drafts.readCurrent()?.draft], check, {
              flush: 'sync',
            }),
          awaitingSync: () => {
            waitingForOpenedThread.value = true;
          },
        });
        if (!current()) return;
        if (!draftUnchanged()) {
          sendPreparationError.value = '草稿已更改，消息未发送。请确认后再发送。';
        } else if (result.state === 'blocked') {
          sendPreparationError.value = result.message;
        } else if (result.state === 'ready') {
          const outgoing = drafts.readCurrent()?.outgoing?.operation;
          readyToSend =
            statusState.value?.writesEnabled === true &&
            canSendOpenedThread(receivedViewState.value, threadId) &&
            !busyState.value &&
            !uploadingState.value &&
            !dispatchingDraft.current &&
            !blocksSend(outgoing) &&
            outgoing?.state !== 'failed' &&
            outgoing?.state !== 'rejected' &&
            !operationsState.value.some((op) => op.threadId === threadId && blocksSend(op));
          if (!readyToSend) sendPreparationError.value = openedThreadBlocked;
        }
      } finally {
        if (openingForSendState.value === attempt) cancelOpeningForSend();
      }
      // Use the normal send journal only after the desktop is ready.
      if (readyToSend) await act('send');
    }
    const currentIds = codex ? undefined : new Set(view?.messages.map((message) => message.id));
    const firstLiveStep = antigravity ? antigravityStep(view?.messages[0]) : undefined;
    const messages = !view
      ? []
      : codex
        ? mergeCodexHistory(codexMessages(older), codexMessages(view.messages, view.activeTurnId))
        : [
            ...older.filter((message) =>
              firstLiveStep === undefined
                ? !currentIds?.has(message.id)
                : (antigravityStep(message) ?? firstLiveStep) < firstLiveStep,
            ),
            ...view.messages,
          ];
    const activeMessage = messages.findLast((message) => message.turnId === view?.activeTurnId);
    const activity = view?.codexActivity ??
      (activeMessage?.role === 'assistant' && activeMessage.phase === 'final_answer' ? 'responding' : 'thinking');
    const showCodexActivity = codex && !!stream && !!view?.synchronized && !!view.activeTurnId &&
      !view.pendingRequests && !view.requests?.length && activity !== 'responding' &&
      !(activity === 'compacting' && activeMessage?.codex?.kind === 'compaction' &&
        activeMessage.codex.state === 'running');
    watchCodexActivity(() => {
      if (showCodexActivity && followBottom.current && transcriptRef.value)
        scrollToLatest(transcriptRef.value);
    }, [showCodexActivity]);
    const outgoing = drafts.outgoing;
    const outgoingOperation = outgoing?.operation;
    watchDeviceId(() => {
      if (
        !outgoingOperation ||
        outgoingOperation.state !== 'uncertain' ||
        !stream ||
        operationSnapshots.current.has(outgoingOperation.id) ||
        recoveredDraft.current === outgoingOperation.id ||
        readPending(deviceId, outgoingOperation.threadId).some((x) => x.id === outgoingOperation.id)
      )
        return;
      // A receipt can remove the journal entry just before the browser saves the updated draft.
      recoveredDraft.current = outgoingOperation.id;
      void api<Operation>(`/operations/${outgoingOperation.id}`)
        .then(receiveOperation)
        .catch(() => {});
    }, [deviceId, outgoingOperation, stream]);
    const hasOutgoingFailure =
      outgoingOperation?.state === 'rejected' || outgoingOperation?.state === 'failed';
    const echoed =
      outgoingOperation &&
      (messages.some(
        (message) =>
          message.role === 'user' &&
          (message.clientMessageId === outgoingOperation.id ||
            (outgoingOperation.kind === 'send' &&
              !!outgoingOperation.turnId &&
              message.turnId === outgoingOperation.turnId)),
      ) ||
        (outgoingOperation.state === 'accepted' &&
          !!outgoing?.draft.text.trim() &&
          !!view?.queuedMessages?.some((item) => item.text.trim() === outgoing.draft.text.trim())));
    watchOutgoingOperation(() => {
      if (outgoingOperation?.state === 'accepted' && echoed) drafts.clearOutgoing(outgoingOperation);
    }, [outgoingOperation, echoed]);
    watchOutgoingOperation2(() => {
      if (outgoingOperation && followBottom.current && transcriptRef.value)
        scrollToLatest(transcriptRef.value);
    }, [outgoingOperation]);
    const canEdit =
      canCompose ||
      canOpenForSend ||
      (textOnlySend && stream) ||
      (!!view &&
        ((!view.synchronized && !view.reason && status?.writesEnabled !== false) ||
          (!!outgoingOperation && view.owner && !!status?.writesEnabled)));
    const composerStatus =
      openingActivity ||
      sendPreparationError.value ||
      (!canCompose && !canOpenForSend && view?.reason) ||
      (unsupportedSendDraft && (fileReferences ? fileReferenceExtrasHint : textOnlySendHint));
    const latestMessageAt = messages.reduce((max, m) => Math.max(max, m.createdAt ?? 0), 0);
    const staleFailedDelivery =
      !!delivery &&
      (delivery.state === 'rejected' || delivery.state === 'failed') &&
      (dismissedDeliveryIds.value.has(delivery.id) ||
        latestMessageAt > delivery.updatedAt + 5_000);
    const composerDelivery =
      delivery?.id === outgoingOperation?.id || staleFailedDelivery ? undefined : delivery;
    const draftHasContent = !!(
      draft.trim() ||
      uploads.length ||
      selectedSkills.length ||
      selectedPlugins.length
    );
    watchBusy(() => {
      onBusy(busy || uploading || pending);
    }, [busy, uploading, pending, onBusy]);
    const updateBlocked = uploading || voiceOpen;
    watchUpdateBlocked(() => onUpdateBlocked(updateBlocked), [updateBlocked, onUpdateBlocked]);
    if (loading)
      return (
        <main class="pair-wrap">
          <p>正在连接…</p>
        </main>
      );
    if (route.page === 'workbench' && route.host && route.host !== deviceSession.host?.hostId)
      return (
        <main class="module-page">
          <section class="module-empty">
            <h2>正在打开对应的电脑</h2>
            <button class="secondary" onClick={() => navigate({ page: 'workbench' }, true)}>
              返回工作台
            </button>
          </section>
        </main>
      );
    if (!paired && route.page !== 'pair')
      return (
        <main class="module-page">
          <header class="page-header">
            <h1>工作台</h1>
          </header>
          <section class="module-empty">
            <span class="empty-symbol">
              <Icon name="monitor" size={38} />
            </span>
            <h2>继续电脑上的工作</h2>
            <p>连接你的电脑，查看项目、发送任务和处理审批。</p>
            <button class="primary" onClick={() => navigate({ page: 'add-computer' })}>
              连接电脑
            </button>
          </section>
        </main>
      );
    if (!paired || route.page === 'pair') {
      return (
        <PairingView
          name={name}
          hostId={hostId}
          code={code}
          fromPairLink={fromPairLink}
          manualPairOpen={manualPairOpen.value}
          busy={busy}
          error={error}
          onName={setName}
          onHostId={(value) => {
            setHostId(value);
            setFromPairLink(false);
          }}
          onCode={(value) => {
            setCode(value);
            setFromPairLink(false);
          }}
          onManualPairOpen={(open) => {
            manualPairOpen.value = open;
          }}
          onScan={(host, scannedCode) => {
            setHostId(host);
            setCode(scannedCode);
            setFromPairLink(true);
            manualPairOpen.value = false;
            setError('');
          }}
          onSubmit={pair}
          onDownload={() => navigate({ page: 'downloads' })}
        />
      );
    }
    const conversationBack = backDestination(
      route,
      usesMobileHistory() ? previousHistoryRoute() : undefined,
    );
    const sidebarCollapsed = !!selected && sidebar.collapsed.value;
    return (
      <div class={['app', { 'has-thread': selected, 'workbench-sidebar-collapsed': sidebarCollapsed }]}>
        <ThreadNavigation
          panelId={sidebar.id}
          backend={backend}
          agentName={agentName}
          onWorkbench={() => backTo({ page: 'workbench' }, navigate)}
          canCreate={canCreateConversation}
          canCreateProject={
            presentation?.creation?.createProject === true && status?.writesEnabled === true
          }
          onCreateProject={() => setFolderPickerOpen(true)}
          canRename={status?.capabilities.renameThread === true}
          canFork={status?.capabilities.forkThread === true}
          canExportLog={backend?.presentation?.exportLog === true}
          projects={projects}
          threads={threads}
          cursor={cursor}
          selected={selected}
          online={stream}
          active={active}
          loading={listLoading}
          pendingQuestions={view?.pendingRequests ?? 0}
          onSelect={setSelected}
          onRefresh={() => void loadThreads()}
          onMore={() => void loadThreads(cursor ?? undefined)}
          onReloadThread={(target) => {
            if (selected?.id !== target.id) setSelected(target);
            else setSubscriptionAttempt((value) => value + 1);
          }}
          onRenameThread={(target) => {
            if (selected?.id !== target.id) setSelected(target);
            setError('');
            setThreadAction({ kind: 'rename', threadId: target.id, title: target.title });
          }}
          onForkThread={(target) => {
            if (selected?.id !== target.id) setSelected(target);
            setError('');
            setThreadAction({ kind: 'fork', threadId: target.id, title: target.title });
          }}
          onExportThread={(target) => {
            setError('');
            void exportSessionLog(target.id)
              .then((file) => downloadFile(file))
              .catch((cause) => setError((cause as Error).message || '无法导出会话日志'));
          }}
          onCreate={(projectId) => {
            setNewProject(projectId ?? selected?.projectId ?? undefined);
            if (!selected && threads[0]) setSelected(threads[0]);
            else if (!selected && emptyCreation) {
              updateSelected({ id: 'new', title: `新建 ${agentName} 会话`, cwd: '', updatedAt: Date.now() });
              navigate({ page: 'workbench', backend: backendId, thread: 'new' });
            }
            setNewOpen(true);
          }}
        />
        <main class="chat">
          <ConversationHeader
            className="chat-head"
            level={2}
            title={selected?.title || '选择一个会话'}
            backLabel={conversationBack.thread ? '返回上一会话' : '返回会话列表'}
            onBack={() => backTo(conversationBack, navigate)}
            leadingAction={
              selected && (
                <WorkbenchSidebarToggle
                  sidebarId={sidebar.id}
                  collapsed={sidebarCollapsed}
                  onToggle={sidebar.toggle}
                />
              )
            }
            subtitle={
              <>
                <Icon name="monitor" size={14} />
                <span>{deviceSession.host?.name}</span>
                {selected && (
                  <>
                    <Icon name="folder" size={14} />
                    <span>{selected.projectName ?? '未分类'}</span>
                  </>
                )}
              </>
            }
            status={
              selected ? (
                <NetworkConnection
                  synchronized={selected.id === 'new' ? undefined : !!view?.synchronized}
                />
              ) : undefined
            }
          >
            {() => (
              <>
                <UsagePanel
                  key={JSON.stringify([deviceSession.host?.hostId, deviceId, backendId])}
                  backendId={backendId}
                  name={agentName}
                  active={active}
                  online={stream}
                  refreshOnOpen={antigravity}
                  currentModel={messageModel?.id ?? view?.model ?? undefined}
                  currentModelName={messageModel?.name ?? view?.modelName ?? undefined}
                />
                {active && voiceHost && selected && selected.id !== 'new' && voiceMode && (
                  <button
                    class="icon-button"
                    aria-label="Codex Voice"
                    aria-haspopup="dialog"
                    title="Codex Voice"
                    disabled={!stream}
                    onClick={() => {
                      voiceState.value = {
                        hostId: voiceHost,
                        threadId: selected.id,
                        backendId,
                        mode: voiceMode,
                      };
                    }}
                  >
                    <Icon name="mic" size={21} />
                  </button>
                )}
                {selected && (
                  <button
                    class="icon-button more-tools"
                    aria-label="会话工具"
                    onClick={() => setToolsOpen(true)}
                  >
                    <Icon name="more" />
                  </button>
                )}
              </>
            )}
          </ConversationHeader>
          {codex && controlCatalog.catalog?.goal && (
            <ConversationGoalSummary
              goal={controlCatalog.catalog.goal}
              onOpen={(anchor) => requestControl('goal', anchor)}
            />
          )}
          {voiceOpen && voice && (
            <CodexVoice
              hostId={voice.hostId}
              backendId={voice.backendId}
              threadId={voice.threadId}
              mode={voice.mode}
              onClose={() => {
                voiceState.value = undefined;
              }}
              onOpenThread={(id) => {
                voiceState.value = undefined;
                void loadThreads();
                navigate({ page: 'workbench', host: voice.hostId, backend: backendId, thread: id });
              }}
            />
          )}
          {!selected ? (
            <div class="empty workspace-empty">
              <div class="workspace-empty-prompt">
                <BrandIcon class="brand-icon" size={42} />
                <h2>Agent 继续工作，手机随时接入</h2>
                <p>从左侧选择会话，查看历史并继续工作。</p>
              </div>
            </div>
          ) : (
            <>
              <div class="transcript-stage">
                <section
                  ref={transcriptRef}
                  class="transcript"
                  aria-label="聊天记录"
                  onWheel={(event) => {
                    if (!event.ctrlKey && !event.shiftKey)
                      followTranscriptGesture(event, event.deltaY);
                  }}
                  onTouchstart={(event) => {
                    transcriptScroll.touchY =
                      event.touches.length === 1 ? event.touches[0].clientY : undefined;
                  }}
                  onTouchmove={(event) => {
                    const next = event.touches.length === 1 ? event.touches[0].clientY : undefined;
                    const previous = transcriptScroll.touchY;
                    transcriptScroll.touchY = next;
                    if (next !== undefined && previous !== undefined)
                      followTranscriptGesture(event, previous - next);
                  }}
                  onScroll={(e) => {
                    const el = e.currentTarget as HTMLElement;
                    const top = el.scrollTop;
                    // A keyboard or composer resize can move the scroll position
                    // without the reader navigating away from the latest message.
                    if (el.clientHeight !== transcriptScroll.height || top === transcriptScroll.top)
                      return;
                    const movingUp = top < transcriptScroll.top;
                    const maxTop = el.scrollHeight - el.clientHeight;
                    const atBottom = maxTop - top <= TRANSCRIPT_BOTTOM_TOLERANCE;
                    // Shrinking content can clamp the viewport without any reader navigation.
                    const clamped = maxTop < transcriptScroll.maxTop && atBottom;
                    rememberTranscriptPosition(el);
                    if (clamped) return;
                    if (movingUp) followBottom.current = false;
                    else if (atBottom) followBottom.current = true;
                    if (
                      movingUp &&
                      top <= HISTORY_TOP_THRESHOLD &&
                      !historyError.value &&
                      !view?.historyUnavailable
                    )
                      void loadOlder();
                  }}
                >
                  <div class="transcript-content" ref={transcriptContentRef}>
                  {view && historyCursor && (
                    <div class="older">
                      {historyError.value && <span role="status">{historyError.value}</span>}
                      <button class="older-button" disabled={historyLoading} onClick={() => void loadOlder()}>
                        {historyLoading
                          ? '正在加载历史记录…'
                          : view.historyUnavailable || historyError.value
                            ? '重试读取历史'
                            : '更早记录'}
                      </button>
                    </div>
                  )}
                  {!view &&
                    (threadError ? (
                      <div class="center">
                        <p role="status">会话暂时无法读取</p>
                        <button
                          class="secondary"
                          onClick={() => setSubscriptionAttempt((value) => value + 1)}
                        >
                          重新加载会话
                        </button>
                      </div>
                    ) : (
                      <p class="muted center">{stream ? '正在读取会话…' : '连接电脑后可读取会话'}</p>
                    ))}
                  <TranscriptMessages
                    agent={{ name: agentName }}
                    messages={messages}
                    threadId={selected.id}
                    activeTurnId={view?.activeTurnId}
                    requests={view?.requests}
                    codex={codex}
                    onFork={
                      status?.capabilities.forkFromTurn
                        ? (lastTurnId) =>
                            setThreadAction({
                              kind: 'fork',
                              threadId: selected.id,
                              title: selected.title,
                              lastTurnId,
                            })
                        : undefined
                    }
                    forkDisabled={!stream || busy || pending}
                  />
                  {outgoing && !echoed && (
                    <OutgoingMessageCard
                      threadId={selected.id}
                      codex={codex}
                      operation={outgoing.operation}
                      draft={outgoing.draft}
                      hasFailure={hasOutgoingFailure}
                      draftHasContent={draftHasContent}
                      onCheck={async () =>
                        receiveOperation(await api<Operation>(`/operations/${outgoing.operation.id}`))
                      }
                      onRetry={
                        outgoing.operation.state === 'rejected' &&
                        canCompose &&
                        !busy &&
                        !pending &&
                        !(
                          textOnlySend &&
                          (requiresFullSend(outgoing.draft, fileReferences) ||
                            (outgoing.operation.kind === 'steer' && outgoing.operation.turnId !== view?.activeTurnId))
                        ) &&
                        (outgoing.operation.kind !== 'queue' || !!view?.queueFingerprint) &&
                        (!view?.activeTurnId ||
                          (!outgoing.draft.skills.length && !outgoing.draft.plugins.length))
                          ? () =>
                              void act(
                                outgoing.operation.kind === 'queue'
                                  ? 'queue'
                                  : view?.activeTurnId
                                    ? 'steer'
                                    : 'send',
                                undefined,
                                outgoing.draft,
                              )
                          : undefined
                      }
                      onMoveToDraft={() => drafts.clearOutgoing(outgoing.operation, true)}
                      onDismiss={() => drafts.clearOutgoing(outgoing.operation)}
                    />
                  )}
                  {showCodexActivity && (
                    <div class="transcript-notice codex-live-activity" role="status">
                      <span class="codex-activity-dot" aria-hidden="true" />
                      <span>{{ thinking: '正在思考…', tool: '正在执行工具…', compacting: '正在压缩上下文…', responding: '' }[activity]}</span>
                    </div>
                  )}
                  {view && messages.length === 0 && !outgoing && !showCodexActivity && (
                    <p class="muted center">
                      {view.historyUnavailable
                        ? '暂时无法读取此会话的历史记录'
                        : '此会话暂时没有可显示的消息'}
                    </p>
                  )}
                  {!!view?.requests?.length && (
                    <RequestCards
                      threadId={selected.id}
                      requests={view.requests}
                      onDraftChange={questionDraftChanged}
                      response={operations.find((operation) => operation.kind === 'respond')}
                      disabled={!canRespondToRequests(view)}
                      onRespond={(response) => act('respond', response)}
                    />
                  )}
                  </div>
                </section>
                <TurnNavigation
                  key={selected.id}
                  messages={messages}
                  transcript={transcriptRef}
                  onNavigate={() => {
                    followBottom.current = false;
                  }}
                />
              </div>
              <section class="composer">
                {!!view?.queuedMessages?.length && (
                  <div class="composer-queue-bar" role="region" aria-label="排队消息">
                    <div class="composer-queue-head">
                      <strong>排队消息 · {view.queuedMessages.length}</strong>
                      <span>
                        {view.activeTurnId
                          ? '当前任务结束后自动发送'
                          : '队列已暂停待发，可立即发送或移除'}
                      </span>
                    </div>
                    <ul class="composer-queue-list">
                      {view.queuedMessages.map((item) => {
                        const canFlush =
                          !view.activeTurnId &&
                          view.canSend &&
                          !!view.queueFingerprint &&
                          !item.hasAttachments &&
                          !!item.text.trim() &&
                          !busy &&
                          !pending &&
                          stream;
                        return (
                          <li key={item.id} class="composer-queue-item">
                            <span class="composer-queue-text" title={item.text}>
                              {item.text}
                            </span>
                            <div class="composer-queue-actions">
                              {canFlush && (
                                <button
                                  type="button"
                                  class="composer-queue-send"
                                  onClick={() => {
                                    void act('queue-remove', { messageId: item.id }).then((opId) => {
                                      if (opId && operationSnapshots.current.get(opId)?.state === 'completed') {
                                        void act('send', undefined, {
                                          text: item.text,
                                          uploads: [],
                                          skills: [],
                                          plugins: [],
                                        });
                                      }
                                    });
                                  }}
                                >
                                  立即发送
                                </button>
                              )}
                              {view.queueFingerprint && (
                                <button
                                  type="button"
                                  class="composer-queue-remove"
                                  disabled={busy || pending || !stream}
                                  aria-label="移除排队消息"
                                  title="移除排队消息"
                                  onClick={() => void act('queue-remove', { messageId: item.id })}
                                >
                                  <Icon name="close" size={14} />
                                </button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                {error && (
                  <p class="error" role="alert">
                    {error}
                  </p>
                )}
                {(!!selectedSkills.length || !!selectedPlugins.length) && !!view?.activeTurnId && (
                  <p class="hint">已选插件和技能将在下一轮使用，请等当前任务结束后发送。</p>
                )}
                <ChatComposer
                  activity={
                    openingActivity ?? operationActivity(outgoingOperation) ?? operationActivity(composerDelivery)
                  }
                  feedback={
                    <>
                      {composerStatus && (
                        <p class="hint" role="status">{composerStatus}</p>
                      )}
                      <OperationFeedback
                        operation={composerDelivery}
                        onCheck={
                          delivery
                            ? async () => receiveOperation(await api<Operation>(`/operations/${delivery.id}`))
                            : undefined
                        }
                        onRetry={
                          delivery?.state === 'rejected' &&
                          ['send', 'steer'].includes(delivery.kind) &&
                          (draft.trim() || uploads.length) &&
                          canCompose &&
                          (!view?.activeTurnId || canSteer) &&
                          !unsupportedSendDraft &&
                          !busy &&
                          !pending
                            ? () => void sendDraft()
                            : undefined
                        }
                        onDismiss={
                          composerDelivery
                            ? () => {
                                const next = new Set(dismissedDeliveryIds.value);
                                next.add(composerDelivery.id);
                                dismissedDeliveryIds.value = next;
                              }
                            : undefined
                        }
                      />
                    </>
                  }
                  threadId={selected.id}
                  value={drafts.draft}
                  onChange={(change) => {
                    sendPreparationError.value = '';
                    drafts.update(selected.id, change);
                  }}
                  disabled={!canEdit || openingForSend}
                  placeholder={
                    canEdit || !stream || (!view?.synchronized && !view?.reason)
                      ? running
                        ? (canSteer ? '给当前任务追加指令…' : '任务运行中，可以先写草稿…')
                        : `给 ${agentName} 发消息…`
                      : view?.requests?.length
                        ? '请先处理上方的审批或交互请求…'
                        : view?.pendingRequests
                          ? '请先在电脑端处理审批或交互确认…'
                          : '此会话当前只读'
                  }
                  uploading={uploading}
                  uploadItems={uploadThread === selected.id ? uploadJobs : []}
                  onDismissUploads={() => setUploadJobs([])}
                  uploadDisabled={busy || uploading || pending || !(canCompose || canOpenForSend)}
                  onUpload={canAttachToThread ? uploadFiles : undefined}
                  imageUploadTypes={imagesOnly ? antigravityImages : undefined}
                  running={running}
                  canSteer={canSteer}
                  canInterrupt={view?.canInterrupt}
                  sendDisabled={
                    running &&
                    (!canSteer ||
                      (!draft.trim() && !uploads.length && !selectedSkills.length && !selectedPlugins.length))
                      ? busy || !stream || !view?.canInterrupt
                      : busy ||
                        hasOutgoingFailure ||
                        uploading ||
                        pending ||
                        !stream ||
                        !(canCompose || canOpenForSend) ||
                        unsupportedSendDraft ||
                        (!!uploads.length && !canAttachToThread) ||
                        (!!selectedSkills.length && !canSelectSkills) ||
                        (!!selectedPlugins.length && !canSelectPlugins) ||
                        (!draft.trim() && !uploads.length) ||
                        (!!view?.activeTurnId && (!!selectedSkills.length || !!selectedPlugins.length))
                  }
                  canQueue={
                    !textOnlySend &&
                    (canSteer || status?.capabilities.queue === true) &&
                    canCompose &&
                    !!view?.canInterrupt &&
                    !!view?.queueFingerprint &&
                    !busy &&
                    !pending &&
                    stream &&
                    !!draft.trim() &&
                    !messageModel &&
                    !uploads.length &&
                    !selectedSkills.length &&
                    !selectedPlugins.length
                  }
                  showQueueButton={antigravity}
                  onSubmit={() => {
                    if (view?.activeTurnId && (selectedSkills.length || selectedPlugins.length)) return;
                    const catalog = controlCatalog.catalog;
                    if (
                      codex &&
                      draft.trim() === '/goal' &&
                      !uploads.length &&
                      !selectedSkills.length &&
                      !selectedPlugins.length &&
                      (catalog?.actions.includes('goal') || catalog?.goal || catalog?.goalUnavailableReason)
                    ) {
                      requestControl('goal');
                      return;
                    }
                    if (
                      presentation?.nativeCommands &&
                      /^\/(permission|goal|plan|compact|feedback|export|model|file)(?:\s|$)/.test(
                        draft.trim(),
                      ) &&
                      !selectedSkills.length
                    ) {
                      const command = draft.trim().split(/\s/)[0].slice(1);
                      if (command === 'model') setConfigOpen(true);
                      else
                        requestControl(
                          ['permission', 'goal', 'feedback', 'file'].includes(command)
                            ? (command as ControlSection)
                            : 'tools',
                        );
                      return;
                    }
                    void sendDraft();
                  }}
                  onInterrupt={() => void act('interrupt')}
                  onQueue={() => void act('queue')}
                  actions={
                    <>
                      {view && (
                        <>
                          <ConversationControls
                            key={JSON.stringify([deviceId, backendId, view.id])}
                            id={view.id}
                            state={view.controls}
                            backend={backend}
                            plan={controlPlan ? !!view.controls?.plan : view.mode === 'plan'}
                            running={!!view.activeTurnId}
                            disabled={busy || pending || !stream}
                            connected={stream}
                            canWriteGoal={status?.writesEnabled !== false}
                            goalOperationError={goalOperationError}
                            limitedSend={textOnlySend}
                            {...controlCatalog}
                            modeDisabled={
                              textOnlySend ||
                              (presentation?.plan === 'settings' &&
                                (!canChangeModel ||
                                  status?.capabilities.queue !== true ||
                                  (!view.canSend && !view.canInterrupt) ||
                                  !view.model ||
                                  !view.reasoningEffort))
                            }
                            request={controlRequest?.threadId === view.id ? controlRequest : undefined}
                            onAction={(control) => void act('control', { control })}
                            onMode={(mode) =>
                              void (controlPlan
                                ? act('control', { control: { action: 'plan', enabled: mode === 'plan' } })
                                : act('settings', settingsUpdate(view, mode)))
                            }
                            onSkills={() => setSkillsOpen(true)}
                            onPlugins={() => setPluginsOpen(true)}
                            onFile={(path) =>
                              drafts.update(view.id, (old) => ({
                                ...old,
                                text: old.text + ' @' + path + ' ',
                              }))
                            }
                          />
                          {view.mode === 'plan' && (
                            <button
                              type="button"
                              class="plan-chip"
                              aria-label="取消计划模式"
                              disabled={
                                busy ||
                                pending ||
                                !stream ||
                                textOnlySend ||
                                (!controlPlan && (!canChangeModel || status?.capabilities.queue !== true)) ||
                                (!view.canSend && !view.canInterrupt)
                              }
                              onClick={() =>
                                void (controlPlan
                                  ? act('control', { control: { action: 'plan', enabled: false } })
                                  : act('settings', settingsUpdate(view, 'default')))
                              }
                            >
                              计划
                              <Icon name="close" size={14} />
                            </button>
                          )}
                          {canChangeModel || messageModelPicker ? (() => {
                            const rawLabel = modelLabel(
                              (messageModelPicker && messageModel?.name) || currentModel || null,
                            );
                            const displayLabel =
                              messageModelPicker && !messageModel && rawLabel === 'Antigravity 模型'
                                ? '默认模型'
                                : rawLabel;
                            const tooltip = messageModel
                              ? `下一条消息将使用：${messageModel.name}（点击切换）`
                              : messageModelPicker
                                ? `当前模型：${displayLabel}（点击为下一条消息切换模型）`
                                : `当前模型：${displayLabel}（点击修改）`;
                            return (
                              <span class={`composer-model-group${messageModel ? ' is-selected' : ''}`}>
                                <button
                                  type="button"
                                  class="composer-model"
                                  title={textOnlySend ? '请在电脑上的 Codex 修改模型设置' : tooltip}
                                  disabled={textOnlySend}
                                  aria-label={messageModelPicker ? '选择下一条消息的模型' : '模型设置'}
                                  onClick={() => setConfigOpen(true)}
                                >
                                  <Icon name="sliders" size={14} />
                                  <span>{displayLabel}</span>
                                  <Icon name="down" size={14} />
                                </button>
                                {messageModel && (
                                  <button
                                    type="button"
                                    class="composer-model-clear"
                                    aria-label={'移除下一条消息的模型 ' + messageModel.name}
                                    title="恢复默认模型"
                                    onClick={() => {
                                      drafts.update(view.id, { model: undefined });
                                      setError('');
                                    }}
                                  >
                                    <Icon name="close" size={13} />
                                  </button>
                                )}
                              </span>
                            );
                          })() : (messageModel || currentModel) && (
                            <span
                              class="composer-model is-readonly"
                              title={messageModel ? '下一条消息的模型' : '当前模型'}
                            >
                              <Icon name="sliders" size={14} />
                              <span>{messageModel?.name ?? view.modelName ?? modelLabel(currentModel ?? null)}</span>
                            </span>
                          )}
                        </>
                      )}
                    </>
                  }
                />
              </section>
              {configOpen && view && (canChangeModel || messageModelPicker) && (
                <ThreadTools
                  open
                  className="settings-sheet"
                  onClose={() => setConfigOpen(false)}
                  title={messageModelPicker ? '下一条消息' : '应用于下一轮任务'}
                  heading={messageModelPicker ? '选择模型' : '模型设置'}
                >
                  {() => (
                    <>
                      <ModelSettings
                        key={backendId + ':' + view.id}
                        view={view}
                        disabled={busy || pending || !stream || textOnlySend || (!view.canSend && !view.canInterrupt)}
                        supportsServiceTier={status?.capabilities.queue === true}
                        onSave={(settings) => act('settings', settings)}
                        onDirtyChange={setSettingsDirty}
                        response={operations.find((o) => o.kind === 'settings')}
                        onApplied={() => setConfigOpen(false)}
                        messageModelId={messageModelPicker ? messageModel?.id : undefined}
                        onSelectForMessage={
                          messageModelPicker
                            ? (choice) => {
                                drafts.update(view.id, { model: { id: choice.id, name: choice.name } });
                                setConfigOpen(false);
                              }
                            : undefined
                        }
                      />
                    </>
                  )}
                </ThreadTools>
              )}
              {((skillsOpen && canSelectSkills) || (pluginsOpen && canSelectPlugins)) && view && (
                <ComposerToolPicker
                  kind={pluginsOpen && canSelectPlugins ? 'plugins' : 'skills'}
                  threadId={view.id}
                  skills={selectedSkills}
                  plugins={selectedPlugins}
                  disabled={busy || pending}
                  onSkills={setSelectedSkills}
                  onPlugins={setSelectedPlugins}
                  onDirtyChange={setPickerDirty}
                  onClose={() => {
                    setSkillsOpen(false);
                    setPluginsOpen(false);
                  }}
                />
              )}
              <ThreadTools
                open={newOpen}
                className="new-conversation-sheet"
                onClose={() => {
                  creationRequest.current = undefined;
                  setNewOpen(false);
                }}
                title="选择项目，发送第一条消息即可开始"
                heading="新会话"
              >
                {() => (
                  <>
                    <NewConversation
                      key={`new:${deviceId}:${backendId}:${selected.id}`}
                      anchor={selected.id}
                      creation={presentation?.creation}
                      requireProject={antigravity}
                      canAttachAfterCreation={canAttach}
                      imageUploadTypes={imagesOnly ? antigravityImages : undefined}
                      allowPlugins={backend?.product !== 'dsh'}
                      active={newOpen}
                      defaultProject={newProject}
                      knownProjects={projects.projects}
                      onDirtyChange={setNewDirty}
                      onProjectCreated={() => void loadThreads()}
                      disabled={
                        busy ||
                        pending ||
                        (!stream && !emptyCreation) ||
                        !status?.writesEnabled ||
                        !status.capabilities.newThread
                      }
                      feedback={
                        error || (!status?.writesEnabled ? '电脑连接暂不可用，消息草稿会保留。' : undefined)
                      }
                      operation={delivery?.kind === 'create' ? delivery : undefined}
                      onCheck={
                        delivery
                          ? async () => receiveOperation(await api<Operation>(`/operations/${delivery.id}`))
                          : undefined
                      }
                      onCreate={(input) => void act('create', input)}
                    />
                    {operations.find(
                      (o) => o.kind === 'create' && o.state === 'uncertain' && o.resultThreadId,
                    ) && (
                      <button
                        class="secondary"
                        onClick={async () => {
                          const op = operations.find(
                            (o) => o.kind === 'create' && o.state === 'uncertain' && o.resultThreadId,
                          )!;
                          try {
                            const result = await api<{ thread: ThreadSummary }>(
                              `/threads/${encodeURIComponent(op.resultThreadId!)}`,
                            );
                            setSelected(result.thread, selectedId.current === 'new');
                            setNewOpen(false);
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        查看已创建会话；结果待确认，请勿重复发送
                      </button>
                    )}
                  </>
                )}
              </ThreadTools>
              {active && threadAction?.threadId === selected.id && (
                <ThreadActionSheet
                  threadTitle={selected.title}
                  action={threadAction}
                  operation={threadActionOperation}
                  busy={busy}
                  pending={pending}
                  stream={stream}
                  error={error}
                  onTitleChange={(title) => setThreadAction((old) => old && { ...old, title })}
                  onSubmit={() => {
                    if (busy || pending || threadActionOperation?.state === 'completed') return;
                    if (threadAction.kind === 'rename') {
                      const title = threadAction.title.trim();
                      if (!title || title === selected.title) return;
                      void act('rename', { title });
                    } else {
                      const { lastTurnId } = threadAction;
                      void act('fork', lastTurnId ? { lastTurnId } : undefined);
                    }
                  }}
                  onCheck={
                    threadActionOperation
                      ? async () =>
                          receiveOperation(await api<Operation>(`/operations/${threadActionOperation.id}`))
                      : undefined
                  }
                  onClose={() => {
                    if (threadAction.kind === 'fork') creationRequest.current = undefined;
                    setThreadAction(undefined);
                  }}
                />
              )}
              <SessionToolsSheet
                key={`tools:${selected.id}`}
                open={toolsOpen}
                title={selected.title}
                stream={stream}
                canOpenForSend={canOpenForSend}
                busy={busy}
                pending={pending}
                view={view}
                actions={[
                  ...(['rename', 'fork'] as const).flatMap((kind): SessionToolAction[] =>
                    selected.id !== 'new' &&
                    status?.capabilities[kind === 'rename' ? 'renameThread' : 'forkThread']
                      ? [
                          {
                            id: kind,
                            label: kind === 'rename' ? '会话改名' : '创建会话分支',
                            description:
                              kind === 'rename' ? '修改会话显示名称' : '从当前进度创建独立分支',
                            icon: kind === 'rename' ? 'document' : 'branch',
                            disabled: busy || pending || !stream,
                            onSelect: () => {
                              setToolsOpen(false);
                              setError('');
                              setThreadAction({ kind, threadId: selected.id, title: selected.title });
                            },
                          },
                        ]
                      : [],
                  ),
                  ...(view && canChangeModel
                    ? [
                        {
                          id: 'model',
                          label: '模型设置',
                          description: '模型与推理强度',
                          icon: 'sliders' as const,
                          onSelect: () => {
                            setToolsOpen(false);
                            setConfigOpen(true);
                          },
                        },
                      ]
                    : []),
                  ...(canCreateConversation
                    ? [
                        {
                          id: 'create',
                          label: '新建会话',
                          description: '在当前项目开始新会话',
                          icon: 'plusCircle' as const,
                          onSelect: () => {
                            setToolsOpen(false);
                            setNewProject(selected.projectId ?? undefined);
                            setNewOpen(true);
                          },
                        },
                      ]
                    : []),
                ]}
                operations={currentOperations}
                onClose={() => setToolsOpen(false)}
                onCheckOperation={async (id) => receiveOperation(await api<Operation>(`/operations/${id}`))}
                onRemoveQueue={(messageId) => void act('queue-remove', { messageId })}
                onOpenThread={(thread) => navigate({ page: 'workbench', backend: backendId, thread })}
              />
            </>
          )}
        </main>
        {folderPickerOpenState.value && presentation?.creation?.createProject === true && (
          <FolderPickerDialog
            open={folderPickerOpenState.value}
            onClose={() => setFolderPickerOpen(false)}
            onCreated={(project) => {
              void loadThreads();
              if (canCreateConversation) {
                setNewProject(project.id);
                if (!selected && threads[0]) setSelected(threads[0]);
                else if (!selected && emptyCreation) {
                  updateSelected({ id: 'new', title: `新建 ${agentName} 会话`, cwd: '', updatedAt: Date.now() });
                  navigate({ page: 'workbench', backend: backendId, thread: 'new' });
                }
                setNewOpen(true);
              }
            }}
          />
        )}
      </div>
    );
  };
});
