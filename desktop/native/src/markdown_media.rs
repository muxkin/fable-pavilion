use crate::history_media::{MissingAttachment, Source};
use anyhow::{Context, Result, ensure};
use pulldown_cmark::{Event, Parser, Tag};
use regex::Regex;
use std::{
    collections::HashSet,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use url::Url;

pub(crate) const MAX_MARKDOWN_BYTES: u64 = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

pub(crate) fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

pub(crate) fn is_markdown_reference(reference: &str) -> bool {
    let trimmed = strip_query_and_fragment(reference.trim());
    let path = Path::new(trimmed);
    is_markdown_path(path)
}

fn strip_query_and_fragment(raw: &str) -> &str {
    let end = raw.find(['?', '#']).unwrap_or(raw.len());
    &raw[..end]
}

fn is_external_url(raw: &str) -> bool {
    let lower = raw.trim().to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("//")
}

pub(crate) fn extract_html_img_srcs(html: &str) -> Vec<String> {
    static IMG_TAG: OnceLock<Regex> = OnceLock::new();
    static SRC_ATTR: OnceLock<Regex> = OnceLock::new();
    let img_tag = IMG_TAG.get_or_init(|| Regex::new(r"(?is)<img\b[^>]*>").unwrap());
    let src_attr = SRC_ATTR.get_or_init(|| {
        Regex::new(r#"(?is)\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#).unwrap()
    });
    let mut results = Vec::new();
    for tag in img_tag.find_iter(html) {
        if let Some(cap) = src_attr.captures(tag.as_str()) {
            let value = cap
                .get(1)
                .or_else(|| cap.get(2))
                .or_else(|| cap.get(3))
                .map(|m| m.as_str().trim())
                .unwrap_or_default();
            if !value.is_empty() && !is_external_url(value) {
                results.push(value.to_owned());
            }
        }
    }
    results
}

/// Extracts local image references from a Markdown document, covering standard
/// `![alt](url)`, reference-style `![alt][id]` + `[id]: url`, and HTML `<img src="...">`.
pub(crate) fn extract_markdown_image_refs(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut refs = Vec::new();
    let mut push = |raw: String| {
        let trimmed = raw.trim().to_owned();
        if !trimmed.is_empty() && !is_external_url(&trimmed) && seen.insert(trimmed.clone()) {
            refs.push(trimmed);
        }
    };
    for event in Parser::new(content) {
        match event {
            Event::Start(Tag::Image { dest_url, .. }) => {
                push(dest_url.to_string());
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                for src in extract_html_img_srcs(&html) {
                    push(src);
                }
            }
            _ => {}
        }
    }
    refs
}

pub(crate) fn is_sensitive_path(path: &Path) -> bool {
    let mut components = Vec::new();
    for component in path.components() {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        components.push(value);
    }
    if components.iter().any(|part| {
        matches!(
            part.as_str(),
            ".ssh" | ".gnupg" | ".aws" | ".kube" | "native-uploads"
        )
    }) {
        return true;
    }
    let Some(name) = components.last() else {
        return true;
    };
    if matches!(
        name.as_str(),
        ".env"
            | "id_rsa"
            | "id_ed25519"
            | "id_ecdsa"
            | "id_dsa"
            | "authorized_keys"
            | "known_hosts"
            | "shadow"
            | "passwd"
            | ".netrc"
            | ".npmrc"
            | ".pypirc"
            | "credentials"
            | "credentials.json"
            | "secrets.json"
            | "secrets.yaml"
            | "secrets.yml"
    ) || name.starts_with(".env.")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
    {
        return true;
    }
    false
}

pub(crate) fn is_safe_image_bytes(name_or_path: &Path, header: &[u8]) -> bool {
    let ext = name_or_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "ico" | "svg"
    ) {
        return false;
    }
    if header.len() >= 8 && &header[..8] == b"\x89PNG\r\n\x1a\n" {
        return true;
    }
    if header.len() >= 3 && &header[..3] == b"\xff\xd8\xff" {
        return true;
    }
    if header.len() >= 6 && (&header[..6] == b"GIF87a" || &header[..6] == b"GIF89a") {
        return true;
    }
    if header.len() >= 12 && &header[..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        return true;
    }
    if header.len() >= 2 && &header[..2] == b"BM" {
        return true;
    }
    if header.len() >= 4 && &header[..4] == b"\x00\x00\x01\x00" {
        return true;
    }
    if header.len() >= 12 && &header[4..8] == b"ftyp" {
        let brand = &header[8..12];
        if matches!(brand, b"avif" | b"avis" | b"mif1" | b"msf1") {
            return true;
        }
    }
    if ext == "svg" && !header.contains(&0) {
        if let Ok(text) = std::str::from_utf8(header) {
            let trimmed = text.trim_start_matches('\u{feff}').trim_start();
            let lower = trimmed.to_ascii_lowercase();
            if lower.starts_with("<svg")
                || (lower.starts_with("<?xml") && lower.contains("<svg"))
                || (lower.starts_with("<!--") && lower.contains("<svg"))
            {
                return true;
            }
        }
    }
    false
}

pub(crate) fn is_safe_image_file(path: &Path) -> Result<bool> {
    let mut file = File::open(path)?;
    let mut header = [0u8; 1024];
    let read = file.read(&mut header)?;
    Ok(is_safe_image_bytes(path, &header[..read]))
}

pub(crate) fn parse_local_reference(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || is_external_url(trimmed) {
        return None;
    }
    let without_sandbox = trimmed.strip_prefix("sandbox:").unwrap_or(trimmed);
    if without_sandbox.starts_with("file:") {
        let url = Url::parse(without_sandbox).ok()?;
        if url.host_str().is_some_and(|h| h != "localhost") {
            return None;
        }
        return url.to_file_path().ok();
    }
    let stripped = strip_query_and_fragment(without_sandbox);
    let decoded = percent_encoding::percent_decode_str(stripped)
        .decode_utf8()
        .ok()?;
    let value = decoded.as_ref();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    let path = Path::new(value);
    if !path.is_absolute() && value.contains(':') {
        return None;
    }
    Some(path.to_path_buf())
}

fn resolve_candidate(base_dir: &Path, reference: &str) -> Option<PathBuf> {
    let parsed = parse_local_reference(reference)?;
    let joined = if parsed.is_absolute() {
        parsed
    } else {
        base_dir.join(parsed)
    };
    joined.canonicalize().ok()
}

/// Resolves a local image referenced by an already-authorized Markdown document (1-hop only).
/// Enforces 4 invariants:
/// 1. `doc_path` is a Markdown file and readable within `MAX_MARKDOWN_BYTES`.
/// 2. `requested_ref` canonicalizes to a path explicitly referenced as an image inside `doc_path`.
/// 3. The canonical image path stays inside `allowed_roots` and is not a sensitive path.
/// 4. The file is a regular image file matching safe image magic bytes.
pub(crate) fn resolve_document_image(
    doc_path: &Path,
    requested_ref: &str,
    allowed_roots: &[PathBuf],
) -> Result<Source> {
    ensure!(is_markdown_path(doc_path), "仅支持从 Markdown 文档解析关联图片");
    let canonical_doc = doc_path.canonicalize().map_err(|_| MissingAttachment)?;
    let doc_dir = canonical_doc
        .parent()
        .context("无法确定 Markdown 文档目录")?;

    let mut canonical_roots: Vec<PathBuf> = allowed_roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .collect();
    ensure!(!canonical_roots.is_empty(), "当前会话缺少允许访问的根目录");
    canonical_roots.sort();
    canonical_roots.dedup();

    let requested_canon = resolve_candidate(doc_dir, requested_ref)
        .or_else(|| {
            canonical_roots
                .iter()
                .find_map(|root| resolve_candidate(root, requested_ref))
        })
        .ok_or(MissingAttachment)?;

    ensure!(
        canonical_roots
            .iter()
            .any(|root| requested_canon.starts_with(root)),
        "Markdown 引用的图片超出当前会话允许的目录范围"
    );
    ensure!(
        !is_sensitive_path(&requested_canon),
        "敏感文件不允许访问"
    );

    let doc_file = File::open(&canonical_doc).map_err(|_| MissingAttachment)?;
    let doc_meta = doc_file.metadata()?;
    ensure!(
        doc_meta.is_file() && doc_meta.len() <= MAX_MARKDOWN_BYTES,
        "Markdown 文档过大，无法解析关联图片"
    );
    let mut doc_bytes = Vec::new();
    doc_file
        .take(MAX_MARKDOWN_BYTES + 1)
        .read_to_end(&mut doc_bytes)?;
    ensure!(
        doc_bytes.len() as u64 <= MAX_MARKDOWN_BYTES,
        "Markdown 文档过大，无法解析关联图片"
    );
    let content = String::from_utf8(doc_bytes).context("Markdown 文档不是有效的 UTF-8 文本")?;

    let refs = extract_markdown_image_refs(&content);
    let referenced = refs.iter().any(|img_ref| {
        resolve_candidate(doc_dir, img_ref)
            .or_else(|| {
                canonical_roots
                    .iter()
                    .find_map(|root| resolve_candidate(root, img_ref))
            })
            .is_some_and(|candidate| candidate == requested_canon)
    });
    ensure!(referenced, "图片未在当前 Markdown 文档中引用");

    let file = File::open(&requested_canon).map_err(|_| MissingAttachment)?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && (1..=MAX_IMAGE_BYTES).contains(&meta.len()),
        "图片文件尺寸无效"
    );
    ensure!(
        is_safe_image_file(&requested_canon)?,
        "Markdown 关联引用仅允许图片文件"
    );
    let name = requested_canon
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty() && !matches!(*n, "." | ".."))
        .unwrap_or("image")
        .to_owned();
    Ok(Source {
        file,
        name,
        expected: None,
    })
}

