import { tsxComponent } from '../tsx-component';
import { diagnosticStatus, recordDiagnostic } from '../diagnostics';
import { shallowRef, defineAsyncComponent as lazy, Suspense } from 'vue';
import { writeRef, useExternalSnapshot, memoizeRender, watchRender } from '../render-effects';
import { uploadItems, type UploadItem } from '../UploadProgress';
import { ConversationHeader } from '../shell/ConversationHeader';
import { backTo } from '../shell/routes';
import type {
  ChatAttachment,
  ChatConversation,
  ChatMessage,
  SendMessageOptions,
} from '../../shared/messaging';
import { ChatComposer, composerAttachmentChoices, type ComposerAttachmentSource } from '../ChatComposer';
import { AttachmentAccessProvider, type AttachmentAccess } from '../AttachmentAccess';
import { Icon } from '../Icon';
import { OutgoingContent, OutgoingStatus } from '../OutgoingMessage';
import { browserId } from '../browser-id';
import { MessagingError } from '../../client/messaging';
import { messaging, useMessaging } from './context';
import { readDraft, subscribeDrafts, updateDraft, type MessagingDraft, type PendingMessage } from './drafts';
import { Avatar, Dialog, Notice, errorText, time, type Navigate } from './ui';
import { loadMessagingMedia, peekMessagingMedia } from './media-cache';
import { cachedHistory, forgetHistory, peekHistory, saveHistory } from './history-cache';
import {
  exportFilename,
  formatChatExportJson,
  formatChatExportMarkdown,
  triggerTextDownload,
  type ChatExportFormat,
} from './chat-export';
import { GroupDetails } from './Groups';
import { AgentCallActions } from './AgentCall';
import { ComposerPopover } from '../ComposerPopover';
import { SecurityCodes } from './SecurityCodes';
import { InteractionCard, CreateInteraction } from './InteractionCard';
import { VoiceRecorder } from './VoiceRecorder';
import {
  activityNames,
  activityStates,
  attachmentLimit,
  mergeMessages as merge,
  mobileComposer,
  quoteLabel,
  subscribeComposerLayout,
} from './chat-helpers';
import { ChatFiles as Files } from './ChatFiles';
import { SearchMessages } from './SearchMessages';
import { QuotedMessageDialog } from './QuotedMessageDialog';
const Expressions = lazy(() => import('./Expressions').then((m) => m.Expressions));
const RichMessage = lazy(() => import('../RichMessage'));
const ApprovalPanel = lazy(() => import('./ApprovalPanel'));
export default tsxComponent(function ChatView(initialProps: { id: string; navigate: Navigate }) {
  const startConversation = useMessaging().conversations.find((chat) => chat.id === initialProps.id);
  const { user: owner, secrets } = messaging.account;
  const initialHistory =
    owner && secrets && startConversation
      ? peekHistory({ id: owner.id, secrets }, initialProps.id)
      : undefined;
  const initialMessages = merge(
    initialHistory?.messages ?? [],
    startConversation?.lastMessage ? [startConversation.lastMessage] : [],
  );
  const messagesState = shallowRef<ChatMessage[]>(initialMessages);
  const setMessages = writeRef(messagesState);
  const beforeState = shallowRef<number | undefined>(initialHistory?.before);
  const setBefore = writeRef(beforeState);
  const draftState = useExternalSnapshot(subscribeDrafts, () => readDraft(initialProps.id));
  const toolState = shallowRef<'expressions' | 'voice' | 'interaction'>();
  const setTool = writeRef(toolState);
  const insertTextState = shallowRef<{ key: string; text: string; focus?: boolean }>();
  const setInsertText = writeRef(insertTextState);
  const savedStickerState = shallowRef('');
  const setSavedSticker = writeRef(savedStickerState);
  const voiceRequest: { current: { file: File; id: string; uploaded?: ChatAttachment } | undefined } = {
    current: undefined,
  };
  const specialRequest: { current: { key: string; id: string } | undefined } = { current: undefined };
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const uploadingState = shallowRef(false);
  const setUploading = writeRef(uploadingState);
  const uploadJobsState = shallowRef<UploadItem[]>([]);
  const setUploadJobs = writeRef(uploadJobsState);
  const olderBusyState = shallowRef(false);
  const setOlderBusy = writeRef(olderBusyState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const loadingState = shallowRef(!initialHistory);
  const setLoading = writeRef(loadingState);
  const showLoading = shallowRef(false);
  const unavailableState = shallowRef(false);
  const setUnavailable = writeRef(unavailableState);
  const visibleState = shallowRef(document.visibilityState === 'visible');
  const setVisible = writeRef(visibleState);
  const detailsState = shallowRef(false);
  const setDetails = writeRef(detailsState);
  const searchState = shallowRef(false);
  const setSearch = writeRef(searchState);
  const quotedState = shallowRef<ChatMessage>();
  const setQuoted = writeRef(quotedState);
  const copiedState = shallowRef('');
  const setCopied = writeRef(copiedState);
  const followingState = shallowRef(true);
  const setFollowing = writeRef(followingState);
  const securityState = shallowRef(false);
  const setSecurity = writeRef(securityState);
  const approvalsOpen = shallowRef(false);
  const chatTools = shallowRef(false);
  const exportOpen = shallowRef(false);
  const exportBusy = shallowRef(false);
  const exportStatus = shallowRef('');
  const latest = { current: initialHistory?.messages.at(-1)?.sequence ?? 0 };
  const scroll = shallowRef<HTMLDivElement | null>(null);
  const follow = { current: true };
  const initialized = { current: !!initialHistory };
  const uploadAbort: { current: AbortController | null } = { current: null };
  const readAccess = memoizeRender();
  const composerLayout = useExternalSnapshot(subscribeComposerLayout, mobileComposer);
  const afterRender = watchRender();
  const watchVisible = watchRender();
  const watchBefore = watchRender();
  const watchLoading = watchRender();
  const watchMessages = watchRender();
  const watchPending = watchRender();
  const watchVisible2 = watchRender();
  const watchMessages2 = watchRender();
  const afterRender2 = watchRender();
  return ({ id, navigate }) => {
    const { user, conversations, recovery, updates } = useMessaging(),
      conversation = conversations.find((c) => c.id === id);
    const messages = messagesState.value;
    const transcript = messages.filter((message) => message.interaction?.kind !== 'approval');
    const needsApproval = messages.some(({ interaction }) =>
      interaction?.kind === 'approval' && interaction.recipientId === user?.id &&
      interaction.status === 'pending' && interaction.expiresAt > Date.now());
    const before = beforeState.value;
    const draft = draftState.value;
    const tool = toolState.value;
    const insertText = insertTextState.value;
    const savedSticker = savedStickerState.value;

    const busy = busyState.value;
    const uploading = uploadingState.value;
    const uploadJobs = uploadJobsState.value;
    const olderBusy = olderBusyState.value;
    const error = errorState.value;
    const loading = loadingState.value;
    const unavailable = unavailableState.value;
    const visible = visibleState.value;
    const details = detailsState.value;
    const search = searchState.value;
    const quoted = quotedState.value;
    const copied = copiedState.value;
    const following = followingState.value;
    const security = securityState.value;
    const chatActions = [
      { label: '搜索聊天记录', icon: 'search', open: () => setSearch(true) },
      {
        label: '导出聊天记录',
        icon: 'download',
        open: () => {
          exportStatus.value = '';
          exportOpen.value = true;
        },
      },
      { label: '查看加密安全码', icon: 'shield', open: () => setSecurity(true) },
      ...(conversation?.kind === 'group'
        ? [{ label: '成员', icon: 'contacts' as const, open: () => setDetails(true) }]
        : []),
    ] as const;
    function currentHistoryOwner() {
      const { secrets: currentSecrets } = messaging.account;
      return currentSecrets && user?.id === messaging.account.user?.id
        ? { id: user!.id, secrets: currentSecrets }
        : undefined;
    }
    function persistMessages(items: ChatMessage[], cursor?: number) {
      const owner = currentHistoryOwner();
      if (!owner || (!items.length && cursor === undefined)) return;
      void saveHistory(owner, id, { messages: items, ...(cursor !== undefined ? { before: cursor } : {}) });
    }

    const access = readAccess<AttachmentAccess>(
      () => ({
        peek(threadId, path) {
          return threadId === id ? peekMessagingMedia(user!.id, path) : undefined;
        },
        async load(threadId, path, signal, fullSize) {
          const url = new URL(path, location.origin);
          if (
            url.origin !== location.origin ||
            threadId !== id ||
            !url.pathname.startsWith(`/api/im/conversations/${id}/files/`)
          )
            throw Error('请使用此会话中的附件');
          try {
            return await loadMessagingMedia(user!.id, path, signal, fullSize);
          } catch (error) {
            if (!signal?.aborted)
              recordDiagnostic({
                code: 'im-media-load-failed',
                page: 'messages',
                status: diagnosticStatus(error),
              });
            throw error;
          }
        },
      }),
      [id, user!.id],
    );
    function change(update: Partial<MessagingDraft>) {
      updateDraft(id, (current) => ({ ...current, ...update }));
    }
    afterRender(
      () => () => {
        uploadAbort.current?.abort();
      },
      [],
    );
    watchVisible(() => {
      const listener = () => setVisible(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    }, []);
    watchLoading(() => {
      showLoading.value = false;
      if (!loading || messages.length) return;
      const timer = window.setTimeout(() => {
        showLoading.value = true;
      }, 450);
      return () => window.clearTimeout(timer);
    }, [loading, messages.length]);
    watchBefore(() => {
      const abort = new AbortController();
      const { secrets } = messaging.account;
      const owner =
        secrets && user?.id === messaging.account.user?.id ? { id: user!.id, secrets } : undefined;
      let fresh = false;
      const cached =
        owner && conversation && !initialized.current
          ? cachedHistory(owner, id).then((page) => {
              if (!page || abort.signal.aborted || fresh || messaging.account.secrets !== secrets) return;
              setBefore(page.before);
              setMessages((old) => merge(page.messages, old));
              latest.current = Math.max(latest.current, page.messages.at(-1)?.sequence ?? 0);
              initialized.current = true;
              setLoading(false);
            })
          : undefined;
      void (async () => {
        try {
          const page = await messaging.history(id, undefined, abort.signal);
          if (abort.signal.aborted) return;
          fresh = true;
          if (owner && messaging.account.secrets === secrets) void saveHistory(owner, id, page);
          let rows = page.messages,
            cursor = page.before;
          while (latest.current && cursor && rows[0]?.sequence > latest.current) {
            const p = await messaging.history(id, cursor, abort.signal);
            rows = [...p.messages, ...rows];
            cursor = p.before;
          }
          if (abort.signal.aborted) return;
          if (owner && messaging.account.secrets === secrets)
            void saveHistory(owner, id, { messages: rows, ...(cursor !== undefined ? { before: cursor } : {}) });
          if (!initialized.current) {
            setBefore(cursor);
            initialized.current = true;
          }
          setMessages((old) => merge(old, rows));
          latest.current = Math.max(latest.current, rows.at(-1)?.sequence ?? 0);
          setLoading(false);
          setUnavailable(false);
        } catch (e) {
          await cached;
          if (!abort.signal.aborted) {
            setLoading(false);
            const status = (e as { status?: number }).status ?? 0;
            if ([401, 403, 404].includes(status)) {
              if (owner) void forgetHistory(owner, id);
              setMessages([]);
              setBefore(undefined);
              setUnavailable(true);
            }
            if (!initialized.current || !status || status >= 500)
              recordDiagnostic({ code: 'im-history-failed', page: 'messages', status: diagnosticStatus(e) });
            if (!initialized.current || [401, 403, 404].includes(status)) setError(errorText(e));
          }
        }
      })();
      return () => abort.abort();
    }, [id, user?.id, conversation?.id, recovery]);
    watchMessages(() => {
      if (!conversation && initialized.current) {
        setMessages([]);
        setUnavailable(true);
        return;
      }
      if (conversation) {
        const incoming = updates.filter((m) => m.conversationId === id);
        if (incoming.length) {
          setMessages((old) => merge(old, incoming));
          persistMessages(incoming);
        }
      }
    }, [updates, conversation, id]);
    const last = messages.at(-1),
      active = messages.filter((m) => m.state === 'streaming'),
      hasDraft = !!draft.text.trim() || !!draft.files.length,
      pending = draft.pending,
      sending = !!pending && !pending.error,
      echoed = !!pending && messages.some((m) => m.clientId === pending.id && m.senderId === user!.id),
      composerToolsDisabled =
        busy ||
        sending ||
        uploading ||
        loading ||
        unavailable ||
        !!conversation?.closed ||
        !!conversation?.readOnlyReason;
    watchPending(() => {
      if (pending && echoed) finishSend(pending.id);
    }, [pending?.id, echoed]);
    const compactComposer = composerLayout.value;
    const canRequestInteraction = conversation?.members.some((m) => m.id !== user!.id && m.kind === 'human');
    watchVisible2(() => {
      if (visible && last && conversation && last.sequence > conversation.readSequence)
        void messaging.read(id, last.sequence).catch(() => {});
    }, [visible, last?.sequence, conversation?.readSequence, id]);
    watchMessages2(() => {
      if (follow.current && scroll.value) scroll.value.scrollTop = scroll.value.scrollHeight;
    }, [messages, pending?.id, pending?.error]);
    afterRender2(() => {
      const root = scroll.value;
      if (!root) return;
      // Opening a mobile tray or resizing the keyboard keeps the latest message visible.
      const observer = new ResizeObserver(() => {
        if (follow.current) root.scrollTop = root.scrollHeight;
      });
      observer.observe(root);
      return () => observer.disconnect();
    }, []);
    async function older() {
      if (!before) return;
      setOlderBusy(true);
      const height = scroll.value?.scrollHeight ?? 0;
      try {
        const page = await messaging.history(id, before);
        setBefore(page.before);
        setMessages((old) => merge(page.messages, old));
        persistMessages(page.messages, page.before);
        requestAnimationFrame(() => {
          if (scroll.value) scroll.value.scrollTop += scroll.value.scrollHeight - height;
        });
      } catch (e) {
        setError(errorText(e));
      } finally {
        setOlderBusy(false);
      }
    }
    async function upload(files: FileList | File[] | null, source?: ComposerAttachmentSource) {
      if (!files?.length || uploadAbort.current) return false;
      const list = Array.from(files);
      if (list.length + readDraft(id).files.length > 6) {
        setError('每条消息最多 6 个附件');
        return false;
      }
      if (list.some((f) => !f.size || (source !== 'photo' && f.size > attachmentLimit))) {
        setError('请选择不超过 10 MB 的非空文件');
        return false;
      }
      const abort = new AbortController();
      uploadAbort.current = abort;
      setUploading(true);
      setError('');
      const jobs = uploadItems(list);
      setUploadJobs(jobs);
      const update = (index: number, value: Partial<UploadItem>) =>
        setUploadJobs((old) => old.map((job) => (job.id === jobs[index].id ? { ...job, ...value } : job)));
      let succeeded = true;
      try {
        for (let i = 0; i < list.length; i++) {
          if (abort.signal.aborted) return false;
          update(i, { state: 'active' });
          try {
            const chosen = list[i];
            const prepared =
              source === 'photo' && chosen.size > attachmentLimit
                ? await (await import('./prepare-photo')).preparePhoto(chosen, attachmentLimit, abort.signal)
                : chosen;
            const { file } = await messaging.upload(id, prepared.name, prepared, abort.signal, (progress) =>
              update(i, progress),
            );
            if (abort.signal.aborted) return false;
            change({ files: [...readDraft(id).files, file] });
            update(i, { state: 'done' });
          } catch (e) {
            if (abort.signal.aborted) return false;
            update(i, { state: 'failed', error: errorText(e) });
            succeeded = false;
          }
        }
      } finally {
        uploadAbort.current = null;
        if (!abort.signal.aborted) setUploading(false);
      }
      return succeeded;
    }
    async function remove(file: ChatAttachment) {
      change({ files: readDraft(id).files.filter((f) => f.id !== file.id) });
      void messaging.request(`/conversations/${id}/files/${file.id}`, 'DELETE').catch(() => {});
    }
    function finishSend(clientId: string) {
      updateDraft(id, (current) =>
        current.pending?.id === clientId ? { ...current, pending: undefined } : current,
      );
    }
    async function send(retry?: PendingMessage) {
      const current = readDraft(id);
      if (composerToolsDisabled || (retry ? current.pending !== retry : !!current.pending || !hasDraft))
        return;
      const text = current.text.trim(),
        mentions =
          conversation?.members
            .filter((m) =>
              Array.from(text.matchAll(/(?:^|\s)@([a-z0-9_-]+)/gi)).some(
                (match) => match[1].toLowerCase() === m.username,
              ),
            )
            .map((m) => m.id) ?? [];
      const request: PendingMessage = retry
        ? { ...retry, error: undefined, rejected: undefined }
        : {
            id: browserId(),
            createdAt: Date.now(),
            text,
            files: current.files,
            reply: current.reply,
            options: { attachmentIds: current.files.map((f) => f.id), mentions, replyTo: current.reply?.id },
          };
      setError('');
      follow.current = true;
      setFollowing(true);
      updateDraft(id, () =>
        retry ? { ...current, pending: request } : { text: '', files: [], pending: request },
      );
      if (!retry) setUploadJobs([]);
      try {
        const { message } = await messaging.send(id, request.text, request.id, request.options);
        setMessages((old) => merge(old, [message]));
        persistMessages([message]);
        finishSend(request.id);
      } catch (e) {
        recordDiagnostic({ code: 'im-send-failed', page: 'messages', status: diagnosticStatus(e) });
        updateDraft(id, (draft) =>
          draft.pending === request
            ? {
                ...draft,
                pending: {
                  ...request,
                  error: errorText(e),
                  rejected:
                    e instanceof MessagingError &&
                    e.status >= 400 &&
                    e.status < 500 &&
                    ![408, 409, 429].includes(e.status),
                },
              }
            : draft,
        );
      }
    }
    async function cancel(message: ChatMessage) {
      try {
        const result = await messaging.cancel(id, message.id);
        setMessages((old) => merge(old, [result.message]));
        persistMessages([result.message]);
      } catch (e) {
        setError(errorText(e));
      }
    }
    async function sendSpecial(options: SendMessageOptions) {
      const text = options.interaction?.title ?? '',
        key = JSON.stringify({ text, options });
      const request = specialRequest.current?.key === key ? specialRequest.current : { key, id: browserId() };
      specialRequest.current = request;
      const result = await messaging.send(id, text, request.id, options);
      follow.current = true;
      setFollowing(true);
      setMessages((old) => merge(old, [result.message]));
      persistMessages([result.message]);
      specialRequest.current = undefined;
    }
    async function sendVoice(file: File) {
      if (busy || sending || uploading || unavailable || conversation?.closed || conversation?.readOnlyReason)
        throw new Error('当前无法发送语音，请稍后重试。');
      const request =
        voiceRequest.current?.file === file
          ? voiceRequest.current
          : { file, id: browserId(), uploaded: undefined as ChatAttachment | undefined };
      voiceRequest.current = request;
      setBusy(true);
      try {
        if (!request.uploaded) request.uploaded = (await messaging.upload(id, file.name, file)).file;
        const { message } = await messaging.send(id, '', request.id, {
          attachmentIds: [request.uploaded.id],
        });
        follow.current = true;
        setFollowing(true);
        setMessages((old) => merge(old, [message]));
        persistMessages([message]);
        voiceRequest.current = undefined;
      } finally {
        setBusy(false);
      }
    }
    async function exportHistory(format: ChatExportFormat) {
      if (!conversation || exportBusy.value) return;
      exportBusy.value = true;
      exportStatus.value = '正在汇总本机缓存与云端近 7 天记录…';
      try {
        let collected = [...messages];
        const owner = currentHistoryOwner();
        if (owner) {
          const cached = await cachedHistory(owner, id);
          if (cached?.messages.length) collected = merge(cached.messages, collected);
        }
        let cursor = before;
        let pages = 0;
        while (cursor && pages < 100) {
          try {
            const page = await messaging.history(id, cursor);
            collected = merge(page.messages, collected);
            cursor = page.before;
            pages++;
          } catch {
            // Keep already-collected local + cloud messages if older cloud pages are unavailable.
            break;
          }
        }
        if (collected.length) {
          setMessages((old) => merge(collected, old));
          persistMessages(collected, cursor);
        }
        const now = Date.now();
        const filename = exportFilename(conversation.name, format, now);
        const content =
          format === 'json'
            ? formatChatExportJson(conversation, collected, now)
            : formatChatExportMarkdown(conversation, collected, now);
        triggerTextDownload(
          filename,
          content,
          format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8',
        );
        exportStatus.value = `已导出 ${collected.length} 条记录（${filename}）`;
      } catch (e) {
        exportStatus.value = errorText(e);
      } finally {
        exportBusy.value = false;
      }
    }
    async function favorite(file: ChatAttachment) {
      try {
        await messaging.saveSticker(id, file.id);
        setSavedSticker(file.id);
      } catch (e) {
        setError(errorText(e));
      }
    }
    function showQuote(message: ChatMessage) {
      if (message.interaction?.kind === 'approval') {
        setQuoted(undefined);
        setSearch(false);
        approvalsOpen.value = true;
        return;
      }
      setQuoted(message);
    }
    async function openQuote(messageId: string, cached: ChatMessage | undefined) {
      if (cached?.interaction?.kind === 'approval') {
        showQuote(cached);
        return;
      }
      try {
        const { message } = await messaging.request<{ message: ChatMessage }>(
          `/conversations/${id}/messages/${messageId}`,
        );
        showQuote(message);
      } catch (error) {
        setError(errorText(error));
      }
    }
    function jump() {
      follow.current = true;
      setFollowing(true);
      if (scroll.value) scroll.value.scrollTop = scroll.value.scrollHeight;
    }
    return (
      <AttachmentAccessProvider value={access}>
        {() => (
          <>
            <section class="im-chat" aria-label="聊天内容">
              <ConversationHeader
                className="im-chat-header"
                title={conversation?.name ?? '聊天'}
                backLabel="返回消息列表"
                onBack={() => backTo({ page: 'messages' }, navigate)}
                subtitle={
                  <span>
                    {conversation?.kind === 'group'
                      ? `${conversation.members.length} 位成员${conversation.closed ? ' · 已解散' : ''}`
                      : conversation?.peer
                        ? `@${conversation.peer.username} · ${conversation.peer.kind === 'agent' ? 'Agent' : '联系人'}`
                        : ''}
                  </span>
                }
              >
                {() => (
                  <>
                    {conversation && (
                      <button type="button" class="icon-button im-approval-trigger" aria-haspopup="dialog"
                        aria-label={needsApproval ? '审批面板，有待审批记录' : '审批面板'}
                        title="审批面板"
                        onClick={() => (approvalsOpen.value = true)}>
                        <Icon name="approval" size={19} />
                        {!compactComposer && <span>审批</span>}
                        {needsApproval && <i aria-hidden="true" />}
                      </button>
                    )}
                    {conversation?.kind === 'direct' &&
                      conversation.peer?.kind === 'agent' &&
                      !conversation.readOnlyReason && (
                        <AgentCallActions key={conversation.id} conversation={conversation} />
                      )}
                    {compactComposer ? (
                      <button
                        type="button"
                        class="icon-button"
                        aria-label="聊天工具"
                        aria-haspopup="dialog"
                        aria-expanded={chatTools.value}
                        onClick={() => (chatTools.value = true)}
                      >
                        <Icon name="more" />
                      </button>
                    ) : (
                      chatActions.map(({ label, icon, open }) => (
                        <button
                          key={icon}
                          type="button"
                          class={icon === 'contacts' ? 'secondary im-members-button' : 'icon-button'}
                          aria-label={label}
                          onClick={open}
                        >
                          <Icon name={icon} />
                          {icon === 'contacts' && <span>{label}</span>}
                        </button>
                      ))
                    )}
                  </>
                )}
              </ConversationHeader>
              <div
                ref={scroll}
                class="im-transcript"
                role="log"
                aria-label="聊天记录"
                onScroll={() => {
                  if (scroll.value) {
                    follow.current =
                      scroll.value.scrollHeight - scroll.value.scrollTop - scroll.value.clientHeight < 100;
                    setFollowing(follow.current);
                  }
                }}
              >
                {before && (
                  <button class="secondary im-history" disabled={olderBusy} onClick={() => void older()}>
                    {olderBusy ? '正在加载…' : '加载更早消息'}
                  </button>
                )}
                {showLoading.value && loading && !messages.length && (
                  <p class="page-loading">正在加载消息…</p>
                )}
                {!loading && !transcript.length && !pending && !unavailable && (
                  <p class="im-start">发送第一条消息，开始聊天。</p>
                )}
                {transcript.map((message, index) => {
                  const mine = message.senderId === user!.id,
                    sender = conversation?.members.find((m) => m.id === message.senderId) ?? message.sender;
                  const previous = transcript[index - 1];
                  const replyTo = message.replyTo;
                  const reply = replyTo ? messages.find((m) => m.id === replyTo) : undefined;
                  const currentActivity = message.activities?.findLast(
                    ({ status }) => status === 'in_progress',
                  );
                  const newDay =
                    !previous ||
                    new Date(previous.createdAt).toDateString() !==
                      new Date(message.createdAt).toDateString();
                  return (
                    <div key={message.id}>
                      {newDay && (
                        <div class="im-date">
                          <span>
                            {new Date(message.createdAt).toLocaleDateString('zh-CN', {
                              month: 'long',
                              day: 'numeric',
                            })}
                          </span>
                        </div>
                      )}
                      <article
                        class={`im-message ${mine ? 'mine' : ''} ${sender?.kind === 'agent' ? 'from-agent' : ''}`}
                        data-message-id={message.id}
                      >
                        <Avatar user={sender} />
                        <div class="im-message-main">
                          <div class="im-message-author">
                            <strong>{sender?.displayName ?? '成员'}</strong>
                            {sender?.kind === 'agent' && <span class="im-kind">Agent</span>}
                            <time>{time(message.createdAt)}</time>
                          </div>
                          <div
                            class={`im-bubble ${message.state === 'streaming' ? 'is-streaming' : ''} ${message.sticker ? 'is-sticker' : ''} ${!message.text && message.attachments.length && !message.replyTo ? 'is-media-only' : ''}`}
                          >
                            {replyTo && (
                              <button
                                class="im-quote"
                                onClick={() => void openQuote(replyTo, reply)}
                              >
                                <Icon name="chat" size={14} />
                                <span>{quoteLabel(reply)}</span>
                              </button>
                            )}
                            {!!message.activities?.length && (
                              <details class="im-agent-activities">
                                <summary>
                                  {message.state === 'streaming' && currentActivity
                                    ? `正在${activityNames[currentActivity.kind]}…`
                                    : `查看 ${message.activities.length} 项处理进度`}
                                </summary>
                                <ul>
                                  {message.activities.map(({ kind, status }, index) => (
                                    <li key={index}>
                                      <span>{activityNames[kind]}</span>
                                      <small>
                                        {message.state !== 'streaming' &&
                                        (status === 'pending' || status === 'in_progress')
                                          ? '未确认结果'
                                          : activityStates[status]}
                                      </small>
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            )}
                            {message.text &&
                              !message.interaction &&
                              !(
                                message.state === 'streaming' &&
                                sender?.kind === 'agent' &&
                                /^(?:…+|\.{3,})$/.test(message.text.trim())
                              ) && (
                                <div data-selection-translation="">
                                  <Suspense timeout={0}>
                                    {{
                                      fallback: () => <div class="im-plain">{message.text}</div>,
                                      default: () => (
                                        <>
                                          <RichMessage
                                            preserveLineBreaks={sender?.kind !== 'agent'}
                                            text={message.text}
                                            threadId={id}
                                            streaming={message.state === 'streaming'}
                                          />
                                        </>
                                      ),
                                    }}
                                  </Suspense>
                                </div>
                              )}
                            {message.interaction && (
                              <InteractionCard
                                message={message}
                                userId={user!.id}
                                disabled={
                                  unavailable || !!conversation?.closed || !!conversation?.readOnlyReason
                                }
                                onUpdate={(message) => setMessages((old) => merge(old, [message]))}
                              />
                            )}
                            {!!message.attachments.length && <Files files={message.attachments} id={id} />}
                            {message.state === 'streaming' && (
                              <div class="im-stream-status" role="status">
                                <span class="im-stream-dots" />
                                正在回复…
                                <button class="secondary" onClick={() => void cancel(message)}>
                                  <Icon name="stop" size={13} />
                                  停止
                                </button>
                              </div>
                            )}
                            {message.state === 'cancelled' && <p class="im-message-state">回复已停止</p>}
                            {message.state === 'failed' && (
                              <p class="im-message-state">回复中断，已保留收到的内容</p>
                            )}
                          </div>
                          <div class="im-message-actions">
                            <button
                              aria-label="引用回复"
                              title="引用回复"
                              onClick={() => change({ reply: message })}
                            >
                              <Icon name="chat" size={14} />
                            </button>
                            <button
                              aria-label="复制消息"
                              title="复制消息"
                              onClick={() => {
                                if (!navigator.clipboard) {
                                  setError('请选中消息手动复制');
                                  return;
                                }
                                void navigator.clipboard
                                  .writeText(message.text)
                                  .then(() => setCopied(message.id))
                                  .catch(() => setError('请选中消息手动复制'));
                              }}
                            >
                              <Icon name={copied === message.id ? 'check' : 'copy'} size={14} />
                            </button>
                            {message.attachments
                              .filter(
                                (file) => file.mime.startsWith('image/') && file.size <= 2 * 1024 * 1024,
                              )
                              .map((file) => (
                                <button
                                  key={file.id}
                                  aria-label={`收藏表情 ${file.name}`}
                                  title="收藏表情"
                                  onClick={() => void favorite(file)}
                                >
                                  <Icon name={savedSticker === file.id ? 'check' : 'sticker'} size={14} />
                                  <span>{savedSticker === file.id ? '已收藏' : '收藏表情'}</span>
                                </button>
                              ))}
                            {mine && (
                              <small>
                                {conversation?.kind === 'direct'
                                  ? message.sequence <= (conversation.peerReadSequence ?? 0)
                                    ? '已读'
                                    : '已发送'
                                  : `${conversation?.members.filter((m) => m.id !== user!.id && m.readSequence >= message.sequence).length ?? 0} 人已读`}
                              </small>
                            )}
                          </div>
                        </div>
                      </article>
                    </div>
                  );
                })}
                {pending && !echoed && (
                  <article class="im-message mine outgoing-message" data-outgoing-id={pending.id}>
                    <Avatar user={user} />
                    <div class="im-message-main">
                      <div class="im-message-author">
                        <strong>{user!.displayName}</strong>
                        <time>{time(pending.createdAt)}</time>
                      </div>
                      <div class="im-bubble">
                        <OutgoingContent text={pending.text} files={pending.files}>
                          {() => (
                            <>
                              {pending.reply && (
                                <div class="im-quote">
                                  <Icon name="chat" size={14} />
                                  <span>{quoteLabel(pending.reply, '引用消息')}</span>
                                </div>
                              )}
                            </>
                          )}
                        </OutgoingContent>
                      </div>
                      <OutgoingStatus activity={sending ? '正在发送…' : undefined}>
                        {() => (
                          <>
                            {pending.error && (
                              <>
                                <span role="alert">
                                  {pending.rejected ? '未能发送' : '发送结果待确认'} · {pending.error}
                                </span>
                                <div class="outgoing-actions">
                                  <button
                                    type="button"
                                    disabled={composerToolsDisabled}
                                    onClick={() => void send(pending)}
                                  >
                                    重试
                                  </button>
                                  {pending.rejected && !hasDraft && !draft.reply && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateDraft(id, (current) =>
                                          current.pending === pending &&
                                          !current.text.trim() &&
                                          !current.files.length &&
                                          !current.reply
                                            ? {
                                                text: pending.text,
                                                files: pending.files,
                                                reply: pending.reply,
                                              }
                                            : current,
                                        )
                                      }
                                    >
                                      移回输入框
                                    </button>
                                  )}
                                  <button type="button" onClick={() => finishSend(pending.id)}>
                                    移除发送记录
                                  </button>
                                </div>
                              </>
                            )}
                          </>
                        )}
                      </OutgoingStatus>
                    </div>
                  </article>
                )}
              </div>
              <Notice text={error} />
              <footer class="im-compose-wrap">
                {!following && (
                  <button class="im-jump icon-button" type="button" aria-label="跳到最新消息" onClick={jump}>
                    <Icon name="down" size={18} />
                  </button>
                )}
                {draft.reply && (
                  <div class="im-reply-draft">
                    <span>
                      回复 {draft.reply.sender?.displayName ?? '成员'}：{quoteLabel(draft.reply, '')}
                    </span>
                    <button
                      aria-label="取消引用"
                      class="icon-button"
                      onClick={() => change({ reply: undefined })}
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                )}
                <ChatComposer
                  activity={busy || sending ? '正在发送…' : undefined}
                  insertText={insertText}
                  value={{
                    text: draft.text,
                    uploads: draft.files.map((f) => ({ id: f.id, name: f.name, path: f.url })),
                    skills: [],
                    plugins: [],
                  }}
                  onChange={(update) => {
                    const current = { text: readDraft(id).text, uploads: [], skills: [], plugins: [] };
                    const next = typeof update === 'function' ? update(current) : update;
                    change({ text: next.text ?? current.text });
                  }}
                  disabled={unavailable || !!conversation?.closed || !!conversation?.readOnlyReason}
                  sendDisabled={
                    busy ||
                    sending ||
                    (!!pending && hasDraft) ||
                    uploading ||
                    loading ||
                    unavailable ||
                    !!conversation?.closed ||
                    !!conversation?.readOnlyReason ||
                    (!hasDraft && !active.length)
                  }
                  placeholder={
                    conversation?.closed
                      ? '群聊已解散'
                      : conversation?.kind === 'group'
                        ? '发送消息，@ 提及成员'
                        : '发送消息…'
                  }
                  messageLabel="聊天消息"
                  maxLength={16000}
                  onSubmit={() => void send()}
                  onUpload={(files, source) => void upload(files, source)}
                  showUploadButton={!compactComposer}
                  uploading={uploading}
                  uploadItems={uploadJobs}
                  onDismissUploads={() => setUploadJobs([])}
                  uploadDisabled={composerToolsDisabled}
                  running={!!active.length}
                  onInterrupt={() => {
                    for (const message of active) void cancel(message);
                  }}
                  sendLabels={{ send: '发送消息', running: '发送消息', stop: '停止回复' }}
                  attachmentPreview={
                    draft.files.length ? (
                      <Files files={draft.files} id={id} compact onRemove={(file) => void remove(file)} />
                    ) : null
                  }
                  actions={(openAttachmentPicker) => (
                    <>
                      <button
                        type="button"
                        class="icon-button im-voice-trigger"
                        aria-label="语音消息"
                        title="语音消息"
                        disabled={composerToolsDisabled}
                        aria-expanded={tool === 'voice'}
                        onClick={(event) => {
                          (event.currentTarget as HTMLButtonElement)
                            .closest('form')
                            ?.querySelector('textarea')
                            ?.blur();
                          setTool(tool === 'voice' ? undefined : 'voice');
                        }}
                      >
                        <Icon name="mic" size={22} />
                      </button>
                      {(compactComposer || canRequestInteraction) && (
                        <ComposerPopover
                          label="更多功能"
                          className="im-more-trigger"
                          menu
                          maxWidth={208}
                          trigger={<Icon name="plus" size={22} />}
                          disabled={composerToolsDisabled}
                          onOpen={() => setTool(undefined)}
                          children={(close) => (
                            <div class="im-more-items">
                              {compactComposer &&
                                composerAttachmentChoices.map((choice) => (
                                  <button
                                    key={choice.source}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      // Keep the original tap and leave the input mounted outside the menu.
                                      openAttachmentPicker(choice.source);
                                      close(false);
                                    }}
                                  >
                                    <Icon name={choice.icon} size={20} />
                                    {choice.label}
                                  </button>
                                ))}
                              {canRequestInteraction && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    close();
                                    setTool('interaction');
                                  }}
                                >
                                  <Icon name="plan" size={20} />
                                  发起交互请求
                                </button>
                              )}
                            </div>
                          )}
                        />
                      )}
                      <button
                        type="button"
                        class="icon-button"
                        data-expression-trigger
                        aria-label="表情与表情包"
                        title="表情与表情包"
                        disabled={composerToolsDisabled}
                        aria-expanded={tool === 'expressions'}
                        onClick={(event) => {
                          (event.currentTarget as HTMLButtonElement)
                            .closest('form')
                            ?.querySelector('textarea')
                            ?.blur();
                          setTool(tool === 'expressions' ? undefined : 'expressions');
                        }}
                      >
                        <Icon name="smile" size={22} />
                      </button>
                      {conversation?.kind === 'group' ? (
                        <label class="im-mention">
                          <span aria-hidden="true">@</span>
                          <select
                            aria-label="提及成员"
                            value=""
                            onChange={(e) => {
                              if ((e.currentTarget as HTMLSelectElement).value)
                                change({
                                  text: `${readDraft(id).text}${readDraft(id).text && !readDraft(id).text.endsWith(' ') ? ' ' : ''}@${(e.currentTarget as HTMLSelectElement).value} `,
                                });
                            }}
                          >
                            <option value="">提及成员</option>
                            {conversation.members
                              .filter((m) => m.id !== user!.id)
                              .map((m) => (
                                <option key={m.id} value={m.username}>
                                  {m.displayName}
                                </option>
                              ))}
                          </select>
                        </label>
                      ) : null}
                    </>
                  )}
                />
                <Suspense timeout={0}>
                  {{
                    fallback: () => null,
                    default: () => (
                      <>
                        {tool === 'expressions' && (
                          <Expressions
                            userId={user!.id}
                            conversationId={id}
                            onClose={() => setTool(undefined)}
                            onEmoji={(text) => setInsertText({ key: browserId(), text, focus: false })}
                            onSticker={(stickerId) => sendSpecial({ stickerId })}
                          />
                        )}
                      </>
                    ),
                  }}
                </Suspense>
                {tool === 'voice' && <VoiceRecorder onClose={() => setTool(undefined)} onSend={sendVoice} />}
                <p class="im-compose-help">
                  {conversation?.readOnlyReason
                    ? conversation.readOnlyReason
                    : conversation?.closed
                      ? '历史消息仍可阅读'
                      : 'Enter 发送 · Shift + Enter 换行'}
                </p>
              </footer>
              {compactComposer && chatTools.value && (
                <Dialog title="聊天工具" className="im-chat-tools" onClose={() => (chatTools.value = false)}>
                  {() =>
                    chatActions.map(({ label, icon, open }) => (
                      <button
                        key={icon}
                        type="button"
                        onClick={() => {
                          chatTools.value = false;
                          open();
                        }}
                      >
                        <Icon name={icon} size={20} />
                        <span>{label}</span>
                      </button>
                    ))
                  }
                </Dialog>
              )}
              {tool === 'interaction' && conversation && (
                <CreateInteraction
                  conversation={conversation}
                  userId={user!.id}
                  onClose={() => setTool(undefined)}
                  onSend={(interaction) => sendSpecial({ interaction })}
                />
              )}
              {approvalsOpen.value && user && conversation && (
                <ApprovalPanel id={id} name={conversation.name} userId={user.id}
                  readonly={unavailable || conversation.closed || !!conversation.readOnlyReason}
                  updates={messages} recovery={recovery}
                  onUpdate={(message) => setMessages((old) => merge(old, [message]))}
                  onClose={() => (approvalsOpen.value = false)} />
              )}
              {details && conversation && (
                <GroupDetails
                  conversation={conversation}
                  onClose={() => setDetails(false)}
                  navigate={navigate}
                />
              )}
              {security && conversation && (
                <SecurityCodes users={conversation.members} onClose={() => setSecurity(false)} />
              )}
              {exportOpen.value && conversation && (
                <Dialog
                  title="导出聊天记录"
                  className="im-export-dialog"
                  onClose={() => {
                    if (!exportBusy.value) exportOpen.value = false;
                  }}
                >
                  {() => (
                    <div class="im-export-body">
                      <p class="im-export-note">
                        云端消息与附件最多保留 7 天，过期会自动清理；本机缓存不受影响。导出会自动合并本机已缓存与云端可用记录，并在本机解密生成文件。
                      </p>
                      <div class="im-export-actions">
                        <button
                          type="button"
                          disabled={exportBusy.value}
                          onClick={() => void exportHistory('markdown')}
                        >
                          <Icon name="document" size={16} />
                          <span>{exportBusy.value ? '正在导出…' : '导出为 Markdown (.md)'}</span>
                        </button>
                        <button
                          type="button"
                          class="secondary"
                          disabled={exportBusy.value}
                          onClick={() => void exportHistory('json')}
                        >
                          <Icon name="code" size={16} />
                          <span>导出为 JSON (.json)</span>
                        </button>
                      </div>
                      {exportStatus.value && (
                        <p class="im-export-status" role="status">
                          {exportStatus.value}
                        </p>
                      )}
                    </div>
                  )}
                </Dialog>
              )}
              {search && <SearchMessages id={id} onClose={() => setSearch(false)} onSelect={showQuote} />}
              {quoted && quoted.interaction?.kind !== 'approval' && (
                <QuotedMessageDialog
                  id={id}
                  message={quoted}
                  userId={user!.id}
                  disabled={unavailable || !!conversation?.closed || !!conversation?.readOnlyReason}
                  onClose={() => setQuoted(undefined)}
                  onUpdate={(message) => {
                    setQuoted(message);
                    setMessages((old) => merge(old, [message]));
                  }}
                />
              )}
            </section>
          </>
        )}
      </AttachmentAccessProvider>
    );
  };
});
