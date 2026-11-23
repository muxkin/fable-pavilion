import { onMounted, onScopeDispose, shallowRef } from 'vue';
import { t } from '../../shared/i18n';
import { tsxComponent } from '../tsx-component';
import { appViewport, useAppZoom } from './app-zoom';

export const AppZoomReset = tsxComponent(function AppZoomReset() {
  const { scale, change } = useAppZoom();
  const visible = shallowRef(false);
  const update = () => {
    const { width, height } = appViewport();
    visible.value = scale.value < 0.5 || (scale.value > 1 && (width < 160 || height < 128));
  };
  onMounted(() => {
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    update();
  });
  onScopeDispose(() => {
    window.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('resize', update);
  });
  return () =>
    visible.value && (
      <div class="app-zoom-reset">
        <button type="button" class="secondary" onClick={() => change('reset')}>
          {t('恢复 100% 缩放', 'Restore 100% zoom')}
        </button>
      </div>
    );
});
