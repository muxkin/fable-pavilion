import { defineComponent, onBeforeUnmount, onErrorCaptured, onMounted, shallowRef } from 'vue';
import { recordDiagnostic } from '../diagnostics';
import { assetFailureStatus, pageFailure, type PageFailure } from './page-failure';
import type { AppPage } from './routes';
export const PageLoading = defineComponent(
  (props: { label?: string; page?: AppPage }) => {
    const slow = shallowRef(false);
    let timer: ReturnType<typeof setTimeout>;
    onMounted(() => {
      timer = setTimeout(() => {
        slow.value = true;
        recordDiagnostic({ code: 'page-load-slow', page: props.page, elapsedMs: 8000 });
      }, 8000);
    });
    onBeforeUnmount(() => clearTimeout(timer));
    return () => (
      <div class="module-empty page-loading" role="status">
        <p>{slow.value ? '页面仍在准备中。' : (props.label ?? '正在打开…')}</p>
        {slow.value && (
          <button class="secondary" onClick={() => location.reload()}>
            重新加载此页
          </button>
        )}
      </div>
    );
  },
  { props: ['label', 'page'] },
);

export const PageBoundary = defineComponent(
  (
    props: {
      page: AppPage;
      onBack: () => void;
      backLabel: string;
    },
    { slots },
  ) => {
    const currentFailure = shallowRef<PageFailure>();
    const online = shallowRef(navigator.onLine);
    const connection = () => {
      online.value = navigator.onLine;
    };
    onMounted(() => {
      window.addEventListener('online', connection);
      window.addEventListener('offline', connection);
    });
    onBeforeUnmount(() => {
      window.removeEventListener('online', connection);
      window.removeEventListener('offline', connection);
    });
    onErrorCaptured((error) => {
      const failure = pageFailure(error);
      currentFailure.value = failure;
      recordDiagnostic({
        code: failure.kind === 'resource' ? 'page-resource-failed' : 'page-runtime-failed',
        page: props.page,
        asset: failure.resource,
        status: failure.resource ? assetFailureStatus(failure.resource) : undefined,
      });
      return false;
    });
    return () => {
      const failure = currentFailure.value;
      if (!failure) return slots.default?.();
      return (
        <section class="module-empty page-failure" role="alert">
          <h2>{failure.kind === 'resource' ? '页面资源暂未加载成功' : '这个页面遇到了问题'}</h2>
          <p>
            {!online.value
              ? '当前处于离线状态，联网后可重新加载。'
              : failure.kind === 'resource'
                ? '请重新加载此页，获取完整的页面资源。'
                : '重新加载后再试一次，也可以先返回其他页面。'}
          </p>
          <div class="page-failure-actions">
            <button class="primary" onClick={() => location.reload()}>
              重新加载此页
            </button>
            <button class="secondary" onClick={props.onBack}>
              {props.backLabel}
            </button>
          </div>
        </section>
      );
    };
  },
  { props: ['page', 'onBack', 'backLabel'] },
);
