import { shallowRef, useId } from 'vue';
import { Icon } from '../Icon';
import { tsxComponent } from '../tsx-component';

const preference = 'pocket-workbench-sidebar-collapsed';

function savedCollapse() {
  try {
    return localStorage.getItem(preference) === 'true';
  } catch {
    return false;
  }
}

export function useWorkbenchSidebar() {
  const id = useId();
  const collapsed = shallowRef(savedCollapse());
  function toggle() {
    collapsed.value = !collapsed.value;
    try {
      localStorage.setItem(preference, String(collapsed.value));
    } catch {
      // The layout can still be changed for the current visit.
    }
  }
  return { id, collapsed, toggle };
}

export const WorkbenchSidebarToggle = tsxComponent(function WorkbenchSidebarToggle(_props: {
  sidebarId: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return ({ sidebarId, collapsed, onToggle }) => {
    const label = collapsed ? '展开工作台' : '收起工作台';
    return (
      <button
        type="button"
        class="icon-button workbench-sidebar-toggle"
        aria-controls={sidebarId}
        aria-expanded={!collapsed}
        aria-label={label}
        title={label}
        onClick={onToggle}
      >
        <Icon name="panelLeft" size={20} />
      </button>
    );
  };
});
