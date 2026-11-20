use crate::state::hash;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::collections::HashSet;

pub(super) struct NativePlugin {
    id: String,
    pub(super) choice: Value,
    selector: Value,
}

pub(super) fn catalog(
    thread: &str,
    workspaces: &[Value],
    data: &Value,
) -> Result<Vec<NativePlugin>> {
    if data["plugins"].is_null() {
        return Ok(Vec::new());
    }
    let plugins = data["plugins"]
        .as_array()
        .context("Antigravity 插件目录格式不兼容")?;
    ensure!(plugins.len() <= 2048, "Antigravity 插件目录过大");
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for plugin in plugins {
        if plugin["disabled"] == true
            || plugin["forceDisabled"] == true
            || (plugin["authRequired"] == true && plugin["isAuthenticated"] != true)
        {
            continue;
        }
        let Some(name) = plugin["name"].as_str().filter(|name| {
            !name.trim().is_empty() && name.len() <= 512 && !name.chars().any(char::is_control)
        }) else {
            continue;
        };
        let Some(path) = plugin["path"].as_str().filter(|path| {
            !path.is_empty() && path.len() <= 16_384 && !path.chars().any(char::is_control)
        }) else {
            continue;
        };
        let mut selector = json!({"name":name,"path":path});
        for key in ["displayName", "logo"] {
            if let Some(value) = plugin[key].as_str() {
                selector[key] = json!(value);
            }
        }
        if serde_json::to_vec(&selector)?.len() > 64 * 1024 {
            continue;
        }
        let id = hash(&json!(["antigravity-plugin", thread, workspaces, selector]).to_string());
        if !seen.insert(id.clone()) {
            continue;
        }
        let display = plugin["displayName"]
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty() && !name.chars().any(char::is_control))
            .unwrap_or(name);
        let description: String = plugin["description"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(512)
            .collect();
        let display: String = display.chars().take(200).collect();
        result.push(NativePlugin {
            choice: json!({"id":id,"name":display,"description":description}),
            id,
            selector,
        });
    }
    Ok(result)
}

pub(super) fn selected(catalog: &[NativePlugin], ids: &[String]) -> Result<Vec<Value>> {
    ids.iter()
        .map(|id| {
            let plugin = catalog
                .iter()
                .find(|plugin| plugin.id == *id)
                .context("所选插件已失效")?;
            Ok(json!({"item":{"plugin":plugin.selector}}))
        })
        .collect()
}
