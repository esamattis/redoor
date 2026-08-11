use super::{CommandResult, MetadataResponse};
use std::{os::unix::fs::MetadataExt, path::Path};
use tokio::{fs::File, io::AsyncReadExt};

/// Keeps in-browser text editing away from multi-megabyte payloads.
const MAX_EDITABLE_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Keeps in-browser image viewing away from multi-tens-of-megabyte payloads.
const MAX_VIEWABLE_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// Bounds content sniffing for special files and large downloads.
const MIME_SNIFF_BYTES: usize = 8 * 1024;

/// Reads filesystem and content metadata needed by the remote file browser.
pub(super) async fn execute(path: String) -> CommandResult {
    match tokio::fs::metadata(&path).await {
        Ok(metadata) => {
            let mime_type = match Path::new(&path)
                .extension()
                .and_then(|ext| ext.to_str())
                .and_then(|ext| mime_guess::from_ext(ext).first())
                .map(|mime| mime.to_string())
            {
                Some(mime) => mime,
                None => detect_mime_type_from_content(&path)
                    .await
                    .unwrap_or_else(|| "application/octet-stream".to_string()),
            };

            let file_size = metadata.size();
            let is_file = metadata.is_file();
            let is_dir = metadata.is_dir();
            let editable = is_file_editable(&path, file_size, is_file).await;
            let viewable_image = is_viewable_image(&path, file_size, is_file).await;

            CommandResult::Metadata(MetadataResponse {
                path,
                mime_type,
                file_size,
                is_file,
                is_dir,
                editable,
                viewable_image,
                // Agents cannot observe server-local credentials; the HTTP handler fills these.
                one_time_tokens: Vec::new(),
            })
        }
        Err(error) => CommandResult::io_error(
            &format!("Failed to get file metadata for path {path:?}"),
            error,
        ),
    }
}

/// Marks a file editable only after size and full-content UTF-8 checks succeed.
async fn is_file_editable(path: &str, file_size: u64, is_file: bool) -> bool {
    if !is_file || file_size > MAX_EDITABLE_FILE_BYTES {
        return false;
    }

    match tokio::fs::read(path).await {
        Ok(bytes) => std::str::from_utf8(&bytes).is_ok(),
        Err(_) => false,
    }
}

/// Marks a file image-viewable only after size and content magic-byte checks succeed.
async fn is_viewable_image(path: &str, file_size: u64, is_file: bool) -> bool {
    // Extension is ignored so renamed images still open and fake extensions cannot.
    if !is_file || file_size == 0 || file_size > MAX_VIEWABLE_IMAGE_BYTES {
        return false;
    }

    match read_file_prefix(path).await {
        Some(bytes) => is_browser_viewable_image_magic(&bytes),
        None => false,
    }
}

/// Sniffs a small prefix so extensionless downloads get a useful MIME type without full buffering.
async fn detect_mime_type_from_content(path: &str) -> Option<String> {
    let content = read_file_prefix(path).await?;
    detect_mime_type(&content).map(str::to_string)
}

/// Reads only the bounded prefix used for MIME and image magic sniffing.
async fn read_file_prefix(path: &str) -> Option<Vec<u8>> {
    let mut file = match File::open(path).await {
        Ok(file) => file,
        Err(_) => return None,
    };

    let mut content = [0_u8; MIME_SNIFF_BYTES];
    let mut bytes_read = 0;

    while bytes_read < content.len() {
        let read = match file.read(&mut content[bytes_read..]).await {
            Ok(read) => read,
            Err(_) => return None,
        };

        if read == 0 {
            break;
        }

        bytes_read += read;
    }

    Some(content[..bytes_read].to_vec())
}

