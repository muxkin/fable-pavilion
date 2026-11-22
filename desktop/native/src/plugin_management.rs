use crate::{
    codex_backend,
    migration::GatewayEnvironment,
    plugin_catalog::Catalog,
    plugins::{Instance, Registry, valid_instance_id},
    state::{private_directory, private_file},
    terminal::{self, TerminalService, TerminalSettings},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};
use uuid::Uuid;

const SETTINGS_FILE: &str = "plugin-settings.json";
const INSTANCES_FILE: &str = "instances.json";

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginSettings {
    #[serde(default)]
    pub terminal: TerminalSettings,
}

impl PluginSettings {
    pub(crate) fn load(directory: &Path) -> Result<Self> {
        let path = directory.join(SETTINGS_FILE);
        if !path.exists() {
            return Ok(Self::default());
        }
        let mut bytes = Vec::new();
        private_file(&path, false)?
            .take(64 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 64 * 1024, "插件设置文件过大");
        let mut settings: Self = serde_json::from_slice(&bytes).context("插件设置文件无效")?;
        settings.terminal = settings.terminal.sanitized();
        Ok(settings)
    }

    pub(crate) fn save(&self, directory: &Path) -> Result<()> {
        private_directory(directory)?;
        let path = directory.join(SETTINGS_FILE);
        write_private_json(&path, self)
    }
}

#[derive(Clone)]
pub struct PluginManager {
    inner: Arc<PluginManagerInner>,
}

