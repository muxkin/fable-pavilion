use super::{Backend, file_uri_path, messages, summary_value, valid_id};
use crate::history_media::Source;
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    io::{Seek, Write},
    path::{Path, PathBuf},
};

const MAX_REFERENCE_RESULTS: usize = 50;
const MAX_VISITED_ENTRIES: usize = 4000;
const MAX_SEARCH_DEPTH: usize = 8;

fn ignored_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | ".next" | ".nuxt" | "__pycache__" | ".venv"
    ) || name.starts_with('.')
}

fn secret_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env"
        || lower.starts_with(".env.")
        || lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
        || lower.ends_with(".p8")
        || matches!(lower.as_str(), "id_rsa" | "id_ed25519" | ".npmrc" | ".netrc")
}

pub(super) fn list_workspace_files(roots: &[PathBuf], query: &str) -> Vec<Value> {
    let needle = query.trim().to_ascii_lowercase();
    let mut results = Vec::new();
    let mut visited = 0usize;
    for root in roots {
        let Ok(canonical_root) = root.canonicalize() else {
            continue;
        };
        if !canonical_root.is_dir() {
            continue;
        }
        let mut queue = VecDeque::from([(canonical_root.clone(), 0usize)]);
        while let Some((dir, depth)) = queue.pop_front() {
            if results.len() >= MAX_REFERENCE_RESULTS || visited >= MAX_VISITED_ENTRIES {
                return results;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut children: Vec<_> = entries.filter_map(Result::ok).collect();
            children.sort_by_key(|e| e.file_name());
            for entry in children {
                if results.len() >= MAX_REFERENCE_RESULTS || visited >= MAX_VISITED_ENTRIES {
                    return results;
                }
                visited += 1;
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if file_type.is_symlink() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if file_type.is_dir() {
                    if depth < MAX_SEARCH_DEPTH && !ignored_dir(&name) {
                        queue.push_back((entry.path(), depth + 1));
                    }
                    continue;
                }
                if !file_type.is_file() || secret_filename(&name) {
                    continue;
                }
                let entry_path = entry.path();
                let Ok(relative) = entry_path.strip_prefix(&canonical_root) else {
                    continue;
                };
                let rel_str = relative.to_string_lossy().replace('\\', "/");
                if !needle.is_empty() && !rel_str.to_ascii_lowercase().contains(&needle) {
                    continue;
                }
                results.push(json!({"name": name, "path": rel_str}));
            }
        }
    }
    results
}

pub(super) async fn file_references(backend: &Backend, thread: &str, query: &str) -> Result<Value> {
    valid_id(thread)?;
    let uris = backend.conversation_workspaces(thread).await?;
    let roots: Vec<PathBuf> = uris
        .iter()
        .filter_map(|v| v.as_str())
        .filter_map(file_uri_path)
        .map(PathBuf::from)
        .collect();
    let query = query.to_owned();
    let files = tokio::task::spawn_blocking(move || list_workspace_files(&roots, &query)).await?;
    Ok(json!({"files": files}))
}

pub(super) async fn export_session(backend: &Backend, thread: &str) -> Result<Source> {
    valid_id(thread)?;
    let (daemon, summary) = backend.conversation(thread).await?;
    let info = summary_value(thread, &summary);
    let rendered = if let Some(data) = backend.readable_trajectory(&daemon, thread).await? {
        let steps = data["trajectory"]["steps"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        messages(steps, 0, true)
    } else {
        let view = backend.history_view(thread, None).await?.view();
        view.messages.to_vec()
    };
    let document = json!({
        "format": "fable-pavilion-antigravity-export-v1",
        "exportedAt": crate::state::now(),
        "thread": info,
        "messages": rendered,
    });
    let payload = serde_json::to_vec_pretty(&document)?;
    let mut file = tempfile::tempfile().context("无法创建 Antigravity 导出文件")?;
    file.write_all(&payload)?;
    file.rewind()?;
    Ok(Source {
        file,
        name: format!("antigravity-{thread}.json"),
        expected: None,
    })
}

pub(super) fn workspace_roots(uris: &[Value]) -> Vec<PathBuf> {
    uris.iter()
        .filter_map(|v| v.as_str())
        .filter_map(file_uri_path)
        .map(PathBuf::from)
        .collect()
}

pub(super) fn is_secret_path(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        name == ".git" || secret_filename(&name)
    })
}
