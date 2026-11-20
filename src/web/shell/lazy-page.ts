import { defineAsyncComponent, type AsyncComponentLoader } from 'vue';
import { recordDiagnostic } from '../diagnostics';
import { assetFailureStatus, pageFailure } from './page-failure';

/** Vite remembers attempted preloads, so explicitly replace a failed CSS request before retrying. */
export function lazyPage<T extends import('vue').Component>(loader: AsyncComponentLoader<T>) {
  return defineAsyncComponent({
    loader,
    onError(error, retry, fail, attempts) {
      const css = pageFailure(error).resource;
      if (attempts !== 1 || !css?.endsWith('.css') || !navigator.onLine) {
        fail();
        return;
      }
      const href = `/assets/${css}`;
      const status = assetFailureStatus(css);
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href + '?retry=1';
      const timer = window.setTimeout(() => done(false), 6000);
      function done(loaded: boolean) {
        window.clearTimeout(timer);
        link.onload = null;
        link.onerror = null;
        if (loaded) {
          recordDiagnostic({ code: 'page-resource-recovered', asset: css, status });
          retry();
        } else {
          link.remove();
          fail();
        }
      }
      link.onload = () => done(true);
      link.onerror = () => done(false);
      document.head.append(link);
    },
  });
}
