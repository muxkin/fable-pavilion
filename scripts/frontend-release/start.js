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
    output.textContent = '无法启动前端验签。请检查浏览器设置后重新加载。';
  }
})();
