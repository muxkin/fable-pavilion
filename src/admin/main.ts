import { createApp } from 'vue';
import './admin.css';
import { AdminApp } from './AdminApp';
import { initializeLocale } from '../shared/i18n';
import { installDomTranslator } from '../web/i18n/dom-translator';

initializeLocale((locale) =>
  locale === 'en' ? 'Fable Pavilion · Operations Console' : '子虚亭 · 管理台',
);
createApp(AdminApp).mount('#admin-root');
installDomTranslator(document.body);