struct PluginManagerInner {
    directory: PathBuf,
    environment: GatewayEnvironment,
    bundled: bool,
    runtime: Option<tokio::runtime::Handle>,
    registry: Registry,
    codex: codex_backend::Group,
    terminal: Arc<TerminalService>,
    settings: RwLock<PluginSettings>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateBuiltinRequest {
    pub id: String,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub config: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpsertInstanceRequest {
    pub id: String,
    pub name: String,
    pub plugin: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub config: Value,
    #[serde(default)]
    pub secrets: HashMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToggleInstanceRequest {
    pub id: String,
    pub enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SwitchInstanceRequest {
    pub instance: String,
    #[serde(default)]
    pub target: Option<String>,
}

fn default_true() -> bool {
    true
}

impl PluginManager {
    pub(crate) fn new(
        directory: PathBuf,
        environment: GatewayEnvironment,
        bundled: bool,
        runtime: Option<tokio::runtime::Handle>,
        registry: Registry,
        codex: codex_backend::Group,
        terminal: Arc<TerminalService>,
        settings: PluginSettings,
    ) -> Self {
        Self {
            inner: Arc::new(PluginManagerInner {
                directory,
                environment,
                bundled,
                runtime,
                registry,
                codex,
                terminal,
                settings: RwLock::new(settings),
            }),
        }
    }

    pub(crate) async fn snapshot(&self) -> Result<Value> {
        let settings = self
            .inner
            .settings
            .read()
            .expect("plugin settings lock")
            .clone();
        let (packages, bindings) = Catalog::open(&self.inner.directory)
            .and_then(|catalog| catalog.list_detailed())
            .unwrap_or_else(|_| (Vec::new(), HashMap::new()));

        let configured = read_editable_instances(&self.inner.directory)?;
        let mut instances = Vec::new();
        let mut seen_ids = HashSet::new();

        // Always surface built-in codex-local first if present in runtime or bindings.
        let codex_local_cfg = configured.iter().find(|item| item.id == codex_backend::ID);
        let (codex_current, codex_prev) = bindings
            .get(codex_backend::ID)
            .cloned()
            .unwrap_or((String::new(), None));
        instances.push(json!({
            "id": codex_backend::ID,
            "name": codex_local_cfg.map(|c| c.name.as_str()).unwrap_or("Codex"),
            "plugin": codex_backend::PACKAGE,
            "version": codex_local_cfg.and_then(|c| c.version.clone()),
            "enabled": codex_local_cfg.map(|c| c.enabled).unwrap_or(true),
            "connected": self.inner.codex.get(codex_backend::ID).is_some(),
            "builtin": true,
            "editable": false,
            "currentPackage": (!codex_current.is_empty()).then_some(codex_current),
            "previousPackage": codex_prev,
            "config": codex_local_cfg.map(|c| c.config.clone()).unwrap_or_else(|| json!({})),
            "secrets": codex_local_cfg.map(|c| c.secrets.clone()).unwrap_or_default(),
        }));
        seen_ids.insert(codex_backend::ID.to_owned());

        for item in configured {
            if !seen_ids.insert(item.id.clone()) {
                continue;
            }
            let connected = if item.plugin == codex_backend::PACKAGE {
                self.inner.codex.get(&item.id).is_some()
            } else if let Some(adapter) = self.inner.registry.get(&item.id) {
                adapter.info().await["connected"] == true
            } else {
                false
            };
            let (current, previous) = bindings
                .get(&item.id)
                .cloned()
                .map(|(c, p)| (Some(c), p))
                .unwrap_or((None, None));
            instances.push(json!({
                "id": item.id,
                "name": item.name,
                "plugin": item.plugin,
                "version": item.version,
                "enabled": item.enabled,
                "connected": connected,
                "builtin": false,
                "editable": true,
                "currentPackage": current,
                "previousPackage": previous,
                "config": item.config,
                "secrets": item.secrets,
            }));
        }

        // Include auto-discovered runtime plugins (e.g. antigravity-local) not explicitly listed in instances.json.
        for info in self.inner.registry.infos().await {
            let Some(id) = info["id"].as_str() else { continue };
            if !seen_ids.insert(id.to_owned()) {
                continue;
            }
            let (current, previous) = bindings
                .get(id)
                .cloned()
                .map(|(c, p)| (Some(c), p))
                .unwrap_or((None, None));
            let plugin_name = current
                .as_deref()
                .and_then(|key| key.rsplit_once('@').map(|(name, _)| name))
                .unwrap_or_else(|| info["product"].as_str().unwrap_or("unknown"));
            instances.push(json!({
                "id": id,
                "name": info["name"].as_str().unwrap_or(id),
                "plugin": plugin_name,
                "version": Value::Null,
                "enabled": true,
                "connected": info["connected"] == true,
                "builtin": true,
                "editable": false,
                "currentPackage": current,
                "previousPackage": previous,
                "config": json!({}),
                "secrets": json!({}),
            }));
        }

        let terminal_features = if cfg!(windows) {
            vec![
                "Windows ConPTY",
                "PowerShell / CMD / Git Bash / WSL",
                "lrzsz (ZMODEM)",
                "trzsz",
                "内联图片 (Sixel / iTerm2 / Kitty)",
                "剪贴板图片上传",
                "OSC 52 剪贴板",
                "X11 / 端口转发",
            ]
        } else {
            vec![
                "POSIX PTY",
                "lrzsz (ZMODEM)",
                "trzsz",
                "内联图片 (Sixel / iTerm2 / Kitty)",
                "剪贴板图片上传",
                "OSC 52 剪贴板",
                "X11 / Wayland / 端口转发",
            ]
        };

        let builtins = vec![json!({
            "id": "terminal",
            "packageName": terminal::PACKAGE_NAME,
            "name": "终端",
            "description": "在当前电脑上开启交互式终端，支持 lrzsz、trzsz 文件传输、内联图片显示、剪贴板上传图片、OSC 52 与 X11/Wayland/端口转发。",
            "product": terminal::PRODUCT,
            "defaultEnabled": false,
            "enabled": settings.terminal.enabled,
            "configurable": true,
            "features": terminal_features,
            "config": settings.terminal,
            "hostCapabilities": self.inner.terminal.capabilities(),
        })];

        Ok(json!({
            "platform": terminal::current_platform(),
            "builtins": builtins,
            "packages": packages,
            "instances": instances,
            "availableShells": terminal::available_shells(),
        }))
    }

    pub(crate) async fn update_builtin(&self, payload: Value) -> Result<Value> {
        let req: UpdateBuiltinRequest = serde_json::from_value(payload).context("内置插件参数无效")?;
        ensure!(req.id == "terminal", "未知的内置插件: {}", req.id);
        let updated_terminal = {
            let mut settings = self.inner.settings.write().expect("plugin settings lock");
            let mut next = settings.terminal.clone();
            if let Some(cfg) = req.config {
                let mut merged = serde_json::to_value(&next)?;
                if let (Some(base), Some(patch)) = (merged.as_object_mut(), cfg.as_object()) {
                    for (k, v) in patch {
                        base.insert(k.clone(), v.clone());
                    }
                }
                next = serde_json::from_value(merged).context("终端插件配置无效")?;
            }
            if let Some(enabled) = req.enabled {
                next.enabled = enabled;
            }
            next = next.sanitized();
            settings.terminal = next.clone();
            settings.save(&self.inner.directory)?;
            next
        };
        self.inner.terminal.update_settings(updated_terminal);
        self.snapshot().await
    }

    pub(crate) async fn upsert_instance(&self, payload: Value) -> Result<Value> {
        let req: UpsertInstanceRequest = serde_json::from_value(payload).context("插件实例参数无效")?;
        let id = req.id.trim().to_owned();
        let name = req.name.trim().to_owned();
        let plugin = req.plugin.trim().to_owned();
        ensure!(valid_instance_id(&id), "实例 ID 仅支持字母、数字、下划线和连字符（1-80 字符）");
        ensure!((1..=160).contains(&name.len()), "实例名称长度为 1-160 字符");
        ensure!(valid_package_name(&plugin), "插件包名无效");
        ensure!(
            id != codex_backend::ID || plugin == codex_backend::PACKAGE,
            "默认 Codex 实例只能使用官方 Codex 插件"
        );
        ensure!(
            req.config.is_null() || req.config.is_object(),
            "实例 config 必须是 JSON 对象"
        );
        for (secret_key, env_var) in &req.secrets {
            ensure!(!secret_key.trim().is_empty() && secret_key.len() <= 80, "凭据键名无效");
            ensure!(
                !env_var.is_empty()
                    && env_var.len() <= 128
                    && env_var
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_'),
                "凭据环境变量名无效: {env_var}"
            );
        }
        let version = req
            .version
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned);
        let config = if req.config.is_null() {
            json!({})
        } else {
            req.config
        };

        let instance = Instance {
            id: id.clone(),
            name,
            plugin: plugin.clone(),
            version,
            enabled: req.enabled,
            config,
            secrets: req.secrets,
        };

        let mut rows = read_editable_instances(&self.inner.directory)?;
        if let Some(existing) = rows.iter_mut().find(|item| item.id == id) {
            *existing = instance.clone();
        } else {
            ensure!(rows.len() < 32, "插件实例数量已达上限（32）");
            rows.push(instance.clone());
        }
        write_editable_instances(&self.inner.directory, &rows)?;

        let mut restart_recommended = false;
        if plugin == codex_backend::PACKAGE {
            restart_recommended = true;
        } else {
            self.inner.registry.remove(&id);
            if instance.enabled
                && let Some(runtime) = &self.inner.runtime
            {
                let _ = self.inner.registry.spawn_plugin_instance(
                    &self.inner.directory,
                    runtime,
                    self.inner.bundled,
                    &self.inner.environment,
                    instance,
                );
            }
        }

        let mut snap = self.snapshot().await?;
        snap["restartRecommended"] = json!(restart_recommended);
        Ok(snap)
    }

    pub(crate) async fn toggle_instance(&self, payload: Value) -> Result<Value> {
        let req: ToggleInstanceRequest = serde_json::from_value(payload).context("切换参数无效")?;
        ensure!(req.id != codex_backend::ID, "默认 Codex 实例不可直接禁用");
        let mut rows = read_editable_instances(&self.inner.directory)?;
        let item = rows
            .iter_mut()
            .find(|item| item.id == req.id)
            .context("找不到该插件实例")?;
        item.enabled = req.enabled;
        let updated = item.clone();
        write_editable_instances(&self.inner.directory, &rows)?;

        let restart_recommended = updated.plugin == codex_backend::PACKAGE;
        if !restart_recommended {
            self.inner.registry.remove(&updated.id);
            if updated.enabled
                && let Some(runtime) = &self.inner.runtime
            {
                let _ = self.inner.registry.spawn_plugin_instance(
                    &self.inner.directory,
                    runtime,
                    self.inner.bundled,
                    &self.inner.environment,
                    updated,
                );
            }
        }
        let mut snap = self.snapshot().await?;
        snap["restartRecommended"] = json!(restart_recommended);
        Ok(snap)
    }

    pub(crate) async fn delete_instance(&self, id: &str) -> Result<Value> {
        ensure!(id != codex_backend::ID, "默认 Codex 实例不可删除");
        let mut rows = read_editable_instances(&self.inner.directory)?;
        let before = rows.len();
        rows.retain(|item| item.id != id);
        ensure!(rows.len() != before, "找不到该插件实例");
        write_editable_instances(&self.inner.directory, &rows)?;
        self.inner.registry.remove(id);
        self.snapshot().await
    }

    pub(crate) async fn install_local_package(&self, source_dir: &str) -> Result<Value> {
        let trimmed = source_dir.trim();
        ensure!(!trimmed.is_empty(), "请输入插件目录路径");
        let source = PathBuf::from(trimmed);
        ensure!(source.is_dir(), "插件目录不存在: {trimmed}");
        let mut catalog = Catalog::open(&self.inner.directory)?;
        let installed = catalog.install(&source).await?;
        let mut snap = self.snapshot().await?;
        snap["installed"] = json!(installed);
        Ok(snap)
    }

    pub(crate) async fn switch_instance(&self, payload: Value) -> Result<Value> {
        let req: SwitchInstanceRequest = serde_json::from_value(payload).context("切换版本参数无效")?;
        let mut catalog = Catalog::open(&self.inner.directory)?;
        let (request_id, target) = catalog.queue(&req.instance, req.target.as_deref())?;
        let mut snap = self.snapshot().await?;
        snap["switchRequest"] = json!({
            "requestId": request_id,
            "instance": req.instance,
            "target": target,
        });
        Ok(snap)
    }
}

fn valid_package_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 160 {
        return false;
    }
    let segment = |value: &str| {
        !value.is_empty()
            && value.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'-' | b'_' | b'.')
            })
    };
    if let Some(scoped) = name.strip_prefix('@') {
        scoped
            .split_once('/')
            .is_some_and(|(scope, pkg)| segment(scope) && segment(pkg))
    } else {
        segment(name)
    }
}

