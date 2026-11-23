import { shallowRef, useId } from 'vue';
import type { ControlAction, GoalState } from '../../shared/controls';
import { Icon } from '../Icon';
import { watchRender } from '../render-effects';
import { tsxComponent } from '../tsx-component';
import './goal-controls.css';

const statusLabels: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  usageLimited: '用量受限',
  budgetLimited: '预算已用完',
  complete: '已完成',
};

type GoalAction = Extract<ControlAction, { action: 'goal' }>;
interface GoalDraft {
  goalId?: string;
  previousObjective?: string;
  text: string;
}

function GoalStatus({ phase }: { phase: string }) {
  return (
    <span class="goal-status" data-phase={phase}>
      {statusLabels[phase] ?? phase}
    </span>
  );
}

export function ConversationGoalSummary({
  goal,
  onOpen,
}: {
  goal: GoalState;
  onOpen: (anchor: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      class="conversation-goal-summary"
      aria-label="管理目标"
      aria-haspopup="dialog"
      aria-expanded="false"
      aria-description={`${statusLabels[goal.phase] ?? goal.phase} · ${goal.objective}`}
      title={goal.objective}
      onClick={(event) => onOpen(event.currentTarget as HTMLButtonElement)}
    >
      <Icon name="target" size={18} />
      <span class="conversation-goal-label">目标</span>
      <span class="conversation-goal-objective">{goal.objective}</span>
      <GoalStatus phase={goal.phase} />
      <Icon name="more" size={16} />
    </button>
  );
}

export const GoalControls = tsxComponent(function GoalControls(_props: {
  goal?: GoalState | null;
  writable: boolean;
  disabled: boolean;
  loading: boolean;
  objectiveMaxLength?: number;
  unavailableReason?: string;
  onAction: (action: GoalAction) => void;
}) {
  const objectiveId = useId();
  const edit = shallowRef<GoalDraft>();
  const confirmClear = shallowRef(false);
  const watchGoal = watchRender();
  return ({ goal, writable, disabled, loading, objectiveMaxLength, unavailableReason, onAction }) => {
    const change = edit.value?.goalId === goal?.ref.id ? edit.value : undefined;
    const draft = change?.text ?? goal?.objective ?? '';
    const objective = draft.trim();
    const length = objectiveMaxLength === undefined ? objective.length : [...objective].length;
    const maxLength = objectiveMaxLength ?? 16000;
    const conflict =
      !!change && change.previousObjective !== goal?.objective && objective !== goal?.objective;
    watchGoal(() => {
      if (edit.value && (edit.value.goalId !== goal?.ref.id || edit.value.text.trim() === goal?.objective))
        edit.value = undefined;
      confirmClear.value = false;
    }, [goal?.ref.id, goal?.objective]);

    if (!goal && !writable) {
      return (
        <p class="popover-note">
          {loading ? '正在读取目标…' : (unavailableReason ?? '当前会话未提供目标控制')}
        </p>
      );
    }
    const send = (operation: GoalAction['operation']) => {
      confirmClear.value = false;
      onAction({
        action: 'goal',
        operation,
        ref: goal?.ref,
        ...(['create', 'edit'].includes(operation) ? { objective } : {}),
      });
    };
    const phase = goal?.phase;
    const tokenUsage = goal?.tokensUsed?.toLocaleString();
    const tokenBudget = goal?.tokenBudget?.toLocaleString();
    return (
      <div class="control-form goal-control-form" aria-busy={loading}>
        {goal && (
          <div class="goal-control-state">
            <GoalStatus phase={goal.phase} />
            {goal.activation === 'disarmed' && <span>未自动继续</span>}
            {tokenUsage !== undefined && (
              <span>
                {tokenUsage}
                {tokenBudget ? ` / ${tokenBudget}` : ''} tokens
              </span>
            )}
            {tokenUsage === undefined && tokenBudget && <span>预算 {tokenBudget} tokens</span>}
            {goal.timeUsedSeconds !== undefined && <span>{goal.timeUsedSeconds.toLocaleString()} 秒</span>}
          </div>
        )}
        {writable ? (
          <>
            <label for={objectiveId}>目标内容</label>
            <textarea
              id={objectiveId}
              placeholder="希望这个会话持续完成什么？"
              maxlength={Math.min(16000, objectiveMaxLength ? objectiveMaxLength * 2 : maxLength)}
              value={draft}
              onInput={(event) => {
                edit.value = {
                  goalId: goal?.ref.id,
                  previousObjective: change ? change.previousObjective : goal?.objective,
                  text: (event.currentTarget as HTMLTextAreaElement).value,
                };
              }}
            />
            {length > maxLength && <p class="popover-note">目标最多 {maxLength.toLocaleString()} 个字符。</p>}
            {conflict && (
              <p class="popover-error" role="alert">
                原目标内容已更新。
                <button
                  type="button"
                  onClick={() => {
                    edit.value = undefined;
                  }}
                >
                  读取最新内容
                </button>
              </p>
            )}
            <button
              type="button"
              class="primary"
              disabled={
                disabled || !objective || objective === goal?.objective || length > maxLength || conflict
              }
              onClick={() => send(goal ? 'edit' : 'create')}
            >
              {goal ? '保存修改' : '创建目标'}
            </button>
            {goal && (
              <div class="control-form-actions">
                {phase === 'active' && (
                  <button type="button" disabled={disabled} onClick={() => send('pause')}>
                    暂停
                  </button>
                )}
                {(phase === 'paused' ||
                  phase === 'blocked' ||
                  phase === 'usageLimited' ||
                  phase === 'budgetLimited') && (
                  <button type="button" disabled={disabled} onClick={() => send('resume')}>
                    继续
                  </button>
                )}
                {phase !== 'complete' && (
                  <button type="button" disabled={disabled} onClick={() => send('complete')}>
                    完成
                  </button>
                )}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    confirmClear.value = true;
                  }}
                >
                  清除
                </button>
              </div>
            )}
            {goal && confirmClear.value && (
              <div class="goal-clear-confirm">
                <p>清除这个会话的长期目标？</p>
                <div class="control-form-actions">
                  <button
                    type="button"
                    onClick={() => {
                      confirmClear.value = false;
                    }}
                  >
                    取消
                  </button>
                  <button type="button" class="danger" disabled={disabled} onClick={() => send('clear')}>
                    确认清除
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <p class="goal-readonly-objective">{goal?.objective}</p>
            <p class="popover-note">{unavailableReason ?? '当前会话仅支持查看目标。'}</p>
          </>
        )}
      </div>
    );
  };
});
