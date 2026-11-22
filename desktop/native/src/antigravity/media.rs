use crate::{
    files::{Attachment, BLOCK, VerifiedUpload},
    history_media::{MissingAttachment, Source},
    state::{create_private_file, private_file},
};
use anyhow::{Context, Result, ensure};
use image::ImageFormat;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek},
    path::{Path, PathBuf},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;

const MAX_ATTACHMENTS: usize = 10;
const MAX_IMAGE_BATCH: u64 = 32 * BLOCK as u64;
const MAX_FILE: u64 = 256 * BLOCK as u64;
const REFERENCE: &str = "antigravity-image:";

pub(super) struct StagedUploads {
    _directory: Option<tempfile::TempDir>,
    pub(super) media: Vec<Value>,
    pub(super) files: Vec<Attachment>,
}

fn format(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    match image::guess_format(bytes).ok()? {
        ImageFormat::Png => Some(("image/png", "png")),
        ImageFormat::Jpeg => Some(("image/jpeg", "jpg")),
        ImageFormat::WebP => Some(("image/webp", "webp")),
        ImageFormat::Gif => Some(("image/gif", "gif")),
        _ => None,
    }
}

pub(super) async fn stage_uploads(files: &[VerifiedUpload]) -> Result<StagedUploads> {
    ensure!(files.len() <= MAX_ATTACHMENTS, "每条消息最多 10 个附件");
    let mut directory: Option<tempfile::TempDir> = None;
    let mut remaining_inline = MAX_IMAGE_BATCH;
    let mut media = Vec::new();
    let mut attachments = Vec::new();
    for upload in files {
        ensure!(
            (1..=MAX_FILE).contains(&upload.size),
            "Antigravity 单个附件大小不能超过 256 MiB"
        );
        let mut file = tokio::fs::File::from_std(private_file(&upload.path, false)?);
        ensure!(
            file.metadata().await?.len() == upload.size,
            "附件大小已变化"
        );
        let prefix_len = upload.size.min(16) as usize;
        let mut prefix = [0_u8; 16];
        file.read_exact(&mut prefix[..prefix_len]).await?;
        let inline = format(&prefix[..prefix_len]).filter(|_| upload.size <= remaining_inline);
        if let Some((mime, extension)) = inline {
            let mut bytes = Vec::with_capacity(upload.size as usize);
            bytes.extend_from_slice(&prefix[..prefix_len]);
            file.take(upload.size - prefix_len as u64 + 1)
                .read_to_end(&mut bytes)
                .await?;
            ensure!(
                bytes.len() as u64 == upload.size
                    && format!("{:x}", Sha256::digest(&bytes)) == upload.sha256,
                "附件校验失败"
            );
            remaining_inline -= upload.size;
            let dir = match &directory {
                Some(dir) => dir,
                None => directory.insert(
                    tempfile::Builder::new()
                        .prefix("agent-space-antigravity-")
                        .tempdir()?,
                ),
            };
            // The native service moves this file into the conversation. Preserve
            // the gateway upload and use unique names for different messages.
            let path = dir.path().join(format!("{}.{extension}", Uuid::new_v4()));
            let mut copy = tokio::fs::File::from_std(create_private_file(&path)?);
            copy.write_all(&bytes).await?;
            copy.shutdown().await?;
            media.push(json!({"uri":path,"mimeType":mime,"displayName":upload.name}));
        } else {
            // Stream-verify arbitrary files and videos without buffering up to 256 MiB in RAM.
            let mut hasher = Sha256::new();
            hasher.update(&prefix[..prefix_len]);
            let mut total = prefix_len as u64;
            let mut chunk = vec![0_u8; 64 * 1024];
            let mut reader = file.take(upload.size - prefix_len as u64 + 1);
            loop {
                let count = reader.read(&mut chunk).await?;
                if count == 0 {
                    break;
                }
                total += count as u64;
                ensure!(total <= upload.size, "附件大小已变化");
                hasher.update(&chunk[..count]);
            }
            ensure!(
                total == upload.size && format!("{:x}", hasher.finalize()) == upload.sha256,
                "附件校验失败"
            );
            attachments.push(Attachment {
                name: upload.name.clone(),
                path: upload.path.clone(),
            });
        }
    }
    Ok(StagedUploads {
        _directory: directory,
        media,
        files: attachments,
    })
}

