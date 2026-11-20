/** Some Chromium-based mobile browsers have the base APIs but not the newer helpers. */
export function installBrowserCompatibility() {
  const method = (target: object, name: string, value: unknown) =>
    Object.defineProperty(target, name, { value, writable: true, configurable: true });

  if (typeof AbortSignal.timeout !== 'function') {
    method(AbortSignal, 'timeout', (milliseconds: number) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
        milliseconds,
      );
      return controller.signal;
    });
  }
  if (typeof AbortSignal.any !== 'function') {
    method(AbortSignal, 'any', (signals: AbortSignal[]) => {
      const controller = new AbortController();
      const first = signals.find((signal) => signal.aborted);
      if (first) {
        controller.abort(first.reason);
        return controller.signal;
      }
      const listeners = new Map<AbortSignal, () => void>();
      for (const signal of new Set(signals)) {
        const onAbort = () => {
          for (const [source, listener] of listeners) source.removeEventListener('abort', listener);
          listeners.clear();
          controller.abort(signal.reason);
        };
        listeners.set(signal, onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      return controller.signal;
    });
  }
  if (typeof AbortSignal.prototype.throwIfAborted !== 'function') {
    method(AbortSignal.prototype, 'throwIfAborted', function (this: AbortSignal) {
      if (this.aborted) throw this.reason;
    });
  }
  if (typeof Reflect.get(Promise, 'withResolvers') !== 'function') {
    method(Promise, 'withResolvers', function <T>(this: PromiseConstructor) {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new this<T>((fulfill, fail) => {
        resolve = fulfill;
        reject = fail;
      });
      return { promise, resolve, reject };
    });
  }
}
