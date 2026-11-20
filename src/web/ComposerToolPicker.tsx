import type { PluginChoice, SkillChoice } from '../shared/types';
import { Icon } from './Icon';
import { SkillPicker } from './SkillPicker';
import { ThreadTools } from './ThreadTools';

export type ToolKind = 'skills' | 'plugins';

export function ComposerToolEntries({
  skills = true,
  plugins,
  disabled,
  onChoose,
}: {
  skills?: boolean;
  plugins: boolean;
  disabled?: boolean;
  onChoose: (kind: ToolKind) => void;
}) {
  return (
    <>
      {skills && (
        <button
          type="button"
          class="control-row compact"
          disabled={disabled}
          onClick={() => onChoose('skills')}
        >
          <Icon name="book" size={19} />
          <span>技能</span>
          <Icon name="chevron" size={16} />
        </button>
      )}
      {plugins && (
        <button
          type="button"
          class="control-row compact"
          disabled={disabled}
          onClick={() => onChoose('plugins')}
        >
          <Icon name="puzzle" size={19} />
          <span>插件</span>
          <Icon name="chevron" size={16} />
        </button>
      )}
    </>
  );
}

export function ComposerToolPicker({
  kind,
  threadId,
  creationProject,
  skills,
  plugins,
  disabled,
  onSkills,
  onPlugins,
  onClose,
  onDirtyChange,
}: {
  kind: ToolKind;
  threadId: string;
  creationProject?: string;
  skills: SkillChoice[];
  plugins: PluginChoice[];
  disabled: boolean;
  onSkills: (value: SkillChoice[]) => void;
  onPlugins: (value: PluginChoice[]) => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  return (
    <ThreadTools
      open
      className="picker-sheet"
      onClose={onClose}
      title=""
      heading={kind === 'plugins' ? '添加插件' : '添加技能'}
    >
      {() => (
        <SkillPicker
          key={kind}
          threadId={threadId}
          creationProject={creationProject}
          kind={kind}
          selected={kind === 'plugins' ? plugins : skills}
          disabled={disabled}
          onDirtyChange={onDirtyChange}
          onApply={(value) => {
            if (kind === 'plugins') onPlugins(value as PluginChoice[]);
            else onSkills(value as SkillChoice[]);
            onClose();
          }}
        />
      )}
    </ThreadTools>
  );
}
