import { shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { watchRender, writeRef } from '../render-effects';

export const SvgCanvasPreview = tsxComponent(function SvgCanvasPreview(_props: {
  text: string;
  label: string;
}) {
  const darkBgState = shallowRef(false);
  const setDarkBg = writeRef(darkBgState);
  const zoomState = shallowRef(1);
  const setZoom = writeRef(zoomState);
  const urlState = shallowRef('');
  const setUrl = writeRef(urlState);
  const watchSvg = watchRender();

  return ({ text, label }) => {
    watchSvg(() => {
      // Rendering SVG inside <img> disables scripts and external subresources in browsers.
      const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      setUrl(url);
      return () => URL.revokeObjectURL(url);
    }, [text]);

    const zoom = zoomState.value;
    return (
      <div class="fp-svg">
        <div class="fp-subbar">
          <div class="fp-subbar-actions">
            <button type="button" aria-pressed={darkBgState.value} onClick={() => setDarkBg(!darkBgState.value)}>
              {darkBgState.value ? '浅色棋盘背景' : '深色棋盘背景'}
            </button>
          </div>
          <div class="fp-subbar-actions">
            <button type="button" disabled={zoom <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}>
              缩小
            </button>
            <span class="fp-subbar-meta">{Math.round(zoom * 100)}%</span>
            <button type="button" disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + 0.25))}>
              放大
            </button>
          </div>
        </div>
        <div class={`fp-svg-stage${darkBgState.value ? ' dark' : ''}`}>
          {urlState.value && (
            <img
              src={urlState.value}
              alt={label}
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
            />
          )}
        </div>
      </div>
    );
  };
});

export const HtmlSandboxPreview = tsxComponent(function HtmlSandboxPreview(_props: {
  html: string;
  title: string;
}) {
  return ({ html, title }) => (
    <div class="fp-html">
      <p class="fp-inline-note">安全沙箱预览：已禁用脚本、表单、弹窗及同源存储访问。</p>
      <iframe
        class="fp-html-frame"
        title={title}
        sandbox=""
        srcdoc={html}
        referrerpolicy="no-referrer"
      />
    </div>
  );
});
