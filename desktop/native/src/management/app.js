const el = (id) => document.getElementById(id);
const phaseNames = { setup: '待设置', connecting: '中继连接中', online: '中继在线', unavailable: '中继重连中' };
const storageKey = 'agent-space-adapter-session';
let token = sessionStorage.getItem(storageKey);
let pairLink;
let qrUrl;
let qrRequest = 0;
let pairingAfterConnect = false;
let diagnostics = "";
let connecting = false;
let updateSettingsDirty = false;
let polling = false;
let expired = false;
let switching = false;
const reconnectMessage = '暂时无法连接本机适配器。请等待重连，或从托盘重新打开设置。';
let pendingAuthorization = 0;

function notify(text = '', error = false) {
  const notice = el('notice');
  notice.hidden = !text;
  notice.textContent = text;
  notice.dataset.kind = error ? 'error' : 'info';
}

async function request(path, options = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if ('body' in options) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    cache: 'no-store',
    body: 'body' in options ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      sessionStorage.removeItem(storageKey);
      expired = true;
      clearSecuritySecrets();
      el('panel').hidden = true;
    }
    const error = new Error(data.error || '请求未完成，请稍后重试');
    error.status = response.status;
    throw error;
  }
  return response;
}

window.__adapterManagementApi = request;

const post = (path, body = {}) => request(path, { method: 'POST', body });

function showPair(pair) {
  if (!el('pair-code')) return;
  el('pair-code').hidden = !pair;
  el('pair').textContent = pair ? '重新生成' : '生成配对码';
  if (pair) {
    el('pair-link').value = pair.link;
    const remaining = Math.max(0, pair.expiresAt - Date.now());
    el('pair-expiry').textContent = `剩余 ${Math.ceil(remaining / 1000)} 秒`;
  }
  if (pairLink === pair?.link) return;
  pairLink = pair?.link;
  const generation = ++qrRequest;
  if (qrUrl) URL.revokeObjectURL(qrUrl);
  qrUrl = undefined;
  el('qr').hidden = true;
  el('qr').removeAttribute('src');
  if (pair) {
    request('/api/pair-qr')
      .then((response) => response.blob())
      .then((blob) => {
        if (generation !== qrRequest) return;
        qrUrl = URL.createObjectURL(blob);
        el('qr').src = qrUrl;
        el('qr').hidden = false;
      })
      .catch(() => { /* The text link remains usable. */ });
  }
}

function render(state) {
  const ready = state.phase !== 'setup';
  const online = state.phase === 'online';
  el('panel').hidden = false;
  el('version').textContent = `v${state.version}`;
  const status = el('phase');
  const phase = phaseNames[state.phase] || '正在启动';
  if (status.textContent !== phase) status.textContent = phase;
  status.dataset.phase = state.phase;
  const account = state.account?.user ? state.account : null;
  const authorized = account?.state === 'signedIn';
  const revoked = account?.state === 'reauthorize';
  const paired = state.paired === true;
  el('adapter-account').hidden = !ready;
  el('adapter-account-name').textContent = account
    ? account.user.displayName || account.user.username
    : paired ? '已有配对' : '尚未授权';
  el('adapter-account-identity').hidden = !account;
  el('adapter-account-identity').textContent = account ? `@${account.user.username}` : '';
  if (authorized || paired) pendingAuthorization = 0;
  const accountLabel = authorized ? '已授权' : revoked ? '授权已撤销'
    : !paired && pendingAuthorization > Date.now() ? '等待网页确认' : '';
  const accountState = el('adapter-account-state');
  accountState.hidden = !accountLabel;
  if (accountState.textContent !== accountLabel) accountState.textContent = accountLabel;
  accountState.dataset.state = account?.state || '';
  el('authorize').hidden = !ready || authorized || paired;
  el('authorize').textContent = revoked ? '重新授权' : '授权电脑';
  el('bind-paired-account').hidden = !ready || !paired || authorized;
  el('workbench').className = ready ? 'button primary' : 'button';
  el('connect').hidden = ready;
  if (!ready && state.packageOrigin && !el('origin').defaultValue) {
    el('origin').defaultValue = state.packageOrigin;
    el('service-address').hidden = true;
    el('edit-origin').hidden = false;
  }
  el('connected').hidden = !ready;
  el('origin-value').textContent = state.origin || '';
  if (state.origin) el('workbench').href = state.origin;
  if (el('other-connection-methods')) el('other-connection-methods').hidden = ready && !online;
  if (el('legacy-enrollment')) el('legacy-enrollment').hidden = ready;
  if (el('pair-section')) el('pair-section').hidden = !online;
  el('check').disabled = !state.updateSettings || state.checking;
  el('check').textContent = state.checking ? '正在检查…' : '检查更新';
  el('install').hidden = !state.manualUpdate;
  el('update-state').textContent = state.update || (ready ? '正在读取更新设置…' : '连接服务后即可检查更新。');
  el('startup-form').hidden = state.startup === null;
  if (state.startup !== null && !el('startup').disabled) el('startup').checked = state.startup;
  el('update-form').hidden = !state.updateSettings;
  if (state.updateSettings && !updateSettingsDirty) {
    el('automatic').checked = state.updateSettings.autoUpdate;
    el('update-base').value = state.updateSettings.updateBaseURL || '';
  }
  el('history').textContent = state.history ? '可用' : '未就绪';
  el('agents').textContent = state.agents.length
    ? state.agents.map((agent) => `${agent.name}（${agent.connected ? '在线' : '离线'}）`).join('、')
    : '暂无';
  diagnostics = [
    `子虚亭适配器 v${state.version}`,
    `中继状态：${el('phase').textContent}`,
    `本机历史：${el('history').textContent}`,
    `受管 Agent：${el('agents').textContent}`,
    '设备通道：Noise 加密 · WebSocket',
  ].join('\n');
  showPair(online ? state.pairing : null);
  if (online && pairingAfterConnect) {
    pairingAfterConnect = false;
    post('/api/pair').catch((error) => notify(error.message, true));
  }
}

