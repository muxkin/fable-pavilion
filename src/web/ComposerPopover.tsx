import { tsxComponent } from './tsx-component';
import { useId, shallowRef, type VNodeChild } from 'vue';
import { watchRender } from './render-effects';
import { appRect, appViewport } from './shell/app-zoom';

/** A light-dismiss surface anchored to the composer, without a modal backdrop. */
export const ComposerPopover = tsxComponent(function ComposerPopover(initialProps: {
  label: string;
  title?: string;
  trigger: VNodeChild;
  className?: string;
  disabled?: boolean;
  hidden?: boolean;
  menu?: boolean;
  maxWidth?: number;
  openRequest?: number;
  openRequestAnchor?: HTMLElement;
  onOpen?: () => void;
  children: (close: (restoreFocus?: boolean) => void) => VNodeChild;
}) {
  const { onOpen } = initialProps;

  const id = useId();
  const panel = shallowRef<HTMLDivElement | null>(null);
  const button = shallowRef<HTMLButtonElement | null>(null);
  let externalAnchor: HTMLElement | undefined;
  const onOpenRef = { current: onOpen };
  const watchAttribute = watchRender();
  const watchOpenRequest = watchRender();
  return ({
    label,
    title,
    trigger,
    className = '',
    disabled = false,
    hidden = false,
    menu = false,
    maxWidth = menu ? 304 : 344,
    openRequest = 0,
    openRequestAnchor,
    onOpen,
    children,
  }) => {
    onOpenRef.current = onOpen;
    const close = (restoreFocus = true) => {
      const focusTarget = externalAnchor?.isConnected ? externalAnchor : button.value;
      panel.value?.hidePopover();
      if (restoreFocus) focusTarget?.focus({ preventScroll: true });
    };
    watchAttribute(() => {
      const el = panel.value;
      const anchor = button.value;
      const composer = anchor?.closest('.composer-box');
      if (!el || !anchor || !composer) return;
      const viewport = window.visualViewport;
      const position = () => {
        const box = appRect(composer.getBoundingClientRect());
        const source = externalAnchor?.isConnected ? externalAnchor : undefined;
        const triggerBox = appRect((source ?? anchor).getBoundingClientRect());
        const bounds = appViewport();
        const width = Math.min(maxWidth, bounds.width - 24);
        const targetLeft = source ? triggerBox.right - width : triggerBox.left;
        el.style.width = `${width}px`;
        el.style.left = `${Math.max(bounds.left + 12, Math.min(targetLeft, bounds.right - width - 12))}px`;
        el.style.top = source ? `${triggerBox.bottom + 8}px` : 'auto';
        el.style.bottom = source ? 'auto' : `${bounds.windowHeight - box.top + 8}px`;
        const availableHeight = source ? bounds.bottom - triggerBox.bottom : box.top - bounds.top;
        el.style.maxHeight = `${Math.max(80, availableHeight - 20)}px`;
      };
      let frame = 0;
      const reposition = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (el.matches(':popover-open')) position();
        });
      };
      const observer = new ResizeObserver(reposition);
      const stopTracking = () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        frame = 0;
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
        viewport?.removeEventListener('resize', reposition);
        viewport?.removeEventListener('scroll', reposition);
      };
      const before = (event: Event) => {
        if ((event as ToggleEvent).newState === 'open') {
          position();
          onOpenRef.current?.();
        } else {
          externalAnchor?.setAttribute('aria-expanded', 'false');
          externalAnchor = undefined;
          stopTracking();
        }
      };
      const toggle = () => {
        const open = el.matches(':popover-open');
        anchor.setAttribute('aria-expanded', String(open));
        if (open) {
          externalAnchor?.setAttribute('aria-expanded', 'true');
          observer.observe(composer);
          window.addEventListener('resize', reposition);
          window.addEventListener('scroll', reposition, true);
          viewport?.addEventListener('resize', reposition);
          viewport?.addEventListener('scroll', reposition);
          const target = el.querySelector<HTMLElement>(
            '[aria-checked="true"], button:not(:disabled), input, textarea',
          );
          target?.focus({ preventScroll: true });
        }
      };
      el.addEventListener('beforetoggle', before);
      el.addEventListener('toggle', toggle);
      return () => {
        externalAnchor?.setAttribute('aria-expanded', 'false');
        stopTracking();
        el.removeEventListener('beforetoggle', before);
        el.removeEventListener('toggle', toggle);
      };
    }, [maxWidth, hidden]);
    watchOpenRequest(() => {
      const el = panel.value;
      if (!openRequest || !el) return;
      if (el.matches(':popover-open') && externalAnchor !== openRequestAnchor) el.hidePopover();
      externalAnchor = openRequestAnchor;
      el.showPopover();
    }, [openRequest, hidden]);
    if (hidden) return null;
    return (
      <>
        <button
          ref={button}
          type="button"
          class={`composer-control-trigger ${className}`}
          popovertarget={id}
          aria-label={label}
          title={title ?? label}
          aria-haspopup={menu ? 'menu' : 'dialog'}
          aria-expanded="false"
          disabled={disabled}
        >
          {trigger}
        </button>
        <div
          ref={panel}
          id={id}
          popover="auto"
          role={menu ? 'menu' : 'dialog'}
          aria-label={label}
          class={`composer-popover ${menu ? 'permission-menu' : ''}`}
          onKeydown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
            if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const items = [
              ...(event.currentTarget as HTMLDivElement).querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
              ),
            ];
            if (!items.length) return;
            event.preventDefault();
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {children(close)}
        </div>
      </>
    );
  };
});
