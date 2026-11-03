//! The images a user attached to a message, kept under `<data>/run-images/<runId>/`.
use std::path::{Component, Path};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use saturn_llm::ImagePart;
use serde_json::Value;

use crate::CoreError;

/// Images one message may carry.
pub const MAX_IMAGES: usize = 4;
/// Bytes per image, decoded.
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const FOLDER: &str = "run-images";

fn extension(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn mime_type(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn safe(id: &str) -> String {
    id.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

/// The images a request attached, as data URLs or `{ mimeType, base64 }`. Anything else, too many, too large or of another
/// type is refused with a message the user can act on.
pub fn parse_images(raw: Option<&Value>) -> Result<Vec<ImagePart>, CoreError> {
    let items = match raw {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(CoreError::new(400, "images must be a list")),
    };
    if items.len() > MAX_IMAGES {
        return Err(CoreError::new(
            400,
            format!("Attach at most {MAX_IMAGES} images to one message"),
        ));
    }
    let mut images = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let number = index + 1;
        let (mime, data) = match item {
            Value::String(url) => url
                .strip_prefix("data:")
                .and_then(|rest| rest.split_once(";base64,"))
                .map_or((String::new(), String::new()), |(mime, data)| {
                    (mime.to_owned(), data.to_owned())
                }),
            Value::Object(_) => (
                crate::records::text(item, "mimeType").to_owned(),
                crate::records::text(item, "base64").to_owned(),
            ),
            _ => (String::new(), String::new()),
        };
        let data: String = data
            .chars()
            .filter(|character| !saturn_domain::js::is_space(*character))
            .collect();
        if data.is_empty() || STANDARD.decode(&data).is_err() {
            return Err(CoreError::new(
                400,
                format!("Image {number} is not a base64 image"),
            ));
        }
        if extension(&mime).is_none() {
            let named = if mime.is_empty() {
                "of an unknown type"
            } else {
                &mime
            };
            return Err(CoreError::new(
                400,
                format!("Image {number} is {named}; use PNG, JPEG, WebP or GIF"),
            ));
        }
        if data.len() * 3 / 4 > MAX_IMAGE_BYTES {
            return Err(CoreError::new(
                413,
                format!(
                    "Image {number} is larger than {} MB",
                    MAX_IMAGE_BYTES / 1024 / 1024
                ),
            ));
        }
        images.push(ImagePart {
            mime_type: mime,
            base64: data,
        });
    }
    Ok(images)
}

/// Writes a run's images and returns their paths relative to the data folder.
pub async fn save_images(
    root: &Path,
    run_id: &str,
    images: &[ImagePart],
) -> Result<Vec<String>, CoreError> {
    let mut saved = Vec::new();
    if images.is_empty() {
        return Ok(saved);
    }
    let folder = safe(run_id);
    tokio::fs::create_dir_all(root.join(FOLDER).join(&folder)).await?;
    for (index, image) in images.iter().enumerate() {
        let name = format!(
            "{}.{}",
            index + 1,
            extension(&image.mime_type).unwrap_or("png")
        );
        let bytes = STANDARD
            .decode(&image.base64)
            .map_err(|_| CoreError::new(400, "Not a base64 image"))?;
        tokio::fs::write(root.join(FOLDER).join(&folder).join(&name), bytes).await?;
        saved.push(format!("{FOLDER}/{folder}/{name}"));
    }
    Ok(saved)
}

/// A run's images, for a model call. Missing files and paths outside the images folder are skipped.
pub async fn load_images(root: &Path, paths: &[String]) -> Vec<ImagePart> {
    let mut images = Vec::new();
    for relative in paths {
        let path = Path::new(relative);
        let inside = path.starts_with(FOLDER)
            && path
                .components()
                .all(|part| matches!(part, Component::Normal(_)));
        let mime = path
            .extension()
            .and_then(|name| name.to_str())
            .and_then(mime_type);
        let (true, Some(mime)) = (inside, mime) else {
            continue;
        };
        // The file was removed: the text of the message still stands.
        if let Ok(bytes) = tokio::fs::read(root.join(path)).await {
            images.push(ImagePart {
                mime_type: mime.to_owned(),
                base64: STANDARD.encode(bytes),
            });
        }
    }
    images
}

/// Deletes the images of runs that no longer exist.
pub async fn forget_images(root: &Path, run_ids: &[String]) {
    for id in run_ids {
        let _ = tokio::fs::remove_dir_all(root.join(FOLDER).join(safe(id))).await;
    }
}
