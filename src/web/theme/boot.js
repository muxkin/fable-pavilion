// Applies saved preferences before Vue mounts. The palette engine refreshes this paint cache.
(() => {
  let data = {};
  try {
    const stored = JSON.parse(localStorage.getItem('pocket-appearance-v1') || 'null');
    if (stored?.version === 1) data = stored;
  } catch {
    /* Apply system defaults when the browser cannot read saved preferences. */
  }
  const mode =
    data.mode === 'dark' || data.mode === 'light'
      ? data.mode
      : matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  const theme =
    typeof data[mode] === 'string' && /^[a-z0-9-]{1,80}$/.test(data[mode]) ? data[mode] : `pavilion-${mode}`;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.colorMode = mode;
  root.style.colorScheme = mode;
  const colors =
    data.paint?.[mode] ??
    (theme === 'pavilion-dark'
      ? { '--canvas': '#172329', '--surface': '#1a2a2f', '--ink': '#f6f2ea' }
      : theme === 'pavilion-light'
        ? { '--canvas': '#f6f2ea', '--surface': '#fffcf5', '--ink': '#24343a' }
        : null);
  if (colors && typeof colors === 'object') {
    for (const [key, value] of Object.entries(colors).slice(0, 40)) {
      if (/^--[a-z-]{1,30}$/.test(key) && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value))
        root.style.setProperty(key, value);
    }
    if (/^#[0-9a-f]{6}$/i.test(colors['--surface']))
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors['--surface']);
  }
  // The default paths are already in the HTML.
  const icon = data.appIcon;
  if (icon === 'pavilion' || icon === 'zixu') {
    const image = `/app-icons/${icon}-192.png`;
    document.querySelector('link[rel="icon"]')?.setAttribute('href', `/app-icons/${icon}-32.png`);
    document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', image);
    document.querySelector('link[rel="manifest"]')?.setAttribute('href', `/app-icons/${icon}.webmanifest`);
  }
})();