async function refresh() {
  if (polling || expired || switching || document.hidden) return;
  polling = true;
  try {
    const state = await (await request('/api/status')).json();
    if (el('panel').hidden || el('notice').textContent === reconnectMessage) {
      notify(state.setupError || '', Boolean(state.setupError));
    }
    render(state);
  } catch (error) {
    notify(expired ? error.message : reconnectMessage, true);
  } finally {
    polling = false;
  }
}

async function action(button, run) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await run();
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
  await refresh();
}

el('edit-origin').addEventListener('click', () => {
  el('edit-origin').hidden = true;
  el('service-address').hidden = false;
  el('origin').focus();
});
function startConnection(button, run) {
  if (connecting) return;
  connecting = true;
  action(button, run).finally(() => { connecting = false; });
}
function authorizeComputer(origin) {
  return post('/api/authorize', origin === undefined ? {} : { origin });
}
el('connect').addEventListener('submit', (event) => {
  event.preventDefault();
  startConnection(el('sign-in'), async () => {
    await authorizeComputer(el('origin').value.trim());
    pendingAuthorization = Date.now() + 5 * 60_000;
    notify();
  });
});
if (el('legacy-connect-form')) el('legacy-connect-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const origin = el('origin');
  if (!origin.reportValidity()) return;
  startConnection(el('legacy-connect'), async () => {
    await post('/api/connect', { origin: origin.value.trim(), enrollment: el('enrollment').value.trim() });
    el('enrollment').value = '';
    pairingAfterConnect = true;
    notify();
  });
});
for (const id of ['authorize', 'bind-paired-account']) {
  el(id).addEventListener('click', () => startConnection(el(id), async () => {
    await authorizeComputer();
    pendingAuthorization = Date.now() + 5 * 60_000;
    notify();
  }));
}
if (el('pair')) el('pair').addEventListener('click', () => action(el('pair'), async () => {
  await post('/api/pair');
  notify('正在生成配对码…');
  setTimeout(() => {
    if (el('notice').textContent === '正在生成配对码…') notify();
  }, 2500);
}));
if (el('copy')) el('copy').addEventListener('click', () => action(el('copy'), async () => {
  try {
    await navigator.clipboard.writeText(el('pair-link').value);
    notify('已复制配对链接');
  } catch {
    el('pair-link').focus();
    el('pair-link').select();
    notify('已选中配对链接，请使用浏览器的复制命令。');
  }
}));
el('check').addEventListener('click', () => action(el('check'), () => post('/api/update/check')));
el('install').addEventListener('click', () => action(el('install'), async () => {
  await post('/api/update/install');
  notify('当前操作完成后将更新并自动重新连接。');
}));
el('change').addEventListener('click', () => {
  if (!window.confirm('切换服务会暂时断开当前连接。继续后会打开新的连接设置页。')) return;
  action(el('change'), async () => {
    await post('/api/configure');
    switching = true;
    el('panel').hidden = true;
    notify('正在重新启动并打开连接设置…');
  });
});
el('copy-diagnostics').addEventListener('click', () => action(el('copy-diagnostics'), async () => {
  try {
    await navigator.clipboard.writeText(diagnostics);
    notify('已复制诊断信息');
  } catch {
    const text = el('diagnostics-text');
    text.value = diagnostics;
    text.hidden = false;
    text.focus();
    text.select();
    notify('已选中诊断信息，请使用浏览器的复制命令。');
  }
}));
el('quit').addEventListener('click', () => {
  if (!window.confirm('退出适配器会断开当前设备连接。确定退出？')) return;
  action(el('quit'), async () => {
    await post('/api/quit');
    switching = true;
    el('panel').hidden = true;
    notify('适配器已退出。可从系统的应用菜单重新启动。');
  });
});
el('startup').addEventListener('change', () => action(el('startup'), async () => {
  await post('/api/startup', { enabled: el('startup').checked });
  notify('已保存登录自启动设置');
}));
el('update-form').addEventListener('input', () => { updateSettingsDirty = true; });
el('update-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action(event.submitter || el('update-form').querySelector('button'), async () => {
    await post('/api/update/settings', { automatic: el('automatic').checked, base: el('update-base').value });
    updateSettingsDirty = false;
    notify('已保存更新设置');
  });
});

