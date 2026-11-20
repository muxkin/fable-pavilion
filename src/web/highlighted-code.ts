import DOMPurify from 'dompurify';
import type { LanguageRegistration } from 'shiki';

const additionalLanguages = {
  csharp: () => import('@shikijs/langs/csharp'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  go: () => import('@shikijs/langs/go'),
  ini: () => import('@shikijs/langs/ini'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  latex: () => import('@shikijs/langs/latex'),
  make: () => import('@shikijs/langs/make'),
  powershell: () => import('@shikijs/langs/powershell'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
};

async function layMeshLanguages() {
  // TextMate grammars from the MIT-licensed LayMesh VS Code extension.
  const [{ default: laymesh }, { default: lcss }] = await Promise.all([
    import('./syntax/laymesh.tmLanguage.json'),
    import('./syntax/lcss.tmLanguage.json'),
  ]);
  return [
    { ...laymesh, name: 'laymesh' },
    { ...lcss, name: 'lcss' },
  ] as LanguageRegistration[];
}

export async function highlightedCode(text: string, language: string): Promise<string | undefined> {
  const shiki = await import('shiki/bundle/web');
  const custom = language === 'laymesh' || language === 'lcss';
  const additional = Object.hasOwn(additionalLanguages, language)
    ? additionalLanguages[language as keyof typeof additionalLanguages]
    : undefined;
  if (!custom && !additional && !Object.hasOwn(shiki.bundledLanguages, language)) return;
  const langs = custom
    ? ['css' as const, ...(await layMeshLanguages())]
    : additional
      ? (await additional()).default
      : [language as keyof typeof shiki.bundledLanguages];
  const { createJavaScriptRegexEngine } = await import('shiki/engine/javascript');
  const highlighter = await shiki.createHighlighter({
    langs,
    themes: ['github-light', 'github-dark'],
    engine: createJavaScriptRegexEngine(),
  });
  try {
    return DOMPurify.sanitize(
      highlighter.codeToHtml(text, {
        lang: language,
        themes: { light: 'github-light', dark: 'github-dark' },
      }),
    );
  } finally {
    highlighter.dispose();
  }
}
