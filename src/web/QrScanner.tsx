import { tsxComponent } from './tsx-component';
import { nextTick, onScopeDispose, shallowRef, useId } from 'vue';
import { watchRender, writeRef } from './render-effects';
import { Icon } from './Icon';
import { decodeQrImage } from './lite-login-decoder';
import './scanner-actions.css';

export const QrScanner = tsxComponent(function QrScanner(initialProps: {
  onScan: (text: string) => void;
  cameraAction: string;
  cameraLabel: string;
  imageAction: string;
  imageLabel: string;
  manualLinkLabel?: string;
  className?: string;
  actionIcons?: boolean;
  scanIcon?: boolean;
}) {
  const { onScan } = initialProps;

  const activeState = shallowRef(false);
  const setActive = writeRef(activeState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const linkState = shallowRef('');
  const setLink = writeRef(linkState);
  const pasteOpen = shallowRef(false);
  const pasteInput = shallowRef<HTMLInputElement | null>(null);
  const pasteButton = shallowRef<HTMLButtonElement | null>(null);
  const pasteId = useId();
  const video = shallowRef<HTMLVideoElement | null>(null);
  const callback = { current: onScan };
  const watchActive = watchRender();
  let imageAttempt = 0;
  onScopeDispose(() => {
    imageAttempt++;
  });
  return ({
    onScan,
    cameraAction,
    cameraLabel,
    imageAction,
    imageLabel,
    manualLinkLabel,
    className,
    actionIcons,
    scanIcon,
  }) => {
    const active = activeState.value;
    const error = errorState.value;
    const link = linkState.value;

    callback.current = onScan;
    const accepted = (text: string) => {
      callback.current(text);
      imageAttempt++;
      setError('');
      setActive(false);
      setLink('');
      pasteOpen.value = false;
    };
    watchActive(() => {
      if (!active) return;
      let disposed = false,
        stream: MediaStream | undefined,
        frame = 0;
      const stop = () => {
        disposed = true;
        cancelAnimationFrame(frame);
        stream?.getTracks().forEach((t) => t.stop());
      };
      const hidden = () => {
        if (document.visibilityState === 'hidden') {
          stop();
          setActive(false);
        }
      };
      document.addEventListener('visibilitychange', hidden);
      void (async () => {
        if (!navigator.mediaDevices?.getUserMedia) throw Error('当前浏览器无法打开相机');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const target = video.value!;
        target.srcObject = stream;
        await target.play();
        const jsQR = (await import('jsqr')).default;
        const canvas = document.createElement('canvas'),
          context = canvas.getContext('2d', { willReadFrequently: true })!;
        let last = 0;
        const scan = (now: number) => {
          if (disposed) return;
          if (now - last > 180 && target.videoWidth) {
            last = now;
            canvas.width = Math.min(960, target.videoWidth);
            canvas.height = Math.round((target.videoHeight * canvas.width) / target.videoWidth);
            context.drawImage(target, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height),
              result = jsQR(pixels.data, pixels.width, pixels.height);
            if (result) {
              try {
                accepted(result.data);
                stop();
                return;
              } catch (e) {
                setError((e as Error).message);
              }
            }
          }
          frame = requestAnimationFrame(scan);
        };
        frame = requestAnimationFrame(scan);
      })().catch((e) => {
        if (!disposed) {
          const errors: Record<string, string> = {
            NotFoundError: '未检测到摄像头，可以识别二维码图片',
            NotAllowedError: '请允许使用摄像头，或改用二维码图片',
            NotReadableError: '摄像头暂时无法使用，请关闭其他占用摄像头的应用',
          };
          setError(
            errors[e?.name] ??
              (e instanceof Error && /[\u4e00-\u9fff]/.test(e.message)
                ? e.message
                : '相机打开失败，请识别二维码图片'),
          );
          setActive(false);
        }
        stop();
      });
      return () => {
        stop();
        document.removeEventListener('visibilitychange', hidden);
      };
    }, [active]);
    return (
      <div class={className ? `qr-scanner ${className}` : 'qr-scanner'}>
        {active ? (
          <>
            <video
              class="qr-scanner-video"
              ref={video}
              playsinline
              muted
              aria-label={cameraLabel}
              style={{ width: '100%', maxHeight: 320, borderRadius: 16, objectFit: 'cover' }}
            />
            <button
              type="button"
              class="secondary qr-scanner-action qr-scanner-stop"
              onClick={() => setActive(false)}
            >
              <span class="qr-scanner-action-label">关闭相机</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            class="primary qr-scanner-action qr-scanner-start"
            onClick={() => {
              setError('');
              setActive(true);
            }}
          >
            {actionIcons && <Icon name={scanIcon ? 'scan' : 'camera'} size={22} />}
            <span class="qr-scanner-action-label">{cameraAction}</span>
          </button>
        )}
        <label class="secondary im-import-sticker qr-scanner-action">
          {actionIcons && <Icon name="image" size={22} />}
          <span class="qr-scanner-action-label">{imageAction}</span>
          <input
            type="file"
            accept="image/*"
            aria-label={imageLabel}
            onChange={(e) => {
              const file = (e.currentTarget as HTMLInputElement).files?.[0];
              (e.currentTarget as HTMLInputElement).value = '';
              if (!file) return;
              const attempt = ++imageAttempt;
              setError('');
              void (async () => {
                const result = await decodeQrImage(file, () => attempt === imageAttempt);
                if (attempt !== imageAttempt) return;
                if (!result) throw Error('图片中未找到二维码');
                accepted(result);
              })().catch((e) => {
                if (attempt === imageAttempt) setError(e.message);
              });
            }}
          />
        </label>
        {manualLinkLabel && (
          <>
            <button
              type="button"
              class="secondary qr-scanner-action qr-scanner-paste"
              ref={pasteButton}
              aria-expanded={pasteOpen.value}
              aria-controls={pasteId}
              onClick={() => {
                pasteOpen.value = !pasteOpen.value;
                if (pasteOpen.value) void nextTick(() => pasteInput.value?.focus());
              }}
            >
              {actionIcons && <Icon name="attach" size={22} />}
              <span class="qr-scanner-action-label">粘贴{manualLinkLabel}</span>
            </button>
            <form
              class="qr-scanner-manual"
              id={pasteId}
              hidden={!pasteOpen.value}
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  accepted(link);
                  void nextTick(() => pasteButton.value?.focus());
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <label>
                {manualLinkLabel}
                <input
                  ref={pasteInput}
                  value={link}
                  onInput={(e) => setLink((e.currentTarget as HTMLInputElement).value)}
                  autocomplete="off"
                  spellcheck={false}
                  required={pasteOpen.value}
                />
              </label>
              <button class="secondary qr-scanner-action" type="submit">
                <span class="qr-scanner-action-label">读取链接</span>
              </button>
            </form>
          </>
        )}
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  };
});
