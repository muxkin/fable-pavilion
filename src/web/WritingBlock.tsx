import { shallowRef, useId, type VNodeChild } from 'vue';
import { Icon } from './Icon';
import { watchRender } from './render-effects';
import { tsxComponent } from './tsx-component';
import type { WritingPart } from './writing-blocks';
import './writing-block.css';

type Block = Extract<WritingPart, { kind: 'writing' }>;

export const WritingBlock = tsxComponent(function WritingBlock(_props: {
  block: Block;
  renderText: (text: string) => VNodeChild;
}) {
  const titleId = useId();
  const selected = shallowRef(0);
  const feedback = shallowRef<'copied' | 'failed'>();
  const resetFeedback = watchRender();

  return ({ block, renderText }) => {
    const { title, subject, recipient, cc, bcc } = block.metadata;
    const option = block.options[selected.value] ?? block.options[0];
    const message = feedback.value;
    resetFeedback(() => {
      if (!message) return;
      const timer = setTimeout(() => {
        feedback.value = undefined;
      }, 2400);
      return () => clearTimeout(timer);
    }, [message, option.text]);

    return (
      <section class="writing-block" aria-labelledby={titleId}>
        <header class="writing-block-toolbar">
          <span id={titleId} class="writing-block-title">
            <Icon name="document" size={16} />
            {title || (subject ? '邮件草稿' : '写作草稿')}
          </span>
          <button
            type="button"
            aria-label="复制草稿"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(option.text);
                feedback.value = 'copied';
              } catch {
                feedback.value = 'failed';
              }
            }}
          >
            <Icon name={message === 'copied' ? 'check' : 'copy'} size={16} />
            {message === 'copied' ? '已复制' : '复制'}
          </button>
        </header>
        {(subject || recipient || cc || bcc) && (
          <dl class="writing-block-fields">
            {(
              [
                [recipient, '收件人'],
                [cc, '抄送'],
                [bcc, '密送'],
                [subject, '主题'],
              ] as const
            ).map(([value, label]) =>
              value ? (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ) : null,
            )}
          </dl>
        )}
        {block.options.length > 1 && (
          <div class="writing-block-options" role="group" aria-label="草稿版本">
            {block.options.map(({ label }, index) => (
              <button
                key={index}
                type="button"
                aria-pressed={option === block.options[index]}
                onClick={() => {
                  selected.value = index;
                  feedback.value = undefined;
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div class="writing-block-body">{renderText(option.text)}</div>
        <span class="writing-block-feedback" role="status">
          {message === 'failed' ? '复制失败，请选中正文后复制' : message === 'copied' ? '草稿已复制' : ''}
        </span>
      </section>
    );
  };
});
