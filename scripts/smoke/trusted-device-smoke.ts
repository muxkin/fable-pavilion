/** Isolated Chromium fixture. The virtual authenticator and accounts are disposable. */
import assert from 'node:assert/strict';
import { chromium, expect, type Locator, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { saveRecoveryCode } from '../lib/messaging-smoke.js';

process.env.TEST_BIND ??= 'localhost';
const { config, close } = await import('./v2-fixture.js');
const browser = await chromium.launch({ channel: 'chrome' });
const origin = config.origin;
const username = 'trusted_login_smoke';
const password = 'synthetic-only-trusted-device-password';
const security = `${origin}/?page=login-security`;
const devices = `${origin}/?page=trusted-devices`;
const messages = `${origin}/?page=messages`;
const endpoint = (suffix: string) => `${origin}/api/im${suffix}`;
const errors: string[] = [];
const originHeaders = { Origin: origin };

async function readQr(image: Locator) {
  await expect(image).toBeVisible();
  const source = await image.getAttribute('src');
  assert(source && source.startsWith('data:image/png;base64,'));
  const bitmap = await image.evaluate(async (node: HTMLImageElement) => {
    await node.decode();
    const canvas = document.createElement('canvas');
    canvas.width = node.naturalWidth;
    canvas.height = node.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(node, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
    };
  });
  const result = jsQR(new Uint8ClampedArray(bitmap.pixels), bitmap.width, bitmap.height);
  assert(result);
  return {
    data: result.data,
    file: { name: 'login.png', mimeType: 'image/png', buffer: Buffer.from(source.split(',')[1], 'base64') },
  };
}

async function requireAccount(page: Page) {
  await expect
    .poll(async () => {
      const result = await page.request.get(endpoint('/me'));
      return result.ok() ? (await result.json()).user?.username : undefined;
    })
    .toBe(username);
}

/** Read the real code only from the legitimate first registration session, never a pending login. */
async function readRegisteredSessionCode(registered: Page) {
  await requireAccount(registered);
  assert((await registered.context().cookies()).some((cookie) => cookie.name === 'pocket_im_session'));
  const response = await registered.request.post(endpoint('/crypto/totp/display'), {
    headers: originHeaders,
    data: {},
  });
  assert.equal(response.status(), 200);
  const result = (await response.json()) as { code: string; expiresAt: number };
  assert.match(result.code, /^\d{6}$/);
  assert.equal(result.expiresAt % 30_000, 0);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'expiresAt']);
  return result;
}

async function savedRoot(page: Page) {
  return page.evaluate<string | undefined>(`(async () => {
    const { user } = await (await fetch('/api/im/me')).json();
    if (!user) return;
    const name = 'pocket-account-v1';
    if (!(await indexedDB.databases()).some((entry) => entry.name === name)) return;
    const result = (request) =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const database = await result(indexedDB.open(name));
    try {
      if (!database.objectStoreNames.contains('device-keys')) return;
      const tx = database.transaction(['unlocked', 'device-keys'], 'readonly');
      const [saved, key] = await Promise.all([
        result(tx.objectStore('unlocked').get(user.id)),
        result(tx.objectStore('device-keys').get(user.id)),
      ]);
      if (!saved || !key) return;
      const clear = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: saved.sealed.iv,
          additionalData: new TextEncoder().encode(
            JSON.stringify(['pocket-device-session-v1', location.origin, user.id, saved.revision]),
          ),
        },
        key,
        saved.sealed.data,
      );
      return JSON.parse(new TextDecoder().decode(clear)).root;
    } finally {
      database.close();
    }
  })()`);
}

