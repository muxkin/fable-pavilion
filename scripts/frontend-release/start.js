(() => {
  try {
    const stored = JSON.parse(localStorage.getItem('pocket-appearance-v1') || 'null');
    const mode = stored?.version === 1 && (stored.mode === 'dark' || stored.mode === 'light') ? stored.mode : '';
    if (mode) {
      document.documentElement.dataset.colorMode = mode;
      document.documentElement.style.colorScheme = mode;
      const surface = stored.paint?.[mode]?.['--surface'] || (mode === 'dark' ? '#172329' : '#fffcf5');
      if (/^#[0-9a-f]{6}$/i.test(surface)) {
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', surface);
      }
    }
  } catch {}
})();

(async () => {
  const output = document.querySelector('p');
  try {
    if (!('serviceWorker' in navigator)) throw Error('Service workers are unavailable');
    const controlled = new Promise((resolve) =>
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
    );
    await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    if (!navigator.serviceWorker.controller) await controlled;
    location.reload();
  } catch {
    if (output) {
      output.dataset.error = 'true';
      output.textContent = '无法启动前端验签。请检查浏览器设置后重新加载。';
    }
  }
})();
