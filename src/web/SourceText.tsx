import { tsxComponent } from './tsx-component';
import { memoizeRender } from './render-effects';
import './source-text.css';

export const SourceText = tsxComponent(function SourceText(_props: {
  text: string;
  highlighted?: string;
  wrap: boolean;
  lineNumbers: boolean;
}) {
  const readLines = memoizeRender();
  return ({ text, highlighted, wrap, lineNumbers }) => {
    const lines = lineNumbers ? readLines(() => text.split(/\r\n?|\n/), [text]) : undefined;
    const className =
      'source-text' + (lineNumbers ? ' source-text--numbered' : '') + (wrap ? ' source-text--wrap' : '');
    const gutter = lines ? { '--source-line-gutter': `${String(lines.length).length + 2}ch` } : undefined;
    return (
      <div class={className} style={gutter}>
        {highlighted ? (
          <div innerHTML={highlighted} />
        ) : (
          <pre>
            <code>
              {lines
                ? lines.flatMap((line, index) => [
                    <span class="line" key={index}>
                      {line}
                    </span>,
                    ...(index < lines.length - 1 ? ['\n'] : []),
                  ])
                : text}
            </code>
          </pre>
        )}
      </div>
    );
  };
});