async function start() {
  const ticket = location.hash.slice(1);
  if (ticket) {
    history.replaceState(null, '', location.pathname);
    const session = await (await post('/api/session', ticket)).json();
    token = session.token;
    sessionStorage.setItem(storageKey, token);
  }
  if (!token) throw new Error('请从适配器托盘菜单重新打开设置。');
  await refresh();
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 2000);
}

start().catch((error) => notify(error.message, true));

// Codes are generated locally while this view is visible. Recovery remains an explicit reveal.
let currentTab = 'connection';
let securityState;
let selectedSecurityKey = '';
let securityLoading = false;
let securityGeneration = 0;
let securityCode = '';
let securityCodeExpiry = 0;
let securityRecovery = '';
let codeLoading = false;
let pendingSecurityAction;
let codeHidden = false;
let pendingRemovalKey = '';
let removalBusy = false;

function securityNotify(text = '', error = false, target = 'security-notice') {
  const notice = el(target);
  notice.textContent = text;
  notice.hidden = !text;
  notice.dataset.error = String(error);
}
function selectedSecurityAccount() {
  return securityState?.accounts.find((entry) => entry.key === selectedSecurityKey);
}
function clearSecuritySecrets() {
  securityGeneration++;
  closeManagementForms();
  securityCode = '';
  securityCodeExpiry = 0;
  securityRecovery = '';
  codeLoading = false;
  el('offline-code').textContent = '••• •••';
  el('offline-code').className = 'secret-mask';
  el('offline-code').removeAttribute('data-visible');
  el('offline-code').setAttribute('aria-label', '动态码已隐藏');
  el('offline-recovery').textContent = '••••••••';
  el('offline-recovery').setAttribute('aria-label', '恢复码已隐藏');
  el('offline-recovery').closest('section').removeAttribute('data-visible');
  el('view-code').textContent = '查看';
  el('view-code').disabled = false;
  el('view-code').setAttribute('aria-label', '查看动态码');
  el('view-recovery').textContent = '查看';
  el('view-recovery').disabled = !selectedSecurityAccount()?.recoveryBackedUp;
  el('view-recovery').setAttribute('aria-label', '查看恢复码');
  el('copy-code').hidden = true;
  el('copy-recovery').hidden = true;
  el('offline-timer').hidden = true;
}
function resetPassphraseForm() {
  el('backup-passphrase-form').reset();
  for (const button of document.querySelectorAll('.passphrase-visibility')) {
    el(button.dataset.input).type = 'password';
    button.querySelector('use').setAttribute('href', '#icon-eye');
    button.setAttribute('aria-label', button.dataset.input === 'backup-passphrase' ? '显示本地秘钥簿口令' : '显示再次输入的口令');
  }
  securityNotify('', false, 'passphrase-notice');
}
function closeProtectionForm() {
  resetPassphraseForm();
  pendingSecurityAction = undefined;
  el('security-main').hidden = false;
  el('security-protection-form').hidden = true;
}
function selectManagementTab(name, focus = false) {
  if (currentTab !== name) {
    clearSecuritySecrets();
    closeProtectionForm();
    el('backup-management').hidden = true;
    codeHidden = false;
  }
  currentTab = name;
  for (const tab of ['connection', 'plugins', 'security', 'runtime']) {
    const selected = tab === name;
    el(`tab-${tab}`).setAttribute('aria-selected', String(selected));
    el(`tab-${tab}`).tabIndex = selected ? 0 : -1;
    el(`${tab}-view`).hidden = !selected;
  }
  if (focus) el(`tab-${name}`).focus();
  if (name === 'security') void refreshSecurity();
  if (name === 'plugins' && window.__refreshAdapterPlugins) void window.__refreshAdapterPlugins();
}
for (const name of ['connection', 'plugins', 'security', 'runtime']) {
  el(`tab-${name}`).addEventListener('click', () => selectManagementTab(name));
}
el('panel').querySelector('[role="tablist"]').addEventListener('keydown', (event) => {
  const names = ['connection', 'plugins', 'security', 'runtime'];
  let next;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = names[(names.indexOf(currentTab) + 1) % names.length];
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = names[(names.indexOf(currentTab) + names.length - 1) % names.length];
  if (event.key === 'Home') next = names[0];
  if (event.key === 'End') next = names[names.length - 1];
  if (next) { event.preventDefault(); selectManagementTab(next, true); }
});
function renderSecurity() {
  const accounts = securityState.accounts;
  const prior = selectedSecurityAccount();
  if (!prior) selectedSecurityKey = accounts[0]?.key || '';
  const entry = selectedSecurityAccount();
  const selector = el('security-account');
  const identity = JSON.stringify(accounts.map(({ key, account, origin }) => [key, account, origin]));
  if (selector.dataset.entries !== identity) {
    selector.replaceChildren(...accounts.map((item) => {
      const option = document.createElement('option');
      option.value = item.key;
      option.textContent = `${item.account.displayName || item.account.username} · UID ${item.account.id} · ${serviceDomain(item.origin)}`;
      return option;
    }));
    selector.dataset.entries = identity;
  }
  selector.value = selectedSecurityKey;
  el('security-selector').hidden = accounts.length < 2;
  el('security-empty').hidden = Boolean(entry);
  el('security-account-content').hidden = !entry;
  const password = securityState.protection === 'passphrase';
  el('manage-backup').hidden = !entry && !password;
  el('managed-account').hidden = !entry;
  el('keybook-account-actions').hidden = !entry;
  el('legacy-protection-actions').hidden = !password;
  if (!entry && !password) el('backup-management').hidden = true;
  el('security-empty-description').textContent = password
    ? '此秘钥簿保留了旧版额外口令。解锁后同步账号，也可在管理中取消额外口令。'
    : '同步已登录的子虚亭账号，即可在本机查看动态码。凭据会自动加密保存，无需另设口令。';
  el('unlock-keybook').hidden = !password || !securityState.locked;
  el('lock-backup').disabled = securityState.locked;
  el('lock-backup').textContent = securityState.locked ? '秘钥簿已锁定' : '锁定秘钥簿';
  el('security-protection-detail').textContent = password
    ? '此秘钥簿保留了旧版的额外口令。解锁后可取消，凭据仍会在本机加密保存。'
    : securityState.protection === 'system'
      ? '凭据由系统安全存储保护，无需另设口令。'
      : '凭据已在此设备加密保存，无需另设口令。';
  if (!entry) { el('recovery-source').hidden = true; return; }
  el('security-name').textContent = entry.account.displayName || entry.account.username || '账号';
  el('security-identity').textContent = `@${entry.account.username} · UID ${entry.account.id}`;
  el('security-origin').textContent = serviceDomain(entry.origin);
  el('security-origin').title = entry.origin;
  el('security-protection-label').textContent = securityState.protection === 'system' ? '系统安全存储' : password ? '旧版额外口令' : '本机加密保存';
  const identityText = `${entry.account.displayName || entry.account.username} · UID ${entry.account.id}`;
  el('managed-account').textContent = identityText;
  el('recovery-editor-account').textContent = identityText;
  el('recovery-source').hidden = !entry.recoveryBackedUp;
  el('recovery-source').textContent = entry.recoverySource === 'manual' ? '恢复码来源：本机手动保存。' : '恢复码来源：账号同步。';
  el('edit-recovery').textContent = entry.recoveryBackedUp ? '替换恢复码' : '补充恢复码';
  const hasTotp = entry.hasTotp !== false;
  if (el('offline-code-row')) el('offline-code-row').hidden = !hasTotp;
  if (el('offline-code-help')) el('offline-code-help').hidden = !hasTotp;
  if (hasTotp && password && securityState.locked) {
    el('offline-code').textContent = '已锁定';
    el('view-code').textContent = '解锁';
    el('view-code').setAttribute('aria-label', '解锁并查看动态码');
  }
  el('view-recovery').disabled = !entry.recoveryBackedUp;
  if (!entry.recoveryBackedUp) {
    el('offline-recovery').textContent = '尚未保存';
    el('offline-recovery').setAttribute('aria-label', '尚未保存恢复码');
  }
  const updated = new Date(entry.updatedAt);
  el('security-updated').textContent = Number.isFinite(updated.getTime()) ? updated.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
  if (Number.isFinite(updated.getTime())) el('security-updated').dateTime = updated.toISOString();
}
function serviceDomain(origin) {
  try { return new URL(origin).host; } catch { return origin || '未知服务'; }
}
async function refreshSecurity() {
  if (securityLoading || expired || !token || document.hidden || currentTab !== 'security') return;
  securityLoading = true;
  try {
    const state = await (await request('/api/security')).json();
    if (currentTab !== 'security') return;
    const old = selectedSecurityAccount();
    const next = state.accounts.find((item) => item.key === selectedSecurityKey);
    if (old && (!next || old.revision !== next.revision || old.updatedAt !== next.updatedAt)) clearSecuritySecrets();
    if (state.locked && securityState && !securityState.locked) clearSecuritySecrets();
    securityState = state;
    renderSecurity();
    maybeShowSecurityCode();
  } catch (error) {
    if (!expired) securityNotify(error.message, true);
  } finally {
    securityLoading = false;
  }
}
el('security-account').addEventListener('change', () => {
  clearSecuritySecrets();
  closeProtectionForm();
  selectedSecurityKey = el('security-account').value;
  codeHidden = false;
  el('backup-management').hidden = true;
  securityNotify();
  renderSecurity();
  maybeShowSecurityCode();
});
function showProtectionForm(action) {
  clearSecuritySecrets();
  resetPassphraseForm();
  pendingSecurityAction = action;
  el('save-passphrase').textContent = action === 'code' || action === 'recovery' ? '解锁并查看' : '解锁并继续';
  const entry = selectedSecurityAccount();
  el('protection-account').hidden = !entry;
  if (entry) {
    el('protection-account-name').textContent = entry.account.displayName || entry.account.username;
    el('protection-account-id').textContent = `@${entry.account.username} · UID ${entry.account.id}`;
  }
  el('security-main').hidden = true;
  el('security-protection-form').hidden = false;
  el('backup-passphrase').focus();
}
async function ensureSecurityUnlocked(action) {
  const entry = selectedSecurityAccount();
  if (!securityState || (!entry && action !== 'automatic' && action !== 'unlock') || document.hidden || currentTab !== 'security') return false;
  if (!securityState.locked) return true;
  const generation = securityGeneration;
  const key = selectedSecurityKey;
  if (securityState.protection === 'passphrase') { showProtectionForm(action); return false; }
  try { await post('/api/security/unlock'); }
  catch (error) { if (generation === securityGeneration) securityNotify(error.message, true); return false; }
  if (generation !== securityGeneration || key !== selectedSecurityKey || currentTab !== 'security' || document.hidden) {
    return false;
  }
  securityState.locked = false;
  renderSecurity();
  return true;
}
function maybeShowSecurityCode() {
  const entry = selectedSecurityAccount();
  if (!entry || entry.hasTotp === false || codeHidden || codeLoading || securityCode || document.hidden
    || currentTab !== 'security' || el('security-main').hidden || !el('manual-recovery-form').hidden
    || el('remove-entry-dialog').open || (securityState.protection === 'passphrase' && securityState.locked)) return;
  void revealSecurity('code');
}
async function revealSecurity(kind, unlocked = false) {
  const entry = selectedSecurityAccount();
  if (!entry || document.hidden || currentTab !== 'security') return;
  securityNotify();
  if (!unlocked && !await ensureSecurityUnlocked(kind)) return;
  const generation = securityGeneration;
  const key = entry.key;
  const button = el(kind === 'code' ? 'view-code' : 'view-recovery');
  button.disabled = true;
  if (kind === 'code') codeLoading = true;
  try {
    const result = await (await post(`/api/security/${kind}`, { key })).json();
    if (generation !== securityGeneration || key !== selectedSecurityKey || currentTab !== 'security' || document.hidden) return;
    if (kind === 'code') {
      if (!/^\d{6}$/.test(result.code) || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw Error('动态码正在更新，请再次查看');
      securityCode = result.code;
      securityCodeExpiry = result.expiresAt;
      el('offline-code').textContent = `${securityCode.slice(0, 3)} ${securityCode.slice(3)}`;
      el('offline-code').dataset.visible = 'true';
      el('offline-code').removeAttribute('aria-label');
      el('offline-timer').hidden = false;
      el('view-code').textContent = '隐藏';
      el('view-code').setAttribute('aria-label', '隐藏动态码');
      el('copy-code').hidden = false;
      tickSecurityCode();
    } else {
      if (!result.recoveryCode || typeof result.recoveryCode !== 'string') throw Error('此账号尚未保存恢复码');
      securityRecovery = result.recoveryCode;
      el('offline-recovery').textContent = securityRecovery;
      el('offline-recovery').removeAttribute('aria-label');
      el('offline-recovery').closest('section').dataset.visible = 'true';
      el('view-recovery').textContent = '隐藏';
      el('view-recovery').setAttribute('aria-label', '隐藏恢复码');
      el('copy-recovery').hidden = false;
    }
  } catch (error) {
    if (generation !== securityGeneration) return;
    clearSecuritySecrets();
    codeHidden = true;
    if (error.status === 423) {
      securityState.locked = true;
      renderSecurity();
      if (securityState.protection === 'passphrase') showProtectionForm(kind);
      else securityNotify('秘钥簿已锁定，请重新查看。');
    } else securityNotify(error.message, true);
  } finally {
    if (generation === securityGeneration) {
      button.disabled = kind === 'recovery' && !selectedSecurityAccount()?.recoveryBackedUp;
      codeLoading = false;
    }
  }
}
function tickSecurityCode() {
  if (!securityCode || currentTab !== 'security' || document.hidden) return;
  const seconds = Math.max(0, Math.ceil((securityCodeExpiry - Date.now()) / 1000));
  el('offline-seconds').textContent = String(seconds);
  el('offline-timer').setAttribute('aria-label', `${seconds} 秒后更新`);
  el('offline-timer-ring').setAttribute('stroke-dashoffset', String(100 - Math.min(30, seconds) / 30 * 100));
  if (!seconds && !codeLoading) {
    securityCode = '';
    el('offline-code').textContent = '更新中';
    el('copy-code').hidden = true;
    void revealSecurity('code', true);
  }
}
setInterval(tickSecurityCode, 1000);
setInterval(() => { if (!el('security-main').hidden) void refreshSecurity(); }, 5000);
el('view-code').addEventListener('click', () => {
  if (securityCode) { codeHidden = true; clearSecuritySecrets(); return; }
  codeHidden = false;
  void revealSecurity('code');
});
el('view-recovery').addEventListener('click', () => {
  if (securityRecovery) { clearSecuritySecrets(); renderSecurity(); return; }
  void revealSecurity('recovery');
});
async function copySecuritySecret(kind) {
  const value = kind === 'code' ? securityCode : securityRecovery;
  if (!value) return;
  try { await navigator.clipboard.writeText(value); securityNotify(kind === 'code' ? '已复制动态码' : '已复制恢复码'); }
  catch {
    const range = document.createRange();
    range.selectNodeContents(el(kind === 'code' ? 'offline-code' : 'offline-recovery'));
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    securityNotify('已选中，请使用浏览器的复制命令。');
  }
}
el('copy-code').addEventListener('click', () => void copySecuritySecret('code'));
el('copy-recovery').addEventListener('click', () => void copySecuritySecret('recovery'));
el('manage-backup').addEventListener('click', () => {
  closeManagementForms();
  el('backup-management').hidden = !el('backup-management').hidden;
});
async function syncKeybook(button) {
  if (connecting || button.disabled) return;
  if (securityState?.protection === 'passphrase' && securityState.locked) { showProtectionForm('sync'); return; }
  connecting = true;
  button.disabled = true;
  try {
    await authorizeComputer(el('connect').hidden ? undefined : el('origin').value.trim());
    securityNotify('已打开网页。使用对应账号登录后，将自动更新本机备份。');
  } catch (error) { securityNotify(error.message, true); }
  finally { connecting = false; button.disabled = false; await refresh(); }
}
for (const id of ['sync-keybook', 'sync-keybook-again']) el(id).addEventListener('click', () => void syncKeybook(el(id)));
el('unlock-keybook').addEventListener('click', () => { showProtectionForm('unlock'); });
async function useAutomaticProtection(unlocked = false) {
  if (!unlocked && !await ensureSecurityUnlocked('automatic')) return;
  const button = el('automatic-backup');
  if (button.disabled) return;
  button.disabled = true;
  try {
    await post('/api/security/automatic');
    clearSecuritySecrets();
    codeHidden = false;
    await refreshSecurity();
    securityNotify('已取消额外口令，凭据仍在本机加密保存。');
  } catch (error) { securityNotify(error.message, true); }
  finally { button.disabled = false; }
}
el('automatic-backup').addEventListener('click', () => void useAutomaticProtection());
el('lock-backup').addEventListener('click', async () => {
  clearSecuritySecrets();
  try {
    await post('/api/security/lock');
    if (securityState) { securityState.locked = true; renderSecurity(); }
    await refreshSecurity();
    securityNotify('秘钥簿已锁定');
  }
  catch (error) { securityNotify(error.message, true); }
});
for (const id of ['protection-back', 'cancel-passphrase']) el(id).addEventListener('click', closeProtectionForm);
for (const button of document.querySelectorAll('.passphrase-visibility')) button.addEventListener('click', () => {
  const input = el(button.dataset.input);
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  button.querySelector('use').setAttribute('href', visible ? '#icon-eye-off' : '#icon-eye');
  button.setAttribute('aria-label', `${visible ? '隐藏' : '显示'}${button.dataset.input === 'backup-passphrase' ? '本地秘钥簿口令' : '再次输入的口令'}`);
});
el('backup-passphrase-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = el('save-passphrase');
  if (button.disabled) return;
  const passphrase = el('backup-passphrase').value;
  const kind = pendingSecurityAction;
  const generation = securityGeneration;
  button.disabled = true;
  try {
    await post('/api/security/unlock', { passphrase });
    if (generation !== securityGeneration || currentTab !== 'security' || document.hidden) return;
    closeProtectionForm();
    await refreshSecurity();
    securityNotify('秘钥簿已解锁');
    if (kind === 'automatic') await useAutomaticProtection(true);
    else if (kind === 'sync') await syncKeybook(el(selectedSecurityAccount() ? 'sync-keybook-again' : 'sync-keybook'));
    else if (kind === 'edit-recovery') showRecoveryEditor();
    else if (kind === 'remove') showRemovalConfirmation();
    else if (kind === 'code' || kind === 'recovery') await revealSecurity(kind, true);
  } catch (error) { if (generation === securityGeneration) securityNotify(error.message, true, 'passphrase-notice'); }
  finally { button.disabled = false; }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { if (currentTab === 'security') void refreshSecurity(); return; }
  clearSecuritySecrets();
  codeHidden = false;
  closeProtectionForm();
});
window.addEventListener('pagehide', () => { clearSecuritySecrets(); resetPassphraseForm(); });
clearSecuritySecrets();