fn read_editable_instances(directory: &Path) -> Result<Vec<Instance>> {
    let path = directory.join(INSTANCES_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut bytes = Vec::new();
    private_file(&path, false)?
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 128 * 1024, "插件实例配置过大");
    let rows: Vec<Value> = serde_json::from_slice(&bytes).context("插件实例配置无效")?;
    let mut instances = Vec::new();
    for row in rows {
        if let Ok(instance) = serde_json::from_value::<Instance>(row.clone()) {
            instances.push(instance);
        } else if row["type"] == "dsh"
            && let (Some(id), Some(name), Some(url), Some(token_env), Some(version)) = (
                row["id"].as_str(),
                row["name"].as_str(),
                row["url"].as_str(),
                row["tokenEnv"].as_str(),
                row["version"].as_str(),
            )
        {
            instances.push(Instance {
                id: id.to_owned(),
                name: name.to_owned(),
                plugin: "@agent-remote/adapter-dsh".to_owned(),
                version: None,
                enabled: true,
                config: json!({"url": url, "version": version}),
                secrets: HashMap::from([("token".to_owned(), token_env.to_owned())]),
            });
        }
    }
    Ok(instances)
}

fn write_editable_instances(directory: &Path, rows: &[Instance]) -> Result<()> {
    private_directory(directory)?;
    let path = directory.join(INSTANCES_FILE);
    write_private_json(&path, rows)
}