fn image_name(media: &Value) -> Option<String> {
    let extension = match media["mimeType"].as_str()? {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => return None,
    };
    let name = media["displayName"].as_str().filter(|name| {
        (1..=200).contains(&name.encode_utf16().count())
            && !matches!(*name, "." | "..")
            && !name
                .chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\'))
    });
    Some(name.map_or_else(|| format!("照片.{extension}"), str::to_owned))
}

fn image_path(media: &Value) -> Option<PathBuf> {
    let uri = media["uri"].as_str()?;
    let path = if uri.starts_with("file:") {
        url::Url::parse(uri).ok()?.to_file_path().ok()?
    } else {
        PathBuf::from(uri)
    };
    (path.is_absolute() && path.parent()?.file_name()? == ".user_uploaded").then_some(path)
}

pub(super) fn attachments(user: &Value, step: usize) -> Vec<Value> {
    user["media"].as_array().into_iter().flatten().enumerate().take(MAX_ATTACHMENTS)
        .filter_map(|(index, media)| {
            image_path(media)?;
            Some(json!({"name":image_name(media)?,"path":format!("{REFERENCE}{step}:{index}"),"media":"image"}))
        })
        .collect()
}

pub(super) fn reference(value: &str) -> Result<(usize, usize)> {
    let (step, index) = value
        .strip_prefix(REFERENCE)
        .and_then(|id| id.split_once(':'))
        .context("Antigravity 图片引用无效")?;
    let index = index.parse::<usize>()?;
    ensure!(index < MAX_ATTACHMENTS, "Antigravity 图片引用无效");
    Ok((step.parse()?, index))
}

pub(super) fn download(home: &Path, thread: &str, media: &Value) -> Result<Source> {
    let path = image_path(media).ok_or(MissingAttachment)?;
    let name = image_name(media).ok_or(MissingAttachment)?;
    let root = home
        .join("brain")
        .join(thread)
        .join(".user_uploaded")
        .canonicalize()
        .map_err(|_| MissingAttachment)?;
    let canonical = path.canonicalize().map_err(|_| MissingAttachment)?;
    ensure!(
        canonical.parent() == Some(root.as_path()),
        "图片不属于当前 Antigravity 会话"
    );
    let mut file = File::open(&canonical)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && (1..=MAX_IMAGE_BATCH).contains(&metadata.len()),
        "Antigravity 图片尺寸无效"
    );
    let mut signature = [0_u8; 16];
    let count = (&mut file)
        .take(signature.len() as u64)
        .read(&mut signature)?;
    ensure!(
        format(&signature[..count]).is_some_and(|(mime, _)| media["mimeType"] == mime),
        "Antigravity 图片格式无效"
    );
    file.rewind()?;
    Ok(Source {
        file,
        name,
        expected: None,
    })
}

const MAX_CITED_FILE: u64 = 256 * 1024 * 1024;

fn parse_reference_path(reference: &str) -> Option<PathBuf> {
    let trimmed = reference.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return None;
    }
    if trimmed.starts_with("file:") {
        return url::Url::parse(trimmed).ok()?.to_file_path().ok();
    }
    Some(PathBuf::from(trimmed))
}

