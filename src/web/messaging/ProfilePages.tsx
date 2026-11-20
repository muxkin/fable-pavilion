import { shallowRef } from 'vue';
import type { ChatUser } from '../../shared/messaging';
import { tsxComponent } from '../tsx-component';
import { watchRender, writeRef } from '../render-effects';
import { PageHeader } from '../shell/PageHeader';
import { backTo } from '../shell/routes';
import { Icon } from '../Icon';
import { messaging, useMessaging } from './context';
import { Avatar, UserIdentity, Notice as ErrorNotice, errorText, time, type Navigate } from './ui';

export const Agents = tsxComponent(function Agents(_props: { navigate: Navigate; back?: () => void }) {
  const agentsState = shallowRef<ChatUser[]>([]);
  const setAgents = writeRef(agentsState);
  const invitationState = shallowRef<{ invitation: string; expiresAt: number }>();
  const setInvitation = writeRef(invitationState);
  const credentialState = shallowRef('');
  const setCredential = writeRef(credentialState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const noticeState = shallowRef('');
  const setNotice = writeRef(noticeState);
  const confirmState = shallowRef<{ id: string; rotate: boolean }>();
  const setConfirm = writeRef(confirmState);
  const watchAgents = watchRender();
  return ({ navigate, back }) => {
    const agents = agentsState.value;
    const invitation = invitationState.value;
    const credential = credentialState.value;
    const error = errorState.value;
    const busy = busyState.value;
    const notice = noticeState.value;
    const confirm = confirmState.value;
    const { revision } = useMessaging();
    watchAgents(() => {
      const abort = new AbortController();
      void messaging
        .request<{ users: ChatUser[] }>('/agents', 'GET', undefined, abort.signal)
        .then((v) => setAgents(v.users))
        .catch((e) => {
          if (!abort.signal.aborted) setError(errorText(e));
        });
      return () => abort.abort();
    }, [revision]);
    async function run(action: () => Promise<void>) {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        await action();
      } catch (error) {
        setError(errorText(error));
      } finally {
        setBusy(false);
      }
    }
    const instructions = invitation
      ? `请使用最新版子虚亭（Fable Pavilion）的加密客户端注册为我的聊天 Agent（邀请 15 分钟有效）。
服务地址：${location.origin}
一次性邀请：${invitation.invitation}

推荐使用项目 CLI：把邀请设置为 POCKET_IM_INVITATION，然后执行：
npm run im -- register --origin ${location.origin} --username my-agent --name 我的助手 --state /private/my-agent.json

用户名请改为唯一值。CLI 会在本地生成加密身份，将令牌和解密私钥保存在权限为 0600 的状态文件。请安全备份此文件，不要上传或打印其中的秘密。

后续使用相同 --state 执行 contacts、chat、send、sync、history、upload、request 等命令。用户 UID 始终是字符串，不要转换为数值。发送时提供稳定的 --request-id；保存 sync cursor，按消息 ID 与 revision 去重，不要回复自己的消息。

也可使用 src/client/encrypted-messaging.ts 的 EncryptedMessagingClient，在本地恢复自己的 AccountSecrets。不要直接向 /api/im POST 明文 text 或文件字节；所有正文、附件描述与授权回复均由加密客户端处理。

授权必须来自指定用户的有效签名回复，且绑定具体交互 ID。普通文本不算授权。收到 cancelled、rejected、expired 或无法验证的消息时，不要执行对应操作。

实时通话为 WebRTC 双向音视频，由 Agent 的媒体处理器处理。接入文档：docs/dev/agent-calls.md；SDK：src/client/calls.ts。已有凭据可运行 npm run im:call -- --state /private/my-agent.json --handler /private/media-handler.mjs。仅在处理器就绪时声明接听能力，不要把普通文字回复器标记为支持通话。

妥善保存 Agent 状态文件；重置登录令牌不恢复丢失的解密密钥。`
      : '';
    return (
      <>
        <PageHeader title="Agent 接入" back={back ?? (() => navigate({ page: 'contacts' }))} />
        <section class="im-agent-content">
          <div class="im-profile-heading">
            <span class="im-agent-symbol">
              <Icon name="chat" size={30} />
            </span>
            <div>
              <h2>让你的 Agent 加入聊天</h2>
              <p>一个邀请，连接你正在使用的助手。</p>
            </div>
          </div>
          <ol class="im-onboarding-steps">
            <li>
              <strong>生成邀请</strong>
              <span>一次使用，15 分钟有效。</span>
            </li>
            <li>
              <strong>交给 Agent</strong>
              <span>复制说明，让它完成注册并保存凭据。</span>
            </li>
            <li>
              <strong>开始协作</strong>
              <span>私聊、群聊和流式回复，使用同一个账户。</span>
            </li>
          </ol>
          <button
            class="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setInvitation(await messaging.request('/agent-invitations', 'POST', {}));
                setCredential('');
              })
            }
          >
            生成一次性邀请
          </button>
          {invitation && (
            <div class="im-secret">
              <strong>有效至 {time(invitation.expiresAt)}</strong>
              <p>重新生成会使旧邀请失效；邀请使用一次即失效。</p>
              <textarea aria-label="Agent 注册说明" value={instructions} readonly rows={9} />
              <button
                class="secondary"
                onClick={() =>
                  void run(async () => {
                    if (!navigator.clipboard) throw Error('请选中上方说明并手动复制');
                    await navigator.clipboard.writeText(instructions);
                    setNotice('注册说明已复制');
                  })
                }
              >
                复制注册说明
              </button>
            </div>
          )}
          <ErrorNotice text={error} />
          {notice && <p role="status">{notice}</p>}
          {credential && (
            <div class="im-secret">
              <strong>新凭据仅在这里显示</strong>
              <p>交给对应 Agent 保存后，关闭此区域。</p>
              <textarea aria-label="Agent 新凭据" value={credential} readonly rows={2} />
              <button class="secondary" onClick={() => setCredential('')}>
                已保存，关闭
              </button>
            </div>
          )}
          <h3>我的 Agent</h3>
          {!agents.length && <p>注册成功的 Agent 会出现在这里。</p>}
          {agents.map((agent) => (
            <div class="im-agent-row" key={agent.id}>
              <Avatar user={agent} />
              <span>
                <strong>{agent.displayName}</strong>
                <small>
                  UID {agent.id} · @{agent.username}
                </small>
              </span>
              <button class="secondary" onClick={() => setConfirm({ id: agent.id, rotate: true })}>
                重置凭据
              </button>
              <button class="danger" onClick={() => setConfirm({ id: agent.id, rotate: false })}>
                撤销
              </button>
            </div>
          ))}
          {confirm && (
            <div class="inline-confirm">
              <p>
                {confirm.rotate
                  ? '重置后，原凭据立即失效。请将新凭据交给此 Agent。'
                  : '撤销后，此 Agent 无法继续收发消息；聊天记录会保留。可以重置凭据恢复使用。'}
              </p>
              <div>
                <button class="secondary" disabled={busy} onClick={() => setConfirm(undefined)}>
                  取消
                </button>
                <button
                  class="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await messaging.request<{ token?: string }>(
                        `/agents/${confirm.id}/credentials`,
                        confirm.rotate ? 'POST' : 'DELETE',
                      );
                      setCredential(result.token ?? '');
                      setNotice(confirm.rotate ? '旧凭据已失效' : '凭据已撤销');
                      setConfirm(undefined);
                    })
                  }
                >
                  确认{confirm.rotate ? '重置' : '撤销'}
                </button>
              </div>
            </div>
          )}
        </section>
      </>
    );
  };
});
export const Profile = tsxComponent(function Profile(_props: { navigate: Navigate }) {
  const { user } = useMessaging();
  const nameState = shallowRef(user!.displayName);
  const setName = writeRef(nameState);
  const busyState = shallowRef(false);
  const errorState = shallowRef('');
  const noticeState = shallowRef('');
  return ({ navigate }) => {
    const { user, updateProfile } = useMessaging();
    const name = nameState.value;
    const busy = busyState.value;
    async function run(action: () => Promise<void>) {
      busyState.value = true;
      errorState.value = '';
      noticeState.value = '';
      try {
        await action();
      } catch (cause) {
        errorState.value = errorText(cause);
      } finally {
        busyState.value = false;
      }
    }
    return (
      <section class="account-profile-page">
        <PageHeader title="个人资料" back={() => backTo({ page: 'me' }, navigate)} />
        <div class="im-settings-content account-profile-content">
          <div class="im-profile-heading">
            <Avatar user={user} large />
            <div>
              <h2>{user!.displayName}</h2>
              <p>@{user!.username}</p>
            </div>
          </div>
          <UserIdentity user={user!} />
          <section class="im-settings-section">
            <h3>头像与昵称</h3>
            <div class="im-avatar-controls">
              <label class="secondary im-import-sticker">
                更换头像
                <input
                  type="file"
                  aria-label="更换头像"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  disabled={busy}
                  onChange={(event) => {
                    const file = (event.currentTarget as HTMLInputElement).files?.[0];
                    (event.currentTarget as HTMLInputElement).value = '';
                    if (!file) return;
                    void run(async () => {
                      if (file.size > 2 * 1024 * 1024) throw Error('头像不能超过 2 MB');
                      const response = await fetch('/api/im/me/avatar', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: file,
                      });
                      const body = await response.json();
                      if (!response.ok) throw Error(body.error);
                      updateProfile(body.user);
                      noticeState.value = '头像已更新';
                    });
                  }}
                />
              </label>
              {user?.avatarUrl && (
                <button
                  class="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await messaging.request<{ user: ChatUser }>('/me/avatar', 'DELETE');
                      updateProfile(result.user);
                      noticeState.value = '头像已移除';
                    })
                  }
                >
                  移除头像
                </button>
              )}
              <small>自动裁切为方形 · 最大 2 MB</small>
            </div>
            <form
              class="im-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const result = await messaging.request<{ user: ChatUser }>('/me', 'PATCH', {
                    displayName: name,
                  });
                  updateProfile(result.user);
                  noticeState.value = '已保存';
                });
              }}
            >
              <label>
                昵称
                <input
                  maxlength={60}
                  required
                  value={name}
                  onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <button class="primary" disabled={busy || !name.trim()}>
                保存
              </button>
            </form>
            <p class="im-help">UID 和用户名用于识别你的账号，接入 Agent 时会自动建立联系。</p>
          </section>
          <ErrorNotice text={errorState.value} />
          {noticeState.value && (
            <p class="im-notice success" role="status">
              {noticeState.value}
            </p>
          )}
        </div>
      </section>
    );
  };
});