try {
  const trusted = await browser.newPage();
  const passwordContext = await browser.newContext();
  const passwordDevice = await passwordContext.newPage();
  const qrDevice = await browser.newPage();
  const invitedDevice = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const anonymous = await browser.newContext();
  await trusted.addInitScript(`
    Reflect.deleteProperty(URLSearchParams.prototype, 'size');
    Object.defineProperty(window, 'createImageBitmap', { configurable: true, value: undefined });
    Object.defineProperty(window, 'BarcodeDetector', { configurable: true, value: undefined });
  `);
  await invitedDevice.addInitScript(`
    Reflect.deleteProperty(URLSearchParams.prototype, 'size');
    Object.defineProperty(window, 'createImageBitmap', {
      configurable: true, value: () => Promise.reject(new Error('ImageBitmap unavailable')),
    });
    Object.defineProperty(window, 'BarcodeDetector', {
      configurable: true, value: class { async detect() { return []; } },
    });
  `);
  for (const page of [trusted, passwordDevice, qrDevice, invitedDevice])
    page.on('pageerror', (error) => errors.push(error.message));
  await trusted.goto(messages);
  await trusted.getByRole('button', { name: '创建账号', exact: true }).click();
  await trusted.getByLabel('昵称').fill('登录验收账号');
  await trusted.getByLabel('用户名', { exact: true }).fill(username);
  await trusted.getByLabel('密码', { exact: true }).fill(password);
  await trusted.getByRole('button', { name: '创建账户', exact: true }).click();
  await saveRecoveryCode(trusted);
  await trusted.bringToFront();
  await trusted.goto(`${security}&security-action=code`);
  const defaultState = await (await trusted.request.get(endpoint('/crypto/trusted'))).json();
  assert(defaultState.required && defaultState.totpEnabled);
  assert.equal(defaultState.devices.length, 0);
  const initialCode = await readRegisteredSessionCode(trusted);
  await expect(trusted.getByRole('region', { name: '登录动态码' })).toContainText(
    new RegExp(`${initialCode.code.slice(0, 3)}\\s*${initialCode.code.slice(3)}`),
  );

  await passwordDevice.goto(messages);
  await passwordDevice.getByRole('button', { name: '使用账号密码', exact: true }).click();
  await expect(passwordDevice.getByRole('button', { name: '使用账号密码', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await passwordDevice.getByLabel('UID 或用户名').fill(username);
  await passwordDevice.getByLabel('密码', { exact: true }).fill(password);
  const passwordResponse = passwordDevice.waitForResponse(
    (response) => response.url().endsWith('/crypto/login') && response.request().method() === 'POST',
  );
  await passwordDevice.getByRole('button', { name: '登录账户' }).click();
  const passwordCheck = await passwordResponse;
  const passwordInput = passwordCheck.request().postDataJSON();
  const pending = await passwordCheck.json();
  assert(pending.trustedLogin && !pending.vault);
  assert(!(await passwordDevice.context().cookies()).some((cookie) => cookie.name === 'pocket_im_session'));
  const { code } = await readRegisteredSessionCode(trusted);
  assert.equal(
    (
      await passwordDevice.request.post(endpoint('/crypto/totp/display'), {
        headers: originHeaders,
        data: {},
      })
    ).status(),
    401,
  );
  assert.equal((await passwordDevice.request.get(endpoint('/crypto/account'))).status(), 401);
  await passwordDevice.getByLabel('6 位登录动态码').fill(code);
  await passwordDevice.getByRole('button', { name: '验证并继续' }).click();
  await requireAccount(passwordDevice);
  const replay = await qrDevice.request.post(endpoint('/crypto/login/code'), {
    headers: originHeaders,
    data: { id: pending.trustedLogin.id, claim: pending.trustedLogin.claim, code },
  });
  assert.equal(replay.status(), 404);
  const next = await anonymous.request.post(endpoint('/crypto/login'), {
    headers: originHeaders,
    data: passwordInput,
  });
  assert(next.ok());
  const second = (await next.json()).trustedLogin;
  assert.equal(
    (
      await anonymous.request.post(endpoint('/crypto/login/code'), {
        headers: originHeaders,
        data: { id: second.id, claim: second.claim, code },
      })
    ).status(),
    401,
  );
  await qrDevice.goto(messages);
  await qrDevice.getByRole('button', { name: '出示本机登录码', exact: true }).click();
  const qr = await readQr(qrDevice.getByRole('img', { name: '可信设备扫码登录二维码' }));
  await expect(qrDevice.getByLabel('UID 或用户名')).toHaveCount(0);
  await expect(qrDevice.getByRole('button', { name: '代码一致，确认登录' })).toHaveCount(0);
  assert.equal((await (await qrDevice.request.get(endpoint('/me'))).json()).user, null);
  const approval = new URL(qr.data);
  assert.equal(approval.origin, origin);
  assert.match(approval.searchParams.get('login-key') ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert(!qr.data.includes('claim'));
  const wrong = new URL(approval);
  wrong.searchParams.set('login-key', 'A'.repeat(43));
  await trusted.goto(wrong.href);
  await expect(trusted.getByText('扫码链接与待登录设备不匹配')).toBeVisible();
  await trusted.goto(approval.href);
  const confirmation = trusted.getByRole('dialog', { name: '确认新设备登录' });
  await expect(confirmation).toBeVisible();
  await trusted.setViewportSize({ width: 390, height: 844 });
  await trusted.goto(`${security}&security-action=scan`);
  const scanner = trusted.getByRole('dialog', { name: '扫描新设备二维码' });
  await expect(scanner.getByRole('button', { name: '开启相机扫描' })).toBeVisible();
  await scanner.getByLabel('导入登录二维码图片').setInputFiles(qr.file);
  await expect(confirmation.locator('.im-trusted-match')).toHaveText(
    (await qrDevice.locator('.im-trusted-match').textContent())!,
  );
  await confirmation.getByRole('button', { name: '代码一致，确认登录' }).click();
  await requireAccount(qrDevice);
  const originalRoot = await savedRoot(trusted);
  assert.equal(originalRoot?.length, 44);
  await expect.poll(() => savedRoot(qrDevice)).toBe(originalRoot);

  await trusted.goto(`${security}&security-action=invite`);
  const inviteDialog = trusted.getByRole('dialog', { name: '让另一台设备登录' });
  const invitationQr = await readQr(inviteDialog.getByRole('img', { name: '新设备登录邀请二维码' }));
  const url = new URL(invitationQr.data);
  assert.equal(url.origin, origin);
  assert.equal(url.search, '?page=login-invite');
  assert.match(url.hash, /^#invite=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  const [inviteId] = new URLSearchParams(url.hash.slice(1)).get('invite')!.split('.');
  const otherSession = await passwordDevice.context().newPage();
  await otherSession.goto(url.href);
  await expect(
    otherSession.getByText('此浏览器已经登录。请在新设备或未登录的浏览器打开邀请。'),
  ).toBeVisible();
  assert.equal(new URL(otherSession.url()).hash, '');
  assert.equal((await otherSession.request.get(endpoint(`/crypto/qr/invite/${inviteId}`))).status(), 404);
  await requireAccount(otherSession);
  await otherSession.close();

  await invitedDevice.goto(messages);
  const foreignInvitation = (host: string) =>
    `https://${host}/?page=login-invite#invite=11111111-1111-4111-8111-111111111111.${'a'.repeat(43)}`;
  const qrFile = async (url: string) => ({
    name: 'site-test.png',
    mimeType: 'image/png',
    buffer: await QRCode.toBuffer(url, { width: 480, errorCorrectionLevel: 'H' }),
  });
  await invitedDevice
    .getByLabel('导入邀请二维码图片')
    .setInputFiles(await qrFile(foreignInvitation('untrusted.example')));
  await expect(invitedDevice.getByText('请在出示二维码的站点登录')).toBeVisible();
  await expect(invitedDevice.getByRole('link', { name: /继续/ })).toHaveCount(0);
  const configuredRedirectHost = process.env.TEST_LOGIN_REDIRECT_HOST?.trim();
  if (configuredRedirectHost) {
    await invitedDevice
      .getByLabel('导入邀请二维码图片')
      .setInputFiles(await qrFile(foreignInvitation(configuredRedirectHost)));
    const correctSite = invitedDevice.getByRole('link', { name: `在 ${configuredRedirectHost} 继续` });
    await expect(correctSite).toHaveAttribute('href', foreignInvitation(configuredRedirectHost));
    await expect(invitedDevice.getByRole('button', { name: '接受登录邀请' })).toHaveCount(0);
    await invitedDevice.getByRole('button', { name: '重新扫码' }).click();
  }
  const android = await browser.newPage();
  await android.addInitScript(`
    window.fablePavilionUseLoginSite = (url) => {
      sessionStorage.setItem('selected-site', url);
      return true;
    };
  `);
  try {
    await android.goto(messages);
    expect(await android.evaluate('typeof window.fablePavilionUseLoginSite')).toBe('function');
    await android
      .getByLabel('导入邀请二维码图片')
      .setInputFiles(await qrFile(foreignInvitation('self-hosted.example:8443')));
    await expect
      .poll(() => android.evaluate(() => sessionStorage.getItem('selected-site')))
      .toBe(foreignInvitation('self-hosted.example:8443'));
    await expect(android.getByRole('button', { name: '接受登录邀请' })).toHaveCount(0);
    await expect(android.getByRole('link', { name: /继续/ })).toHaveCount(0);
  } finally {
    await android.close();
  }
  const claimResponse = invitedDevice.waitForResponse((value) =>
    value.url().endsWith('/crypto/qr/invite/claim'),
  );
  await invitedDevice.getByLabel('导入邀请二维码图片').setInputFiles(invitationQr.file);
  const claim = await claimResponse;
  assert(claim.ok());
  assert(!(await invitedDevice.context().cookies()).some((cookie) => cookie.name === 'pocket_im_session'));
  const input = claim.request().postDataJSON();
  const claimed = await claim.json();
  const duplicate = await anonymous.request.post(endpoint('/crypto/qr/invite/claim'), {
    headers: originHeaders,
    data: input,
  });
  assert.equal(duplicate.status(), 409);
  assert.equal((await passwordDevice.request.get(endpoint(`/crypto/qr/${claimed.id}`))).status(), 404);
  await expect(confirmation.getByText(claimed.id.slice(0, 6).toUpperCase(), { exact: true })).toBeVisible();
  await expect(invitedDevice.getByText(claimed.id.slice(0, 6).toUpperCase(), { exact: true })).toBeVisible();
  await confirmation.getByRole('button', { name: '代码一致，确认登录' }).click();
  assert.equal((await (await invitedDevice.request.get(endpoint('/me'))).json()).user, null);
  await invitedDevice.getByRole('button', { name: '代码一致，确认登录' }).click();
  await requireAccount(invitedDevice);
  await expect.poll(() => savedRoot(invitedDevice)).toBe(originalRoot);

  await trusted.goto(`${security}&security-action=invite`);
  const cancelled = await readQr(inviteDialog.getByRole('img', { name: '新设备登录邀请二维码' }));
  const [id, secret] = new URLSearchParams(new URL(cancelled.data).hash.slice(1)).get('invite')!.split('.');
  await inviteDialog.getByRole('button', { name: '取消登录' }).click();
  await expect(inviteDialog).toBeHidden();
  assert.equal(
    (
      await anonymous.request.post(endpoint('/crypto/qr/invite/claim'), {
        headers: originHeaders,
        data: { ...input, id, secret },
      })
    ).status(),
    409,
  );
  const afterQrState = await (await trusted.request.get(endpoint('/crypto/trusted'))).json();
  assert.equal(afterQrState.devices.length, 0, 'Code and both QR flows must work before passkey enrollment');
  const cdp = await trusted.context().newCDPSession(trusted);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await trusted.bringToFront();
  await trusted.goto(`${origin}/?page=authenticators`);
  await trusted.getByRole('button', { name: '添加验证器', exact: true }).click();
  const authenticatorDialog = trusted.getByRole('dialog', { name: '添加验证器' });
  const authenticator = new URL(
    (await readQr(authenticatorDialog.getByRole('img', { name: '验证器设置二维码' }))).data,
  );
  assert.equal(authenticator.protocol, 'otpauth:');
  assert.equal(authenticator.hostname, 'totp');
  assert.equal(authenticator.searchParams.get('digits'), '6');
  assert.equal(authenticator.searchParams.get('period'), '30');
  assert.match(authenticator.searchParams.get('secret') ?? '', /^[A-Z2-7]{32}$/);
  await authenticatorDialog.getByText('设置密钥', { exact: true }).click();
  await expect(authenticatorDialog.getByRole('button', { name: '复制设置密钥' })).toBeVisible();
  await trusted.keyboard.press('Escape');
  await expect(authenticatorDialog).toBeHidden();

  await trusted.goto(devices);
  const settings = trusted.getByRole('region', { name: '通行密钥' });
  await settings.getByRole('button', { name: '创建通行密钥' }).click();
  await expect(settings.getByRole('list', { name: '已创建的通行密钥' })).toBeVisible();

  await trusted.goto(`${origin}/?page=login-devices`);
  await expect(trusted.getByText('当前设备', { exact: true })).toBeVisible();
  await expect(trusted.getByRole('button', { name: '退出其他设备', exact: true })).toBeVisible();

  await trusted.goto(`${origin}/?page=account-credentials`);
  await expect(trusted.getByLabel('当前密码', { exact: true })).toHaveCount(0);
  await trusted.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(trusted.getByLabel('当前密码', { exact: true })).toBeVisible();
  await trusted.getByRole('button', { name: '更换恢复码', exact: true }).click();
  await expect(trusted.getByRole('button', { name: '生成新恢复码' })).toBeVisible();
  await trusted.goto(devices);
  await settings.getByText('最近安全活动', { exact: true }).click();
  await expect(
    settings.getByRole('list', { name: '账号安全活动' }).getByText('新设备已登录', { exact: true }),
  ).toHaveCount(3);
  assert.deepEqual(errors, []);
  console.log(
    'Default codes and both QR directions without passkeys, password 2FA, original vault, independent authenticator setup, passkey enrollment and login-device settings passed',
  );
} finally {
  try {
    await browser.close();
  } finally {
    await close();
  }
}
