import { createApp, h } from 'vue';
import { MessagingProvider } from './messaging/context';
import { AppShell } from './shell/AppShell';
import './styles/base.css';
import './shell/shell.css';
import './theme/theme.css';
import './theme/app-icons.css';
import './shell/surfaces.css';
import './theme/pavilion.css';
import { initializeAppearance } from './theme/store';
import { initializeLocale } from '../shared/i18n';
import { installDomTranslator } from './i18n/dom-translator';

initializeAppearance();
initializeLocale((locale) => (locale === 'en' ? 'Fable Pavilion' : '子虚亭 · Fable Pavilion'));

if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});

createApp({
  render: () => h(MessagingProvider, null, { default: () => h(AppShell) }),
}).mount('#root');

installDomTranslator(document.body);
