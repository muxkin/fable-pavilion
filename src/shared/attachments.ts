import type { Nodes, Parent, Root, PhrasingContent } from 'mdast';

export const localReference = (url: string) =>
  (url.startsWith('/') && !url.startsWith('//')) ||
  /^[a-z]:[\\/]/i.test(url) ||
  ['dsh-image:', 'dsh-file:', 'file:', 'sandbox:', './', '../', 'pocket-inline:', 'antigravity-image:'].some((prefix) =>
    url.startsWith(prefix),
  );

export function isExternalUrl(url: string): boolean {
  const trimmed = url.trim();
  return /^(?:https?:|data:|blob:|mailto:|tel:|\/\/)/i.test(trimmed);
}

export function isBareRelativeAssetPath(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('#') || isExternalUrl(trimmed)) return false;
  if (localReference(trimmed)) return false;
  if (/[\x00-\x1f]/.test(trimmed)) return false;
  // Reject unknown URI schemes (e.g. javascript:, ftp:, custom:) while keeping Windows drives out (handled by localReference).
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  return true;
}

function normalizeJoinedPath(baseDir: string, relativePath: string): string {
  const windows = /^[a-z]:[\\/]/i.test(baseDir);
  const cleanedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const cleanedRel = relativePath.replace(/\\/g, '/');
  const combined = `${cleanedBase}/${cleanedRel}`;
  const leadingSlash = !windows && combined.startsWith('/');
  const parts = combined.split('/');
  const stack: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part === '.') continue;
    if (part === '..') {
      if (windows && stack.length <= 1) continue;
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  const joined = `${leadingSlash ? '/' : ''}${stack.join('/')}`;
  return windows ? joined.replace(/\//g, '\\') : joined || '/';
}

export function documentDirectory(reference: string): string | null {
  if (!localReference(reference)) return null;
  if (
    ['dsh-image:', 'dsh-file:', 'pocket-inline:', 'antigravity-image:'].some((prefix) =>
      reference.startsWith(prefix),
    )
  ) {
    return null;
  }
  const raw = attachmentPath(reference).replace(/[?#].*$/, '').replace(/:\d+(?::\d+)?$/, '');
  const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  if (slash < 0) return null;
  if (slash === 0) return '/';
  if (/^[a-z]:$/i.test(raw.slice(0, slash))) return `${raw.slice(0, slash)}\\`;
  return raw.slice(0, slash);
}

/**
 * Resolves an image/asset reference inside a Markdown document or chat message:
 * - External URLs & special attachment schemes pass through unchanged.
 * - Absolute / file: / sandbox: local paths pass through unchanged.
 * - Relative paths (`./a.png`, `../a.png`, or bare `images/a.png`) resolve against
 *   `documentPath`'s parent directory when previewing a local `.md` file, or get
 *   normalized to `./...` so chat-message relative images route through local media API.
 */
export function resolveMarkdownAssetPath(rawSrc: string, documentPath?: string): string {
  const trimmed = rawSrc.trim();
  if (!trimmed || isExternalUrl(trimmed)) return trimmed;
  if (
    ['dsh-image:', 'dsh-file:', 'pocket-inline:', 'antigravity-image:'].some((prefix) =>
      trimmed.startsWith(prefix),
    )
  ) {
    return trimmed;
  }
  const isAbsoluteOrUri =
    (trimmed.startsWith('/') && !trimmed.startsWith('//')) ||
    /^[a-z]:[\\/]/i.test(trimmed) ||
    trimmed.startsWith('file:') ||
    trimmed.startsWith('sandbox:');
  if (isAbsoluteOrUri) return trimmed;
  if (trimmed.startsWith('./') || trimmed.startsWith('../') || isBareRelativeAssetPath(trimmed)) {
    const cleanRel = trimmed.replace(/[?#].*$/, '');
    let decodedRel = cleanRel;
    try {
      decodedRel = decodeURIComponent(cleanRel);
    } catch {
      /* keep raw */
    }
    const baseDir = documentPath ? documentDirectory(documentPath) : null;
    if (baseDir) return normalizeJoinedPath(baseDir, decodedRel);
    return trimmed.startsWith('./') || trimmed.startsWith('../') ? trimmed : `./${trimmed}`;
  }
  return trimmed;
}

export function attachmentPath(reference: string) {
  let path = reference.replace(/^sandbox:/, '');
  if (path.startsWith('file:')) {
    try {
      path = new URL(path).pathname.replace(/^\/([a-z]:\/)/i, '$1');
    } catch {
      /* Keep the reference. */
    }
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
export function attachmentName(path: string) {
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* Keep malformed references readable. */
    }
  }
  return (
    attachmentPath(path)
      .replace(/:\d+(?::\d+)?$/, '')
      .split(/[\\/]/)
      .at(-1) || '附件'
  );
}
type FileFormat = {
  extensions: string;
  kind: string;
  media?: 'image' | 'video' | 'audio';
  previewable?: boolean;
};
const imageFormat: FileFormat = {
  extensions: 'png jpg jpeg gif webp avif svg bmp ico',
  kind: '图片',
  media: 'image',
  previewable: true,
};
const fileFormats: FileFormat[] = [
  imageFormat,
  { extensions: 'mp4 webm mov m4v', kind: '视频', media: 'video', previewable: true },
  { extensions: 'mp3 wav ogg m4a flac', kind: '音频', media: 'audio', previewable: true },
  { extensions: 'docx', kind: 'Word 文档', previewable: true },
  { extensions: 'doc', kind: 'Word 文档' },
  { extensions: 'xlsx', kind: '电子表格', previewable: true },
  { extensions: 'xls ods', kind: '电子表格' },
  { extensions: 'csv tsv', kind: '电子表格', previewable: true },
  { extensions: 'pptx', kind: '演示文稿', previewable: true },
  { extensions: 'ppt odp', kind: '演示文稿' },
  { extensions: 'pdf', kind: 'PDF 文档', previewable: true },
  { extensions: 'ipynb', kind: 'Jupyter 笔记本', previewable: true },
  { extensions: 'html htm', kind: 'HTML 文档', previewable: true },
  { extensions: 'xml', kind: 'XML 文档', previewable: true },
  { extensions: 'odt', kind: '文档' },
  { extensions: 'lay laydoc', kind: 'LayMesh 源码', previewable: true },
  { extensions: 'lcss', kind: 'LCSS 源码', previewable: true },
  { extensions: 'zip gz tgz tar tar.gz', kind: '压缩包', previewable: true },
  { extensions: '7z rar xz bz2 tar.xz tar.bz2', kind: '压缩包' },
  {
    extensions:
      'txt text md markdown log json jsonl yaml yml toml ini py js jsx ts tsx sh sql tex rs c cpp h',
    kind: '文本文件',
    previewable: true,
  },
];
const formatsByExtension = new Map(
  fileFormats.flatMap((format) =>
    format.extensions.split(' ').map((extension) => [extension, format] as const),
  ),
);

// File formats are data, not separate renderers. Messages, drafts and details use this same model.
export function attachmentInfo(path: string, displayName?: string) {
  // Encrypted transport URLs intentionally hide the filename; use the decrypted name for presentation.
  const name = displayName || attachmentName(path);
  const extensionOf = (value: string) =>
    /(?:\.)(tar\.(?:gz|xz|bz2)|[a-z0-9]{1,10})$/i.exec(value)?.[1].toLowerCase();
  const extension = extensionOf(name) ?? extensionOf(attachmentName(path)) ?? '';
  const format = path.startsWith('dsh-image:') ? imageFormat : formatsByExtension.get(extension);
  return {
    name,
    extension,
    kind: format?.kind ?? '文件',
    media: format?.media ?? null,
    previewable: !!format?.previewable,
  };
}

/** Interpret native file citations only in prose, never in code, HTML, or existing links.
 * The server and Markdown UI share this transform so rendered files and authorized paths agree. */
export function remarkFileCitations() {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      const children: Nodes[] = [];
      for (const node of parent.children) {
        if (node.type === 'text') {
          // A brace inside a quoted filename is part of the path.
          const pattern =
            /:{1,2}codex-file-citation\{((?:[^"'{}\r\n]|"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*')*)\}/g;
          let offset = 0;
          for (const match of node.value.matchAll(pattern)) {
            const attributes = [
              ...match[1].matchAll(/([\w-]+)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g),
            ];
            const paths = attributes.filter((attribute) => attribute[1] === 'path');
            if (paths.length !== 1) continue;
            const path = paths[0][2].slice(1, -1).replace(/\\(["'])/g, '$1');
            if (!localReference(path) || /[\r\n\x00]/.test(path)) continue;
            if (match.index! > offset)
              children.push({ type: 'text', value: node.value.slice(offset, match.index) });
            children.push({
              type: 'link',
              url: path,
              children: [{ type: 'text', value: attachmentName(path) }],
              data: { hProperties: { 'data-file-citation': 'true' } },
            });
            offset = match.index! + match[0].length;
          }
          if (offset) {
            if (offset < node.value.length) children.push({ type: 'text', value: node.value.slice(offset) });
          } else children.push(node);
        } else {
          if ('children' in node && !['link', 'linkReference'].includes(node.type)) visit(node);
          children.push(node);
        }
      }
      parent.children = children as PhrasingContent[];
    };
    visit(tree);
  };
}
