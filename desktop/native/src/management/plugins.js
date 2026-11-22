(() => {
  const byId = (id) => document.getElementById(id);
  let snapshot = null;
  let busy = false;

  function setPluginNotice(text = '', error = false) {
    const node = byId('plugins-notice');
    if (!node) return;
    node.hidden = !text;
    node.textContent = text;
    node.dataset.error = String(error);
  }

  async function api(path, body) {
    const apiReq = window.__adapterManagementApi;
    if (!apiReq) throw new Error('管理会话未就绪');
    const res = body === undefined ? await apiReq(path) : await apiReq(path, { method: 'POST', body });
    return res.json();
  }

  function renderPlugins(data) {
    snapshot = data;
    const builtinsBox = byId('plugins-builtins-list');
    const instancesBox = byId('plugins-instances-list');
    const packagesBox = byId('plugins-packages-list');
    const pluginSelect = byId('plugin-instance-package');
    if (!builtinsBox || !instancesBox || !packagesBox) return;

    const terminal = (data.builtins || []).find((item) => item.id === 'terminal');
    if (terminal) {
      const cfg = terminal.config || {};
      const caps = terminal.hostCapabilities || {};
      builtinsBox.replaceChildren();
      const card = document.createElement('article');
      card.className = 'plugin-card';

      const header = document.createElement('div');
      header.className = 'plugin-card-head';
      const copy = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${terminal.name}（内置 · 默认禁用）`;
      const desc = document.createElement('p');
      desc.textContent = terminal.description;
      copy.append(title, desc);

      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'startup-control plugin-toggle';
      const toggleText = document.createElement('span');
      toggleText.textContent = terminal.enabled ? '已启用' : '已禁用';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.setAttribute('role', 'switch');
      toggle.checked = Boolean(terminal.enabled);
      toggle.addEventListener('change', () => {
        void runPluginTask(async () => {
          const next = await api('/api/plugins/builtin', { id: 'terminal', enabled: toggle.checked });
          renderPlugins(next);
          setPluginNotice(toggle.checked ? '终端插件已启用，可在工作台打开终端。' : '终端插件已禁用，所有活动终端已关闭。');
        });
      });
      toggleLabel.append(toggleText, toggle);
      header.append(copy, toggleLabel);
      card.append(header);

      const meta = document.createElement('p');
      meta.className = 'plugin-meta';
      const parts = [
        `PTY: ${caps.ptyBackend === 'conpty' ? 'Windows ConPTY' : 'POSIX PTY'}`,
        caps.x11HostDisplay ? `本机 DISPLAY=${caps.x11HostDisplay}` : 'X11 按会话代理',
      ];
      if (caps.waylandHostDisplay) parts.push(`Wayland=${caps.waylandHostDisplay}`);
      if (caps.hasWsl) parts.push('检测到 WSL');
      meta.textContent = parts.join(' · ');
      card.append(meta);

      const details = document.createElement('details');
      details.className = 'plugin-config-details';
      const summary = document.createElement('summary');
      summary.textContent = '终端高级配置（Shell / 转发 / OSC 52）';
      const form = document.createElement('form');
      form.className = 'plugin-form';

      const shellLabel = document.createElement('label');
      shellLabel.textContent = '默认 Shell（留空自动选择）';
      const shellInput = document.createElement('input');
      shellInput.type = 'text';
      shellInput.value = cfg.defaultShell || '';
      shellInput.placeholder = data.platform === 'windows' ? 'pwsh.exe / powershell.exe / cmd.exe' : '/bin/bash / /bin/zsh';
      shellLabel.append(shellInput);

      const cwdLabel = document.createElement('label');
      cwdLabel.textContent = '默认工作目录（留空使用主目录）';
      const cwdInput = document.createElement('input');
      cwdInput.type = 'text';
      cwdInput.value = cfg.defaultCwd || '';
      cwdLabel.append(cwdInput);

      const maxLabel = document.createElement('label');
      maxLabel.textContent = '最大并发会话数（1-16）';
      const maxInput = document.createElement('input');
      maxInput.type = 'number';
      maxInput.min = '1';
      maxInput.max = '16';
      maxInput.value = String(cfg.maxSessions || 8);
      maxLabel.append(maxInput);

      const makeCheck = (text, checked) => {
        const label = document.createElement('label');
        label.className = 'checkbox';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(checked);
        label.append(input, document.createTextNode(` ${text}`));
        return { label, input };
      };
      const osc52 = makeCheck('允许 OSC 52 剪贴板写入', cfg.allowOsc52Clipboard !== false);
      const x11 = makeCheck('允许 X11 转发', cfg.allowX11Forwarding);
      const wayland = makeCheck('允许 Wayland 转发（Linux / Unix）', cfg.allowWaylandForwarding);
      const portFwd = makeCheck('允许本机回环端口转发', cfg.allowPortForwarding);

      const saveBtn = document.createElement('button');
      saveBtn.type = 'submit';
      saveBtn.textContent = '保存终端设置';

      form.append(shellLabel, cwdLabel, maxLabel, osc52.label, x11.label, wayland.label, portFwd.label, saveBtn);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void runPluginTask(async () => {
          const next = await api('/api/plugins/builtin', {
            id: 'terminal',
            config: {
              defaultShell: shellInput.value.trim(),
              defaultCwd: cwdInput.value.trim(),
              maxSessions: Math.max(1, Math.min(16, Number(maxInput.value) || 8)),
              allowOsc52Clipboard: osc52.input.checked,
              allowX11Forwarding: x11.input.checked,
              allowWaylandForwarding: wayland.input.checked,
              allowPortForwarding: portFwd.input.checked,
            },
          });
          renderPlugins(next);
          setPluginNotice('已保存终端插件设置');
        });
      });
      details.append(summary, form);
      card.append(details);
      builtinsBox.append(card);
    }

    instancesBox.replaceChildren();
    for (const item of data.instances || []) {
      const card = document.createElement('article');
      card.className = 'plugin-card';
      const head = document.createElement('div');
      head.className = 'plugin-card-head';
      const copy = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${item.name} (${item.id})`;
      const meta = document.createElement('p');
      meta.className = 'plugin-meta';
      meta.textContent = `${item.plugin}${item.currentPackage ? ` · ${item.currentPackage}` : ''} · ${item.enabled ? (item.connected ? '在线' : '已启用') : '已禁用'}`;
      copy.append(title, meta);

      const actions = document.createElement('div');
      actions.className = 'plugin-card-actions';
      if (item.editable) {
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.textContent = item.enabled ? '禁用' : '启用';
        toggleBtn.addEventListener('click', () => {
          void runPluginTask(async () => {
            const next = await api('/api/plugins/instances/toggle', { id: item.id, enabled: !item.enabled });
            renderPlugins(next);
            setPluginNotice(`实例 ${item.name} 已${item.enabled ? '禁用' : '启用'}`);
          });
        });

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'danger-action';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', () => {
          if (!window.confirm(`确定删除插件实例「${item.name}」？`)) return;
          void runPluginTask(async () => {
            const next = await api('/api/plugins/instances/delete', { id: item.id });
            renderPlugins(next);
            setPluginNotice(`已删除插件实例 ${item.name}`);
          });
        });
        actions.append(toggleBtn, delBtn);
      }
      if (item.previousPackage) {
        const rbBtn = document.createElement('button');
        rbBtn.type = 'button';
        rbBtn.textContent = '回滚版本';
        rbBtn.addEventListener('click', () => {
          void runPluginTask(async () => {
            const next = await api('/api/plugins/switch', { instance: item.id });
            renderPlugins(next);
            setPluginNotice(`已提交 ${item.id} 回滚请求`);
          });
        });
        actions.append(rbBtn);
      }
      head.append(copy, actions);
      card.append(head);
      instancesBox.append(card);
    }

    packagesBox.replaceChildren();
    if (!data.packages?.length) {
      const empty = document.createElement('p');
      empty.className = 'plugin-meta';
      empty.textContent = '尚未登记额外的本地原生插件包。';
      packagesBox.append(empty);
    } else {
      for (const pkg of data.packages) {
        const row = document.createElement('div');
        row.className = 'plugin-package-row';
        row.textContent = `${pkg.key} · product=${pkg.product}${pkg.official ? ' · 官方' : ' · 自定义'}`;
        packagesBox.append(row);
      }
    }

    if (pluginSelect && pluginSelect.tagName === 'DATALIST') {
      pluginSelect.replaceChildren();
      const names = new Set([
        '@agent-remote/adapter-dsh',
        '@agent-remote/adapter-codex',
        '@agent-remote/adapter-antigravity',
        ...(data.packages || []).map((p) => p.name),
      ]);
      for (const name of names) {
        const option = document.createElement('option');
        option.value = name;
        pluginSelect.append(option);
      }
    }
  }

  async function runPluginTask(fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (error) {
      setPluginNotice(error.message || '插件操作失败', true);
    } finally {
      busy = false;
    }
  }

  async function refreshPlugins() {
    await runPluginTask(async () => {
      const data = await api('/api/plugins');
      renderPlugins(data);
    });
  }

  window.__refreshAdapterPlugins = refreshPlugins;

  const addForm = byId('plugin-add-instance-form');
  if (addForm) {
    addForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void runPluginTask(async () => {
        const id = byId('plugin-instance-id').value.trim();
        const name = byId('plugin-instance-name').value.trim();
        const plugin = byId('plugin-instance-plugin').value.trim();
        const rawConfig = byId('plugin-instance-config').value.trim() || '{}';
        const rawSecrets = byId('plugin-instance-secrets').value.trim() || '{}';
        const config = JSON.parse(rawConfig);
        const secrets = JSON.parse(rawSecrets);
        const next = await api('/api/plugins/instances', {
          id,
          name,
          plugin,
          enabled: true,
          config,
          secrets,
        });
        addForm.reset();
        byId('plugin-instance-config').value = '{}';
        byId('plugin-instance-secrets').value = '{}';
        renderPlugins(next);
        setPluginNotice(next.restartRecommended ? `已保存实例 ${name}（Codex 实例需重启适配器生效）` : `已添加插件实例 ${name}`);
      });
    });
  }

  const installForm = byId('plugin-install-form');
  if (installForm) {
    installForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void runPluginTask(async () => {
        const dir = byId('plugin-install-path').value.trim();
        const next = await api('/api/plugins/install', { path: dir });
        installForm.reset();
        renderPlugins(next);
        setPluginNotice(`已安装本地插件包：${next.installed || dir}`);
      });
    });
  }
})();