fn write_private_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let write_res = (|| -> Result<()> {
        let mut file = private_file(&temporary, true)?;
        let bytes = serde_json::to_vec_pretty(value)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if write_res.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn builtin_terminal_defaults_disabled_and_persists_toggle() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let settings = PluginSettings::load(&state).unwrap();
        assert!(!settings.terminal.enabled);

        let terminal = Arc::new(TerminalService::new(&state, settings.terminal.clone()));
        let manager = PluginManager::new(
            state.clone(),
            GatewayEnvironment::default(),
            false,
            None,
            Registry::default(),
            codex_backend::Group::default(),
            terminal.clone(),
            settings,
        );

        let snap = manager.snapshot().await.unwrap();
        assert_eq!(snap["builtins"][0]["id"], "terminal");
        assert_eq!(snap["builtins"][0]["defaultEnabled"], false);
        assert_eq!(snap["builtins"][0]["enabled"], false);
        assert!(terminal.backend_info().is_none());

        let updated = manager
            .update_builtin(json!({
                "id": "terminal",
                "enabled": true,
                "config": {
                    "allowPortForwarding": true,
                    "maxSessions": 4
                }
            }))
            .await
            .unwrap();
        assert_eq!(updated["builtins"][0]["enabled"], true);
        assert_eq!(updated["builtins"][0]["config"]["allowPortForwarding"], true);
        assert_eq!(updated["builtins"][0]["config"]["maxSessions"], 4);
        assert!(terminal.backend_info().is_some());

        // Reload from disk to verify persistence.
        let reloaded = PluginSettings::load(&state).unwrap();
        assert!(reloaded.terminal.enabled);
        assert!(reloaded.terminal.allow_port_forwarding);
        assert_eq!(reloaded.terminal.max_sessions, 4);
    }

    #[tokio::test]
    async fn custom_plugin_instance_crud_and_codex_protection() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let settings = PluginSettings::default();
        let terminal = Arc::new(TerminalService::new(&state, settings.terminal.clone()));
        let manager = PluginManager::new(
            state,
            GatewayEnvironment::default(),
            false,
            None,
            Registry::default(),
            codex_backend::Group::default(),
            terminal,
            settings,
        );

        let added = manager
            .upsert_instance(json!({
                "id": "my-dsh",
                "name": "测试 DSH",
                "plugin": "@agent-remote/adapter-dsh",
                "enabled": true,
                "config": {"url": "http://127.0.0.1:3080"},
                "secrets": {"token": "MY_DSH_TOKEN"}
            }))
            .await
            .unwrap();
        let found = added["instances"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "my-dsh")
            .unwrap();
        assert_eq!(found["name"], "测试 DSH");
        assert_eq!(found["enabled"], true);

        let toggled = manager
            .toggle_instance(json!({"id": "my-dsh", "enabled": false}))
            .await
            .unwrap();
        let found = toggled["instances"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "my-dsh")
            .unwrap();
        assert_eq!(found["enabled"], false);

        // Cannot delete codex-local.
        assert!(manager.delete_instance(codex_backend::ID).await.is_err());

        let deleted = manager.delete_instance("my-dsh").await.unwrap();
        assert!(
            deleted["instances"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["id"] != "my-dsh")
        );
    }
}
