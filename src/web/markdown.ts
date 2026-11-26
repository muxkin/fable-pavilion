import type { Element } from 'hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { urlAttributes } from 'html-url-attributes';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified, type PluggableList } from 'unified';
import { visit } from 'unist-util-visit';
import { cloneVNode, Fragment, h, isVNode, type VNodeChild } from 'vue';

type MarkdownElement = {
  node?: Element;
  children?: VNodeChild;
  class?: string;
  checked?: boolean;
  src?: string;
  alt?: string;
  href?: string;
};
export type MarkdownComponents = Record<string, (props: MarkdownElement) => VNodeChild>;

export function defaultUrlTransform(url: string) {
  const colon = url.indexOf(':');
  const relative = ['/', '?', '#'].some((separator) => {
    const index = url.indexOf(separator);
    return index !== -1 && colon > index;
  });
  return colon === -1 || relative || /^(https?|ircs?|mailto|xmpp)$/i.test(url.slice(0, colon)) ? url : '';
}

const SAFE_IMG_ATTRS = new Set(['src', 'alt', 'title', 'width', 'height', 'align', 'loading']);

function parseSafeHtmlImg(raw: string): Element | null {
  const trimmed = raw.trim();
  const match = /^(?:<p(?:\s+align\s*=\s*["']?(?:left|center|right)["']?)?>\s*)?<img\b([\s\S]*?)\/?>(?:\s*<\/p>)?$/i.exec(
    trimmed,
  );
  if (!match) return null;
  const attrSource = match[1].trim();
  if (!attrSource) return null;
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let cursor = 0;
  let found: RegExpExecArray | null;
  while ((found = attrRe.exec(attrSource))) {
    if (attrSource.slice(cursor, found.index).trim()) return null;
    cursor = found.index + found[0].length;
    const name = found[1].toLowerCase();
    if (!SAFE_IMG_ATTRS.has(name)) return null;
    const value = (found[2] ?? found[3] ?? found[4] ?? '').trim();
    attrs[name] = value;
  }
  if (attrSource.slice(cursor).trim()) return null;
  if (!attrs.src) return null;
  const properties: Record<string, string> = { src: attrs.src };
  if (attrs.alt) properties.alt = attrs.alt;
  if (attrs.title) properties.title = attrs.title;
  return {
    type: 'element',
    tagName: 'img',
    properties,
    children: [],
  };
}

export function renderMarkdown(
  source: string,
  {
    remarkPlugins = [],
    rehypePlugins = [],
    components = {},
    urlTransform = defaultUrlTransform,
  }: {
    remarkPlugins?: PluggableList;
    rehypePlugins?: PluggableList;
    components?: MarkdownComponents;
    urlTransform?: (url: string) => string;
  } = {},
) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePlugins);
  const tree = processor.runSync(processor.parse(source));
  visit(tree, (node, index, parent) => {
    if (node.type === 'raw' && parent && index !== undefined) {
      const safeImg = parseSafeHtmlImg(node.value);
      if (safeImg) {
        safeImg.properties.src = urlTransform(String(safeImg.properties.src ?? ''));
        parent.children[index] = safeImg;
        return;
      }
      // Render all other raw HTML as escaped text, including script or event-handler syntax.
      parent.children[index] = { type: 'text', value: node.value };
    }
    if (node.type !== 'element') return;
    for (const name of Object.keys(node.properties)) {
      if (!Object.hasOwn(urlAttributes, name)) continue;
      const tags = urlAttributes[name];
      if (!tags || tags.includes(node.tagName)) {
        node.properties[name] = urlTransform(String(node.properties[name] ?? ''));
      }
    }
  });
  const render = ((type, { children, ...props }, key) => {
    if (typeof type === 'function') {
      const child = type({ ...props, children }) as VNodeChild;
      if (isVNode(child)) return cloneVNode(child, { key });
      return h(Fragment, { key }, Array.isArray(child) ? child : [child]);
    }
    return h(type, { ...props, key }, children as VNodeChild[]);
  }) as NonNullable<Parameters<typeof toJsxRuntime>[1]['jsx']>;
  return toJsxRuntime(tree, {
    Fragment,
    jsx: render,
    jsxs: render,
    components: components as Parameters<typeof toJsxRuntime>[1]['components'],
    passNode: true,
    elementAttributeNameCase: 'html',
  });
}
