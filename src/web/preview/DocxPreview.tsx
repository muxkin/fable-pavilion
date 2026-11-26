import DOMPurify from 'dompurify';
import { shallowRef } from 'vue';
import { tsxComponent } from '../tsx-component';
import { watchRender, writeRef } from '../render-effects';

export const DocxPreview = tsxComponent(function DocxPreview(_props: { buffer: ArrayBuffer }) {
  const htmlState = shallowRef('');
  const setHtml = writeRef(htmlState);
  const loadingState = shallowRef(true);
  const setLoading = writeRef(loadingState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const watchDocx = watchRender();

  return ({ buffer }) => {
    watchDocx(() => {
      setHtml('');
      setError('');
      setLoading(true);
      let cancelled = false;
      const createdUrls: string[] = [];

      void (async () => {
        try {
          const mod = await import('mammoth/mammoth.browser.min.js');
          const mammoth = (mod as { default?: typeof mod.default }).default ?? (mod as unknown as typeof mod.default);
          if (cancelled) return;
          const result = await mammoth.convertToHtml(
            { arrayBuffer: buffer.slice(0) },
            {
              convertImage: mammoth.images.imgElement(async (image) => {
                const imgBuf = await image.readAsArrayBuffer();
                const blob = new Blob([imgBuf], { type: image.contentType || 'image/png' });
                const url = URL.createObjectURL(blob);
                createdUrls.push(url);
                return { src: url };
              }),
            },
          );
          if (cancelled) return;
          const clean = DOMPurify.sanitize(result.value, {
            ALLOWED_URI_REGEXP: /^(?:https?:|blob:|data:image\/|mailto:)/i,
            FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
            FORBID_ATTR: ['onerror', 'onload', 'onclick'],
          });
          setHtml(clean);
          setLoading(false);
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : 'Word 文档解析失败');
            setLoading(false);
          }
        }
      })();

      return () => {
        cancelled = true;
        for (const url of createdUrls) URL.revokeObjectURL(url);
      };
    }, [buffer]);

    if (errorState.value) {
      return (
        <div class="file-preview-state" role="alert">
          <p>{errorState.value}</p>
        </div>
      );
    }
    if (loadingState.value) {
      return (
        <p class="file-preview-state" role="status">
          正在解析 Word 文档…
        </p>
      );
    }
    if (!htmlState.value.trim()) {
      return <p class="file-preview-state">文档内容为空。</p>;
    }
    return <article class="fp-docx markdown" innerHTML={htmlState.value} />;
  };
});
