import { resolvedLocale, subscribeLocale } from '../../shared/i18n';

const SKIP_SELECTOR =
  '[data-no-i18n], .markdown, .code-block, .shiki, .im-text, .message-text, .source-text, pre, code, script, style, svg, textarea';
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const;

type TranslatorFn = (raw: string) => string | null;

const originalText = new WeakMap<Text, string>();
const originalAttrs = new WeakMap<Element, Map<string, string>>();
const translatedTextNodes = new Set<Text>();
const translatedElements = new Set<Element>();

let loadedTranslator: TranslatorFn | null = null;
let loadingTranslator: Promise<TranslatorFn> | null = null;

async function ensureTranslator(): Promise<TranslatorFn> {
  if (loadedTranslator) return loadedTranslator;
  loadingTranslator ??= import('./en-dict').then((mod) => {
    loadedTranslator = mod.translateZhToEn;
    return mod.translateZhToEn;
  });
  return loadingTranslator;
}

function isSkipped(node: Node | null): boolean {
  let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null;
  while (el) {
    if (el.matches?.(SKIP_SELECTOR)) return true;
    el = el.parentElement;
  }
  return false;
}

function translateTextNode(node: Text, translate: TranslatorFn) {
  if (isSkipped(node)) return;
  const current = node.nodeValue ?? '';
  if (!current.trim() || !/[\u4e00-\u9fff]/.test(current)) return;
  const translated = translate(current);
  if (!translated || translated === current) return;
  // Always record the latest Chinese source text in case Vue reused this Text node.
  originalText.set(node, current);
  node.nodeValue = translated;
  translatedTextNodes.add(node);
}

function translateElementAttrs(el: Element, translate: TranslatorFn) {
  if (el.closest?.('[data-no-i18n]')) return;
  for (const attr of ATTRS) {
    const value = el.getAttribute(attr);
    if (!value || !/[\u4e00-\u9fff]/.test(value)) continue;
    const translated = translate(value);
    if (!translated || translated === value) continue;
    let map = originalAttrs.get(el);
    if (!map) {
      map = new Map();
      originalAttrs.set(el, map);
    }
    map.set(attr, value);
    el.setAttribute(attr, translated);
    translatedElements.add(el);
  }
}

function walkAndTranslate(root: Node, translate: TranslatorFn) {
  if (root instanceof Text) {
    translateTextNode(root, translate);
    return;
  }
  if (root instanceof Element) {
    translateElementAttrs(root, translate);
    if (isSkipped(root)) return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current: Node | null = walker.nextNode();
  while (current) {
    if (current instanceof Text) translateTextNode(current, translate);
    else if (current instanceof Element) translateElementAttrs(current, translate);
    current = walker.nextNode();
  }
}

function restoreAll() {
  for (const node of translatedTextNodes) {
    const orig = originalText.get(node);
    if (orig !== undefined && node.isConnected) node.nodeValue = orig;
  }
  translatedTextNodes.clear();
  for (const el of translatedElements) {
    const map = originalAttrs.get(el);
    if (map && el.isConnected) {
      for (const [attr, orig] of map) el.setAttribute(attr, orig);
    }
  }
  translatedElements.clear();
}

export function installDomTranslator(target: HTMLElement = document.body) {
  let observer: MutationObserver | null = null;
  let applying = false;
  let generation = 0;

  const stop = () => {
    observer?.disconnect();
    observer = null;
  };

  const start = async (gen: number) => {
    const translate = await ensureTranslator();
    if (gen !== generation || resolvedLocale.value !== 'en') return;
    stop();
    applying = true;
    try {
      walkAndTranslate(target, translate);
    } finally {
      applying = false;
    }
    observer = new MutationObserver((records) => {
      if (applying || resolvedLocale.value !== 'en') return;
      applying = true;
      try {
        for (const rec of records) {
          if (rec.type === 'characterData' && rec.target instanceof Text) {
            translateTextNode(rec.target, translate);
          } else if (rec.type === 'attributes' && rec.target instanceof Element) {
            translateElementAttrs(rec.target, translate);
          } else if (rec.type === 'childList') {
            for (const added of rec.addedNodes) walkAndTranslate(added, translate);
          }
        }
      } finally {
        applying = false;
      }
    });
    observer.observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRS],
    });
  };

  const sync = (locale: 'zh' | 'en') => {
    const gen = ++generation;
    if (locale === 'en') {
      void start(gen);
    } else {
      stop();
      restoreAll();
    }
  };

  sync(resolvedLocale.value);
  const unsub = subscribeLocale(sync);
  return () => {
    generation++;
    unsub();
    stop();
    restoreAll();
  };
}