fn collect_cited_paths(steps: &[Value], workspace_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut cited = Vec::new();
    let mut push_raw = |raw: &str| {
        if let Some(path) = parse_reference_path(raw) {
            if path.is_absolute() {
                if let Ok(canon) = path.canonicalize() {
                    cited.push(canon);
                }
            } else {
                for root in workspace_roots {
                    if let Ok(canon) = root.join(&path).canonicalize() {
                        cited.push(canon);
                    }
                }
            }
        }
    };
    for step in steps {
        if let Some(response) = step.get("plannerResponse") {
            let text = response["modifiedResponse"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or(response["response"].as_str())
                .unwrap_or("");
            for link in crate::history_media::links(text) {
                push_raw(&link);
            }
        }
        for (section, field) in [
            ("viewFile", "absolutePathUri"),
            ("viewFile", "absolutePath"),
            ("writeToFile", "targetFile"),
            ("writeToFile", "targetFileUri"),
            ("replaceFileContent", "targetFile"),
            ("replaceFileContent", "targetFileUri"),
            ("multiReplaceFileContent", "targetFile"),
            ("multiReplaceFileContent", "targetFileUri"),
            ("generateImage", "imagePath"),
            ("generateImage", "outputPath"),
            ("generateImage", "artifactPath"),
            ("generateImage", "imageUri"),
            ("generateImage", "uri"),
        ] {
            if let Some(raw) = step[section][field].as_str() {
                push_raw(raw);
            }
        }
        for key in ["Path", "AbsolutePath", "TargetFile", "FilePath"] {
            if let Some(raw) = step["generic"]["args"][key].as_str() {
                push_raw(raw);
            }
        }
        if let Some(paths) = step["notifyUser"]["pathsToReview"].as_array() {
            for item in paths {
                if let Some(raw) = item.as_str() {
                    push_raw(raw);
                }
            }
        }
    }
    cited
}

pub(super) fn download_cited(
    home: &Path,
    thread: &str,
    workspace_roots: &[PathBuf],
    steps: &[Value],
    reference: &str,
) -> Result<Source> {
    let parsed = parse_reference_path(reference).ok_or(MissingAttachment)?;
    let mut allowed_roots = Vec::new();
    if let Ok(brain) = home.join("brain").join(thread).canonicalize() {
        allowed_roots.push(brain);
    }
    for root in workspace_roots {
        if let Ok(canon) = root.canonicalize() {
            allowed_roots.push(canon);
        }
    }
    let candidate = if parsed.is_absolute() {
        parsed.canonicalize().map_err(|_| MissingAttachment)?
    } else {
        allowed_roots
            .iter()
            .find_map(|root| root.join(&parsed).canonicalize().ok())
            .ok_or(MissingAttachment)?
    };
    ensure!(
        allowed_roots.iter().any(|root| candidate.starts_with(root)),
        "文件不在当前 Antigravity 会话工作区或制品目录内"
    );
    ensure!(
        !super::export::is_secret_path(&candidate),
        "敏感文件不允许下载"
    );
    let cited = collect_cited_paths(steps, workspace_roots);
    ensure!(
        cited.iter().any(|path| path == &candidate),
        "文件未在当前 Antigravity 会话中引用"
    );
    let file = File::open(&candidate).map_err(|_| MissingAttachment)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && (1..=MAX_CITED_FILE).contains(&metadata.len()),
        "Antigravity 文件尺寸无效"
    );
    let name = candidate
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty() && !matches!(*n, "." | ".."))
        .unwrap_or("attachment")
        .to_owned();
    Ok(Source {
        file,
        name,
        expected: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::io::{Cursor, Write};

    fn verified_image(directory: &Path, name: &str, bytes: &[u8]) -> Result<VerifiedUpload> {
        let path = directory.join(name);
        create_private_file(&path)?.write_all(bytes)?;
        Ok(VerifiedUpload {
            name: name.into(),
            path,
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        })
    }

    fn image_bytes(format: ImageFormat) -> Result<Vec<u8>> {
        let image = image::RgbImage::from_pixel(1, 1, image::Rgb([17, 34, 51]));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format)?;
        Ok(bytes.into_inner())
    }

    #[tokio::test]
    async fn stages_verified_copies_and_only_serves_the_current_conversation() -> Result<()> {
        let root = tempfile::tempdir()?;
        let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC")?;
        let mut upload = verified_image(root.path(), "照片.png", &png)?;
        let staged = stage_uploads(&[upload.clone()]).await?;
        assert_eq!(staged.media[0]["mimeType"], "image/png");
        assert_eq!(staged.media[0]["displayName"], upload.name);
        let copy = PathBuf::from(staged.media[0]["uri"].as_str().unwrap());
        let thread = "conversation";
        let directory = root
            .path()
            .join("brain")
            .join(thread)
            .join(".user_uploaded");
        std::fs::create_dir_all(&directory)?;
        let native = directory.join("fixture.png");
        std::fs::write(&native, std::fs::read(&copy)?)?;
        std::fs::remove_file(copy)?;
        assert_eq!(std::fs::read(&upload.path)?, png);
        let metadata = json!({"uri":native,"mimeType":"image/png","displayName":upload.name});
        let user = json!({"media":[metadata]});
        let attachment = &attachments(&user, 17)[0];
        assert_eq!(reference(attachment["path"].as_str().unwrap())?, (17, 0));
        let mut returned = Vec::new();
        download(root.path(), thread, &user["media"][0])?
            .file
            .read_to_end(&mut returned)?;
        assert_eq!(returned, png);
        let other = root
            .path()
            .join("brain")
            .join("other")
            .join(".user_uploaded");
        std::fs::create_dir_all(&other)?;
        assert!(download(root.path(), "other", &user["media"][0]).is_err());
        upload.sha256 = "0".repeat(64);
        assert!(stage_uploads(&[upload]).await.is_err());
        Ok(())
    }

    #[tokio::test]
    async fn stages_and_downloads_supported_formats_up_to_ten_images() -> Result<()> {
        let root = tempfile::tempdir()?;
        let formats = [
            ("png", "image/png", image_bytes(ImageFormat::Png)?),
            ("jpg", "image/jpeg", image_bytes(ImageFormat::Jpeg)?),
            ("webp", "image/webp", image_bytes(ImageFormat::WebP)?),
            (
                "gif",
                "image/gif",
                STANDARD.decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")?,
            ),
        ];
        let uploads = formats
            .iter()
            .map(|(extension, _, bytes)| {
                verified_image(root.path(), &format!("photo.{extension}"), bytes)
            })
            .collect::<Result<Vec<_>>>()?;
        let mut batch = uploads.iter().cycle().take(10).cloned().collect::<Vec<_>>();
        let mut staged = stage_uploads(&batch).await?;
        assert_eq!(staged.media.len(), 10);

        let thread = "conversation";
        let directory = root
            .path()
            .join("brain")
            .join(thread)
            .join(".user_uploaded");
        std::fs::create_dir_all(&directory)?;
        for (media, (extension, mime, bytes)) in staged.media.iter_mut().zip(formats.iter().cycle())
        {
            let source = Path::new(media["uri"].as_str().context("Missing staged image")?);
            assert_eq!(
                source.extension().and_then(|ext| ext.to_str()),
                Some(*extension)
            );
            assert_eq!(media["mimeType"], *mime);
            let native = directory.join(source.file_name().context("Missing staged image name")?);
            std::fs::rename(source, &native)?;
            media["uri"] = json!(native);
            let mut returned = Vec::new();
            download(root.path(), thread, media)?
                .file
                .read_to_end(&mut returned)?;
            assert_eq!(&returned, bytes);
        }
        let photos = attachments(&json!({"media": staged.media}), 5);
        assert_eq!(photos.len(), 10);
        assert_eq!(reference(photos[9]["path"].as_str().unwrap())?, (5, 9));
        assert!(reference("antigravity-image:5:10").is_err());

        batch.push(uploads[0].clone());
        let error = stage_uploads(&batch)
            .await
            .err()
            .context("Eleven attachments staged")?;
        assert_eq!(error.to_string(), "每条消息最多 10 个附件");
        Ok(())
    }

    #[tokio::test]
    async fn spills_oversized_images_and_supports_files_and_videos() -> Result<()> {
        let root = tempfile::tempdir()?;
        let png = image_bytes(ImageFormat::Png)?;
        let small = verified_image(root.path(), "small.png", &png)?;
        // Images up to the combined 32 MiB budget stay inline; larger images fall back to file attachments.
        let mut padded = png;
        padded.resize(32 * 1024 * 1024 - small.size as usize, 0);
        let large = verified_image(root.path(), "large.png", &padded)?;
        let staged = stage_uploads(&[small.clone(), large]).await?;
        assert_eq!(staged.media.len(), 2);
        assert!(staged.files.is_empty());

        padded.push(0);
        let spilled = verified_image(root.path(), "spilled.png", &padded)?;
        let video = verified_image(root.path(), "clip.mp4", b"\x00\x00\x00\x18ftypmp42demo")?;
        let doc = verified_image(root.path(), "report.pdf", b"%PDF-1.7\nhello")?;
        let mixed = stage_uploads(&[small, spilled.clone(), video.clone(), doc.clone()]).await?;
        assert_eq!(mixed.media.len(), 1);
        assert_eq!(mixed.files.len(), 3);
        assert_eq!(mixed.files[0].name, "spilled.png");
        assert_eq!(mixed.files[0].path, spilled.path);
        assert_eq!(mixed.files[1].name, "clip.mp4");
        assert_eq!(mixed.files[1].path, video.path);
        assert_eq!(mixed.files[2].name, "report.pdf");
        assert_eq!(mixed.files[2].path, doc.path);

        let mut tampered = video;
        tampered.sha256 = "0".repeat(64);
        assert!(stage_uploads(&[tampered]).await.is_err());
        Ok(())
    }
}
