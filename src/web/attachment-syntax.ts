export type AttachmentSyntax = { language: string; label: string };

const formats = [
  ['lay laydoc', 'laymesh', 'LayMesh'],
  ['lcss', 'lcss', 'LCSS'],
  ['py pyw', 'python', 'Python'],
  ['js cjs mjs', 'javascript', 'JavaScript'],
  ['jsx', 'jsx', 'JSX'],
  ['ts cts mts', 'typescript', 'TypeScript'],
  ['tsx', 'tsx', 'TSX'],
  ['vue', 'vue', 'Vue'],
  ['json', 'json', 'JSON'],
  ['jsonc', 'jsonc', 'JSONC'],
  ['json5', 'json5', 'JSON5'],
  ['jsonl ndjson', 'jsonl', 'JSON Lines'],
  ['yaml yml', 'yaml', 'YAML'],
  ['toml', 'toml', 'TOML'],
  ['ini cfg conf properties', 'ini', '配置文件'],
  ['md markdown mdx', 'markdown', 'Markdown'],
  ['html htm', 'html', 'HTML'],
  ['xml xsl xslt xsd plist', 'xml', 'XML'],
  ['css', 'css', 'CSS'],
  ['scss', 'scss', 'SCSS'],
  ['sass', 'sass', 'Sass'],
  ['less', 'less', 'Less'],
  ['sh bash zsh', 'shellscript', 'Shell'],
  ['ps1 psm1', 'powershell', 'PowerShell'],
  ['sql', 'sql', 'SQL'],
  ['c h', 'c', 'C'],
  ['cc cpp cxx hpp hxx', 'cpp', 'C++'],
  ['cs', 'csharp', 'C#'],
  ['rs', 'rust', 'Rust'],
  ['go', 'go', 'Go'],
  ['java', 'java', 'Java'],
  ['kt kts', 'kotlin', 'Kotlin'],
  ['swift', 'swift', 'Swift'],
  ['rb', 'ruby', 'Ruby'],
  ['php', 'php', 'PHP'],
  ['tex sty cls', 'latex', 'LaTeX'],
  ['patch diff', 'diff', 'Diff'],
  ['graphql gql', 'graphql', 'GraphQL'],
] as const;

const syntaxByExtension = new Map<string, AttachmentSyntax>(
  formats.flatMap(([extensions, language, label]) =>
    extensions.split(' ').map((extension) => [extension, { language, label }]),
  ),
);

export function namedAttachmentSyntax(name: string, extension: string) {
  const syntax = syntaxByExtension.get(extension);
  if (syntax) return syntax;
  if (/^(?:dockerfile|containerfile)(?:\.|$)/i.test(name))
    return { language: 'dockerfile', label: 'Dockerfile' };
  if (/^(?:gnumakefile|makefile)\b/i.test(name)) return { language: 'make', label: 'Makefile' };
  if (/^\.(?:bashrc|bash_profile|zshrc|zprofile)$/i.test(name))
    return { language: 'shellscript', label: 'Shell' };
}

export function detectedAttachmentSyntax(text: string, mime: string): AttachmentSyntax | undefined {
  const start = text.trimStart().slice(0, 8192);
  const shebang = /^#![^\r\n]*/.exec(start)?.[0];
  if (shebang) {
    if (/\bpython(?:\d+(?:\.\d+)?)?(?:\s|$)/.test(shebang)) return syntaxByExtension.get('py');
    if (/\b(?:node|nodejs|deno)(?:\s|$)/.test(shebang)) return syntaxByExtension.get('js');
    if (/\b(?:sh|bash|dash|zsh|ksh)(?:\s|$)/.test(shebang)) return syntaxByExtension.get('sh');
    if (/\bruby(?:\s|$)/.test(shebang)) return syntaxByExtension.get('rb');
  }
  if (mime === 'text/html' || /^<\s*(?:!doctype\s+html\b|html\b)/i.test(start))
    return syntaxByExtension.get('html');
  if (mime.endsWith('/xml') || mime.endsWith('+xml') || /^<\?xml\s/i.test(start))
    return syntaxByExtension.get('xml');
  if (mime.endsWith('/json') || mime.endsWith('+json') || /^\{\s*"[^"\r\n]+"\s*:/.test(start))
    return syntaxByExtension.get('json');
  if (/(?:\/|\+)(?:x-)?yaml$/.test(mime)) return syntaxByExtension.get('yaml');
  if (mime === 'text/markdown') return syntaxByExtension.get('md');
  if (mime === 'text/css') return syntaxByExtension.get('css');
  if (mime.endsWith('/javascript')) return syntaxByExtension.get('js');
}