/// True when the prefix matches image formats browsers can render natively.
fn is_browser_viewable_image_magic(content: &[u8]) -> bool {
    if content.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        // PNG
        true
    } else if content.starts_with(&[0xFF, 0xD8, 0xFF]) {
        // JPEG
        true
    } else if content.starts_with(b"GIF87a") || content.starts_with(b"GIF89a") {
        true
    } else if content.starts_with(b"BM") {
        // BMP
        true
    } else if content.starts_with(b"RIFF") && content.len() >= 12 && &content[8..12] == b"WEBP" {
        true
    } else if content.len() >= 12 && &content[4..8] == b"ftyp" {
        // AVIF / HEIC family brands inside the ISO BMFF ftyp box.
        let brand = &content[8..12];
        brand == b"avif" || brand == b"avis" || brand == b"heic" || brand == b"heif"
    } else if content.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        // ICO
        true
    } else {
        false
    }
}

/// Matches the bounded prefix against formats that cannot be inferred from a filename.
fn detect_mime_type(content: &[u8]) -> Option<&'static str> {
    if content.starts_with(b"#!") || content.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Some("text/plain")
    } else if content.starts_with(b"%PDF") {
        Some("application/pdf")
    } else if content.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some("image/png")
    } else if content.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if content.starts_with(b"GIF87a") || content.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if content.starts_with(b"PK\x03\x04") || content.starts_with(b"PK\x05\x06") {
        Some("application/zip")
    } else if content.starts_with(&[0x7F, 0x45, 0x4C, 0x46]) {
        Some("application/x-executable")
    } else if content.starts_with(&[0x00, 0x61, 0x73, 0x6D]) {
        Some("application/wasm")
    } else if content.starts_with(b"\x1F\x8B") {
        Some("application/gzip")
    } else if content.starts_with(b"BZh") {
        Some("application/x-bzip2")
    } else if content.starts_with(&[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00]) {
        Some("application/x-xz")
    } else if content.starts_with(b"Rar!") || content.starts_with(b"Rar\x1A\x07") {
        Some("application/x-rar-compressed")
    } else if content.starts_with(b"\x37\x7A\xBC\xAF\x27\x1C") {
        Some("application/x-7z-compressed")
    } else if content.starts_with(b"fLaC") {
        Some("audio/flac")
    } else if content.starts_with(b"ID3")
        || content.starts_with(&[0xFF, 0xFB])
        || content.starts_with(&[0xFF, 0xF3])
        || content.starts_with(&[0xFF, 0xF2])
    {
        Some("audio/mpeg")
    } else if content.starts_with(b"\x00\x00\x00 ftyp")
        || content.starts_with(b"\x00\x00\x00\x18ftyp")
        || content.starts_with(b"\x00\x00\x00\x14ftyp")
    {
        Some("video/mp4")
    } else if content.starts_with(b"RIFF") && content.len() >= 12 && &content[8..12] == b"AVI " {
        Some("video/x-msvideo")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn content_detection_reads_only_prefix() {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            detect_mime_type_from_content("/dev/zero"),
        )
        .await;

        // Special files must not block metadata requests while the detector waits for EOF.
        assert!(
            result.is_ok(),
            "content sniffing should only read a bounded prefix"
        );
        assert_eq!(
            result.unwrap(),
            None,
            "zero-filled content should not match a known MIME"
        );
    }

    #[tokio::test]
    async fn utf8_text_is_editable() {
        let path = std::env::temp_dir().join(format!(
            "redoor-metadata-editable-{}.bin",
            std::process::id()
        ));
        tokio::fs::write(&path, "hello plain text")
            .await
            .expect("write text");

        let result = execute(path.to_string_lossy().into_owned()).await;
        let _ = tokio::fs::remove_file(&path).await;

        match result {
            CommandResult::Metadata(metadata) => {
                // Extensionless UTF-8 content must still be editable for the UI editor gate.
                assert!(metadata.editable);
                assert!(metadata.is_file);
            }
            other => panic!("Expected Metadata, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn invalid_utf8_is_not_editable() {
        let path =
            std::env::temp_dir().join(format!("redoor-metadata-binary-{}.txt", std::process::id()));
        tokio::fs::write(&path, [0xff, 0xfe, 0xfd])
            .await
            .expect("write binary");

        let result = execute(path.to_string_lossy().into_owned()).await;
        let _ = tokio::fs::remove_file(&path).await;

        match result {
            CommandResult::Metadata(metadata) => {
                // A .txt suffix must not override invalid UTF-8 content.
                assert!(!metadata.editable);
            }
            other => panic!("Expected Metadata, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn large_utf8_is_not_editable() {
        let path =
            std::env::temp_dir().join(format!("redoor-metadata-large-{}.txt", std::process::id()));
        let large = vec![b'a'; (MAX_EDITABLE_FILE_BYTES as usize) + 1];
        tokio::fs::write(&path, large).await.expect("write large");

        let result = execute(path.to_string_lossy().into_owned()).await;
        let _ = tokio::fs::remove_file(&path).await;

        match result {
            CommandResult::Metadata(metadata) => {
                // Size gating avoids loading multi-megabyte bodies into the browser textarea.
                assert!(!metadata.editable);
                assert!(metadata.file_size > MAX_EDITABLE_FILE_BYTES);
            }
            other => panic!("Expected Metadata, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn png_magic_is_viewable_image_without_extension() {
        let path = std::env::temp_dir().join(format!("redoor-metadata-png-{}", std::process::id()));
        tokio::fs::write(&path, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
            .await
            .expect("write png");

        let result = execute(path.to_string_lossy().into_owned()).await;
        let _ = tokio::fs::remove_file(&path).await;

        match result {
            CommandResult::Metadata(metadata) => {
                // Image viewing is gated on content magic, not the filename suffix.
                assert!(metadata.viewable_image);
                assert!(!metadata.editable);
            }
            other => panic!("Expected Metadata, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn png_magic_is_viewable_image_with_text_extension() {
        let path =
            std::env::temp_dir().join(format!("redoor-metadata-png-{}.txt", std::process::id()));
        tokio::fs::write(&path, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
            .await
            .expect("write png");

        let result = execute(path.to_string_lossy().into_owned()).await;
        let _ = tokio::fs::remove_file(&path).await;

        match result {
            CommandResult::Metadata(metadata) => {
                // A misleading extension must not hide a real image from the viewer.
                assert!(metadata.viewable_image);
            }
            other => panic!("Expected Metadata, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn binary_without_image_magic_is_not_viewable() {
        let path = std::env::temp_dir().join(format!(
            "redoor-metadata-not-image-{}.png",
            std::process::id()
        ));
        tokio::fs::write(&path, [0x00, 0x01, 0x02, 0x03])
            .await
            .expect("write binary");

        let result = execute(path.to_string_lossy().into_owned()).await;
        let _ = tokio::fs::remove_file(&path).await;

        match result {
            CommandResult::Metadata(metadata) => {
                // A .png suffix alone is not enough without matching magic bytes.
                assert!(!metadata.viewable_image);
            }
            other => panic!("Expected Metadata, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn oversized_image_is_not_viewable() {
        let path =
            std::env::temp_dir().join(format!("redoor-metadata-large-png-{}", std::process::id()));
        let mut large = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        large.resize((MAX_VIEWABLE_IMAGE_BYTES as usize) + 1, 0);
        tokio::fs::write(&path, large)
            .await
            .expect("write large png");

        let result = execute(path.to_string_lossy().into_owned()).await;
        let _ = tokio::fs::remove_file(&path).await;

        match result {
            CommandResult::Metadata(metadata) => {
                // Size gating avoids loading multi-tens-of-megabyte images into the browser.
                assert!(!metadata.viewable_image);
                assert!(metadata.file_size > MAX_VIEWABLE_IMAGE_BYTES);
            }
            other => panic!("Expected Metadata, got {other:?}"),
        }
    }
}