/// Resolves a Markdown-referenced image path using virtual POSIX/Windows paths (for remote-API backends like DSH).
pub(crate) fn match_document_image_virtual(
    doc_content: &str,
    doc_path: &str,
    requested_ref: &str,
    normalize: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    let doc_dir = doc_path
        .rsplit_once(['/', '\\'])
        .map(|(dir, _)| if dir.is_empty() { "/" } else { dir })
        .unwrap_or(".");
    let resolve_ref = |raw: &str| -> Option<String> {
        let parsed = parse_local_reference(raw)?;
        let candidate = if parsed.is_absolute() {
            parsed.to_string_lossy().into_owned()
        } else {
            format!("{}/{}", doc_dir.trim_end_matches(['/', '\\']), parsed.to_string_lossy())
        };
        normalize(&candidate)
    };
    let requested = resolve_ref(requested_ref).or_else(|| normalize(requested_ref))?;
    let refs = extract_markdown_image_refs(doc_content);
    let matched = refs
        .iter()
        .any(|img_ref| resolve_ref(img_ref).is_some_and(|p| p == requested));
    if !matched {
        return None;
    }
    if is_sensitive_path(Path::new(&requested)) {
        return None;
    }
    Some(requested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    const TINY_PNG: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde";

    #[test]
    fn extracts_markdown_reference_and_html_images() {
        let md = r#"
# Report
![fig1](./figs/loss.png)
![fig2](plots/acc%20chart.png)
![fig3][ref-img]
<img src="../assets/arch.svg" width="400" />
![remote](https://example.com/a.png)

[ref-img]: ./figs/ref.jpg
"#;
        let refs = extract_markdown_image_refs(md);
        assert!(refs.contains(&"./figs/loss.png".to_owned()));
        assert!(refs.contains(&"plots/acc%20chart.png".to_owned()));
        assert!(refs.contains(&"./figs/ref.jpg".to_owned()));
        assert!(refs.contains(&"../assets/arch.svg".to_owned()));
        assert!(!refs.iter().any(|r| r.contains("example.com")));
    }

    #[test]
    fn resolves_relative_and_parent_image_within_allowed_roots() -> Result<()> {
        let root = tempdir()?;
        let docs = root.path().join("docs");
        let assets = root.path().join("assets");
        std::fs::create_dir_all(&docs)?;
        std::fs::create_dir_all(&assets)?;

        let img = assets.join("chart 1.png");
        File::create(&img)?.write_all(TINY_PNG)?;

        let unreferenced = assets.join("other.png");
        File::create(&unreferenced)?.write_all(TINY_PNG)?;

        let secret = assets.join(".env.png");
        File::create(&secret)?.write_all(TINY_PNG)?;

        let text_as_png = assets.join("fake.png");
        File::create(&text_as_png)?.write_all(b"not really a png")?;

        let md = docs.join("report.md");
        File::create(&md)?.write_all(
            b"# Title\n![c](../assets/chart%201.png)\n![f](../assets/fake.png)\n![s](../assets/.env.png)\n",
        )?;

        let source = resolve_document_image(
            &md,
            &img.to_string_lossy(),
            &[root.path().to_path_buf()],
        )?;
        assert_eq!(source.name, "chart 1.png");

        // Relative request also resolves cleanly
        let source_rel = resolve_document_image(
            &md,
            "../assets/chart%201.png",
            &[root.path().to_path_buf()],
        )?;
        assert_eq!(source_rel.name, "chart 1.png");

        // Unreferenced image in same folder is rejected
        assert!(
            resolve_document_image(
                &md,
                &unreferenced.to_string_lossy(),
                &[root.path().to_path_buf()],
            )
            .is_err()
        );

        // Non-image content disguised as .png is rejected
        assert!(
            resolve_document_image(
                &md,
                &text_as_png.to_string_lossy(),
                &[root.path().to_path_buf()],
            )
            .is_err()
        );

        // Sensitive filename is rejected
        assert!(
            resolve_document_image(
                &md,
                &secret.to_string_lossy(),
                &[root.path().to_path_buf()],
            )
            .is_err()
        );

        // Escaping outside allowed_roots is rejected
        let outside = tempdir()?;
        let outside_img = outside.path().join("escape.png");
        File::create(&outside_img)?.write_all(TINY_PNG)?;
        let escape_md = docs.join("escape.md");
        File::create(&escape_md)?.write_all(
            format!("![x]({})", outside_img.to_string_lossy()).as_bytes(),
        )?;
        assert!(
            resolve_document_image(
                &escape_md,
                &outside_img.to_string_lossy(),
                &[root.path().to_path_buf()],
            )
            .is_err()
        );
        Ok(())
    }
}
