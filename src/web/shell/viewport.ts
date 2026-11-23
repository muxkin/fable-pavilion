import { onMounted, onScopeDispose } from 'vue';
import { appViewport, installAppZoom } from './app-zoom';

/** Fit the app to the visible area, including mobile browser chrome and the keyboard. */
export function useAppViewport() {
  let cleanup: (() => void) | undefined;
  onMounted(() => {
    const viewport = window.visualViewport;
    // Keep application chrome fixed; ImagePreview owns its own image transforms.
    const preventPinch = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    };
    const preventGesture = (event: Event) => event.preventDefault();
    const preventWheelZoom = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    document.addEventListener('touchmove', preventPinch, { passive: false });
    document.addEventListener('gesturestart', preventGesture, { passive: false });
    document.addEventListener('gesturechange', preventGesture, { passive: false });
    document.addEventListener('wheel', preventWheelZoom, { passive: false });
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Browser-level accessibility overrides must not corrupt the layout geometry.
        if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
        const { height, top } = appViewport();
        document.documentElement.style.setProperty('--app-visible-height', `${height}px`);
        document.documentElement.style.setProperty('--app-visible-top', `${top}px`);
      });
    };
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    const stopZoom = installAppZoom();
    cleanup = () => {
      document.removeEventListener('touchmove', preventPinch);
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
      document.removeEventListener('wheel', preventWheelZoom);
      stopZoom();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      document.documentElement.style.removeProperty('--app-visible-height');
      document.documentElement.style.removeProperty('--app-visible-top');
    };
  });
  onScopeDispose(() => cleanup?.());
}
