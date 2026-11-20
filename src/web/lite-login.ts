import type { AccountClient, QrLoginHandle } from '../client/account';
import { deviceLoginMatchCode } from '../shared/trusted-device-crypto';
import { account } from './messaging/account-transport';
import { decodeQrImage, qrDecoder } from './lite-login-decoder';
import {
  InvitationAtAnotherSite,
  parseQrInvitationUrl,
  qrLoginUrl,
  switchAndroidLoginSite,
} from './lite-login-invitation';

const deviceName = /\bFablePavilionAndroid\//.test(navigator.userAgent) ? 'Android 手机' : '当前浏览器';

function message(text: string, role?: 'alert' | 'status') {
  const element = document.createElement('p');
  element.textContent = text;
  if (role) element.setAttribute('role', role);
  return element;
}

function button(label: string, click: () => void, primary = false) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = primary ? 'lite-primary' : 'lite-secondary';
  element.textContent = label;
  element.addEventListener('click', click);
  return element;
}

/** Mount the existing trusted-device protocol into the HTML entry for constrained connections. */
export function installLiteQr(root: HTMLElement, openApp: (account?: AccountClient) => void) {
  const panel = root.querySelector<HTMLElement>('[data-lite-action]')!;
  let operation: AbortController | undefined;

  function clear() {
    operation?.abort();
    operation = undefined;
    panel.replaceChildren();
  }

  function begin() {
    clear();
    operation = new AbortController();
    return operation.signal;
  }

  function dispose() {
    clear();
  }

  function failed(signal: AbortSignal, error: unknown) {
    if (signal.aborted) return;
    clear();
    panel.append(message(error instanceof Error ? error.message : '登录请求暂不可用，请重试。', 'alert'));
  }

  function startPolling(handle: QrLoginHandle, signal: AbortSignal, status: HTMLElement) {
    let retry: ReturnType<typeof setTimeout>;
    signal.addEventListener('abort', () => clearTimeout(retry), { once: true });
    async function poll() {
      try {
        const result = await account.checkQrLogin(handle, location.origin, signal, { refreshItems: false });
        if (signal.aborted) return;
        if ('pending' in result) retry = setTimeout(poll, 2500);
        else {
          dispose();
          const url = new URL(location.href);
          if (url.searchParams.get('page') === 'login-invite') {
            url.searchParams.delete('page');
            history.replaceState(history.state, '', url);
          }
          panel.append(message('已登录，正在打开应用…', 'status'));
          openApp(account);
        }
      } catch (error) {
        failed(signal, error);
      }
    }
    status.textContent = '正在等待已登录设备确认…';
    void poll();
  }

  async function showApproval(handle: QrLoginHandle, signal: AbortSignal, image?: HTMLImageElement) {
    const code = handle.deviceBound
      ? await deviceLoginMatchCode(handle.id, handle.key.publicKey)
      : handle.id.slice(0, 6).toUpperCase();
    if (signal.aborted) return;
    const expiresIn = handle.expiresAt - Date.now();
    if (expiresIn <= 0) throw new Error('二维码已过期，请重新生成。');
    const expiry = setTimeout(() => failed(signal, new Error('二维码已过期，请重新生成。')), expiresIn);
    signal.addEventListener('abort', () => clearTimeout(expiry), { once: true });
    const value = document.createElement('strong');
    value.textContent = code;
    value.className = 'lite-match-code';
    value.translate = false;
    const status = message('请核对两台设备上显示的代码。', 'status');
    panel.replaceChildren();
    if (image) {
      panel.append(message('用已登录设备扫描下方二维码，核对代码后在那台设备上确认。'), image);
      panel.append(value, status, button('取消', clear));
      startPolling(handle, signal, status);
    } else {
      const confirm = button(
        '代码一致，确认登录',
        () => {
          confirm.disabled = true;
          startPolling(handle, signal, status);
        },
        true,
      );
      panel.append(status, value, confirm, button('取消', clear));
    }
  }

  async function claim(text: string) {
    const signal = begin();
    try {
      const { id, secret } = parseQrInvitationUrl(text);
      if (text === location.href && location.hash)
        history.replaceState(history.state, '', location.pathname + location.search);
      panel.append(message('正在读取登录请求…', 'status'), button('取消', clear));
      const handle = await account.claimQrInvitation(id, secret, deviceName, signal);
      await showApproval(handle, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof InvitationAtAnotherSite) {
        if (switchAndroidLoginSite(error.url)) return;
        const link = document.createElement('a');
        link.href = error.url.href;
        link.referrerPolicy = 'no-referrer';
        link.textContent = `在 ${error.url.hostname} 继续`;
        panel.append(message(error.message), link, button('返回', clear));
      } else failed(signal, error);
    }
  }

  function pastedLink() {
    const form = document.createElement('form');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'url';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.required = true;
    input.maxLength = 800;
    label.append('登录邀请链接', input);
    const submit = button('读取登录邀请', () => {});
    submit.type = 'submit';
    form.append(label, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void claim(input.value);
    });
    return form;
  }

  async function camera() {
    const signal = begin();
    const status = message('正在打开相机…', 'status');
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.hidden = true;
    video.setAttribute('aria-label', '邀请扫码相机');
    panel.append(status, video, button('关闭相机', clear), pastedLink());
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error('此浏览器无法打开相机，请从相册导入二维码或粘贴邀请链接。');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      const stopStream = () => stream.getTracks().forEach((track) => track.stop());
      if (signal.aborted) return stopStream();
      signal.addEventListener('abort', stopStream, { once: true });
      document.addEventListener(
        'visibilitychange',
        () => {
          if (document.visibilityState === 'hidden') clear();
        },
        { signal },
      );
      video.srcObject = stream;
      video.hidden = false;
      status.textContent = '正在准备二维码识别…';
      const [, detect] = await Promise.all([video.play(), qrDecoder()]);
      if (signal.aborted) return;
      status.textContent = '请对准已登录设备上的登录邀请二维码。';
      let timer: ReturnType<typeof setTimeout>;
      signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
      const scan = async () => {
        try {
          const text = video.videoWidth ? await detect(video) : undefined;
          if (signal.aborted) return;
          if (text) void claim(text);
          else timer = setTimeout(scan, 180);
        } catch (error) {
          failed(signal, error);
        }
      };
      void scan();
    } catch (error) {
      if (signal.aborted) return;
      failed(
        signal,
        error instanceof DOMException ? new Error('无法使用相机，请检查权限或从相册导入二维码。') : error,
      );
      panel.append(pastedLink());
    }
  }

  async function image(file: File) {
    const signal = begin();
    panel.append(message('正在识别二维码图片…', 'status'), button('取消', clear));
    try {
      const text = await decodeQrImage(file, () => !signal.aborted);
      if (signal.aborted) return;
      if (!text) throw new Error('图片中未找到二维码。');
      void claim(text);
    } catch (error) {
      failed(signal, error);
    }
  }

  async function localCode() {
    const signal = begin();
    panel.append(message('正在生成登录二维码…', 'status'), button('取消', clear));
    try {
      // Download the encoder before asking the relay to start the login expiration clock.
      const { default: encoder } = await import('qrcode');
      if (signal.aborted) return;
      const handle = await account.startQrLogin(undefined, deviceName, signal);
      if (signal.aborted) return;
      const qr = document.createElement('img');
      qr.width = qr.height = 240;
      qr.alt = '可信设备扫码登录二维码';
      qr.src = await encoder.toDataURL(await qrLoginUrl(handle), { width: 240, margin: 4 });
      await showApproval(handle, signal, qr);
    } catch (error) {
      failed(signal, error);
    }
  }

  if (new URLSearchParams(location.search).get('page') === 'login-invite' && location.hash)
    void claim(location.href);
  return { camera, image, localCode, dispose };
}