function resetRecoveryInput() {
  el('manual-recovery-form').reset();
  el('manual-recovery').type = 'password';
  el('show-manual-recovery').querySelector('use').setAttribute('href', '#icon-eye');
  el('show-manual-recovery').setAttribute('aria-label', '显示输入的恢复码');
  securityNotify('', false, 'manual-recovery-notice');
}
function closeManagementForms() {
  resetRecoveryInput();
  el('manual-recovery-form').hidden = true;
  if (el('remove-entry-dialog').open) el('remove-entry-dialog').close();
  pendingRemovalKey = '';
}
function showRecoveryEditor() {
  closeManagementForms();
  clearSecuritySecrets();
  el('backup-management').hidden = false;
  el('manual-recovery-form').hidden = false;
  el('manual-recovery').focus();
}
el('edit-recovery').addEventListener('click', async () => {
  if (await ensureSecurityUnlocked('edit-recovery')) showRecoveryEditor();
});
el('cancel-manual-recovery').addEventListener('click', closeManagementForms);
el('show-manual-recovery').addEventListener('click', () => {
  const input = el('manual-recovery');
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  el('show-manual-recovery').querySelector('use').setAttribute('href', visible ? '#icon-eye-off' : '#icon-eye');
  el('show-manual-recovery').setAttribute('aria-label', visible ? '隐藏输入的恢复码' : '显示输入的恢复码');
});
el('manual-recovery-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = el('save-manual-recovery');
  const entry = selectedSecurityAccount();
  if (button.disabled || !entry || currentTab !== 'security' || document.hidden) return;
  const recoveryCode = el('manual-recovery').value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(recoveryCode)) {
    securityNotify('请输入完整的账号恢复码，保留末尾的 = 号。', true, 'manual-recovery-notice');
    return;
  }
  const generation = securityGeneration;
  const key = entry.key;
  button.disabled = true;
  try {
    await post('/api/security/recovery', { key, recoveryCode });
    if (generation !== securityGeneration || key !== selectedSecurityKey || document.hidden) return;
    resetRecoveryInput();
    el('manual-recovery-form').hidden = true;
    clearSecuritySecrets();
    await refreshSecurity();
    securityNotify('恢复码已手动保存到此设备。');
  } catch (error) {
    if (generation === securityGeneration) securityNotify(error.message, true, 'manual-recovery-notice');
  } finally { button.disabled = false; }
});
function showRemovalConfirmation() {
  const entry = selectedSecurityAccount();
  if (!entry) return;
  clearSecuritySecrets();
  pendingRemovalKey = entry.key;
  el('remove-entry-account').textContent = `${entry.account.displayName || entry.account.username} · UID ${entry.account.id}`;
  securityNotify('', false, 'remove-entry-notice');
  el('remove-entry-dialog').showModal();
}
el('remove-entry').addEventListener('click', async () => {
  if (await ensureSecurityUnlocked('remove')) showRemovalConfirmation();
});
el('cancel-remove-entry').addEventListener('click', () => el('remove-entry-dialog').close());
el('remove-entry-dialog').addEventListener('cancel', (event) => { if (removalBusy) event.preventDefault(); });
el('remove-entry-dialog').addEventListener('close', () => { pendingRemovalKey = ''; });
el('confirm-remove-entry').addEventListener('click', async () => {
  const key = pendingRemovalKey;
  if (!key || key !== selectedSecurityKey || removalBusy) return;
  removalBusy = true;
  el('confirm-remove-entry').disabled = true;
  el('cancel-remove-entry').disabled = true;
  try {
    await post('/api/security/remove', { key });
    clearSecuritySecrets();
    securityState.accounts = securityState.accounts.filter((entry) => entry.key !== key);
    selectedSecurityKey = securityState.accounts[0]?.key || '';
    renderSecurity();
    await refreshSecurity();
    securityNotify('已移除此设备上的条目，账号与其他设备不受影响。');
  } catch (error) { securityNotify(error.message, true, 'remove-entry-notice'); }
  finally {
    removalBusy = false;
    el('confirm-remove-entry').disabled = false;
    el('cancel-remove-entry').disabled = false;
  }
});
