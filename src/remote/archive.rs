//! Async tar IO keeps payload memory fixed and avoids filesystem work on Tokio's control workers.

use anyhow::{Context, Result, bail, ensure};
use bytes::Bytes;
use futures_util::Stream;
use std::{
    os::unix::fs::PermissionsExt,
    path::{Component, Path, PathBuf},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

/// Produces plain tar relative to the destination root; an empty tree is a valid empty archive.
pub fn stream(root: PathBuf) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send {
    async_stream::try_stream! {
        let directory = tokio::fs::read_dir(&root).await?;
        let mut stack = vec![directory];
        let mut buffer = vec![0; 64 * 1024];
        while let Some(directory) = stack.last_mut() {
            let Some(entry) = directory.next_entry().await? else {
                stack.pop();
                continue;
            };
            let path = entry.path();
            let relative = path.strip_prefix(&root).map_err(std::io::Error::other)?;
            let metadata = tokio::fs::symlink_metadata(&path).await?;
            if !metadata.is_file() && !metadata.is_dir() {
                Err(std::io::Error::other(format!("Unsupported archive source entry: {}", path.display())))?;
            }
            let mut header = tar::Header::new_gnu();
            header.set_mode(metadata.permissions().mode() & 0o777);
            header.set_mtime(metadata.modified()?.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs());
            header.set_entry_type(if metadata.is_dir() { tar::EntryType::Directory } else { tar::EntryType::Regular });
            header.set_size(if metadata.is_dir() { 0 } else { metadata.len() });
            if header.set_path(relative).is_err() {
                let name = relative.as_os_str().as_encoded_bytes();
                let mut long = tar::Header::new_gnu();
                long.set_path("././@LongLink")?;
                long.set_entry_type(tar::EntryType::GNULongName);
                long.set_size((name.len() + 1) as u64);
                long.set_cksum();
                yield Bytes::copy_from_slice(long.as_bytes());
                yield Bytes::copy_from_slice(name);
                yield Bytes::from(vec![0; 512 - name.len() % 512]);
                header.set_path("long-name")?;
            }
            header.set_cksum();
            yield Bytes::copy_from_slice(header.as_bytes());
            if metadata.is_dir() {
                stack.push(tokio::fs::read_dir(&path).await?);
            } else {
                let mut file = tokio::fs::File::open(&path).await?;
                let mut remaining = metadata.len();
                while remaining > 0 {
                    let limit = remaining.min(buffer.len() as u64) as usize;
                    let count = file.read(&mut buffer[..limit]).await?;
                    if count == 0 { Err(std::io::Error::other("Archive source shrank during upload"))?; }
                    remaining -= count as u64;
                    yield Bytes::copy_from_slice(&buffer[..count]);
                }
                let padding = (512 - metadata.len() % 512) % 512;
                if padding > 0 { yield Bytes::from(vec![0; padding as usize]); }
            }
        }
        yield Bytes::from_static(&[0; 1024]);
    }
}

/// Rejects absolute paths and traversal before stripping the API archive's one source-root component.
fn relative_member(path: &Path, root: &str) -> Result<PathBuf> {
    let mut parts = Vec::new();
    for part in path.components() {
        match part {
            Component::Normal(value) => parts.push(value),
            Component::CurDir => {}
            _ => bail!("Archive path escapes destination: {}", path.display()),
        }
    }
    ensure!(
        parts
            .first()
            .is_some_and(|part| *part == std::ffi::OsStr::new(root)),
        "Unexpected archive root: {}",
        path.display()
    );
    Ok(parts.into_iter().skip(1).collect())
}

/// Extracts only regular files/directories into private staging; validates tar end markers and drains gzip trailers.
pub async fn extract<R: AsyncRead + Unpin>(
    reader: &mut R,
    destination: &Path,
    root: &str,
) -> Result<()> {
    let mut long_name = None;
    loop {
        let mut block = [0; 512];
        reader
            .read_exact(&mut block)
            .await
            .context("Truncated directory archive")?;
        if block == [0; 512] {
            reader.read_exact(&mut block).await?;
            ensure!(block == [0; 512], "Invalid tar terminator");
            tokio::io::copy(reader, &mut tokio::io::sink()).await?;
            ensure!(long_name.is_none(), "Unconsumed archive long name");
            return Ok(());
        }
        let header = tar::Header::from_byte_slice(&block);
        let checksum: u32 = block
            .iter()
            .enumerate()
            .map(|(i, byte)| {
                if (148..156).contains(&i) {
                    32
                } else {
                    u32::from(*byte)
                }
            })
            .sum();
        ensure!(header.cksum()? == checksum, "Invalid tar checksum");
        let size = header.size()?;
        let kind = header.entry_type();
        if kind == tar::EntryType::GNULongName {
            ensure!(
                size <= 64 * 1024 && long_name.is_none(),
                "Invalid archive long name"
            );
            let mut name = vec![0; size as usize];
            reader.read_exact(&mut name).await?;
            if name.last() == Some(&0) {
                name.pop();
            }
            use std::os::unix::ffi::OsStringExt;
            long_name = Some(PathBuf::from(std::ffi::OsString::from_vec(name)));
        } else {
            ensure!(
                kind.is_file() || kind.is_dir(),
                "Unsupported archive entry type: {kind:?}"
            );
            let path = match long_name.take() {
                Some(path) => path,
                None => header.path()?.into_owned(),
            };
            let relative = relative_member(&path, root)?;
            ensure!(
                !relative.as_os_str().is_empty() || kind.is_dir(),
                "Archive root must be a directory"
            );
            let output = destination.join(relative);
            if kind.is_dir() {
                ensure!(size == 0, "Directory archive member has payload");
                if output != destination {
                    // Agent archives emit parents first. Never recreate staging after interruption cleanup.
                    tokio::fs::create_dir(&output).await?;
                }
            } else {
                let mut file = tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&output)
                    .await?;
                let copied = tokio::io::copy(&mut reader.take(size), &mut file).await?;
                ensure!(copied == size, "Truncated archive member");
                file.flush().await?;
                tokio::fs::set_permissions(
                    &output,
                    std::fs::Permissions::from_mode(header.mode()? & 0o777),
                )
                .await?;
            }
        }
        let padding = (512 - size % 512) % 512;
        let mut block = [0; 512];
        reader.read_exact(&mut block[..padding as usize]).await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::TryStreamExt;

    /// Small synthetic archives isolate validation from transport and never perform blocking filesystem IO.
    fn fixture(kind: tar::EntryType, name: &str, contents: &[u8]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_mode(0o640);
        header.set_size(contents.len() as u64);
        header.set_cksum();
        builder.append_data(&mut header, name, contents).unwrap();
        builder.finish().unwrap();
        builder.into_inner().unwrap()
    }

    /// Valid archives must preserve bytes/modes while incomplete or special members cannot be published.
    #[tokio::test]
    async fn extraction_validates_integrity_and_rejects_links_and_traversal() {
        let root = crate::test_support::TempDir::create();
        let valid = fixture(tar::EntryType::Regular, "root/file", b"payload");
        let destination = root.path().join("valid");
        tokio::fs::create_dir(&destination).await.unwrap();
        extract(&mut valid.as_slice(), &destination, "root")
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(destination.join("file")).await.unwrap(),
            b"payload",
            "archive extraction must preserve the member bytes"
        );
        assert_eq!(
            tokio::fs::metadata(destination.join("file"))
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640,
            "file mode must survive extraction without setuid bits"
        );
        let cases = [
            valid[..515].to_vec(),
            fixture(tar::EntryType::Symlink, "root/link", b""),
            fixture(tar::EntryType::Regular, "other/file", b"outside"),
        ];
        for (index, archive) in cases.into_iter().enumerate() {
            let destination = root.path().join(index.to_string());
            tokio::fs::create_dir(&destination).await.unwrap();
            assert!(
                extract(&mut archive.as_slice(), &destination, "root")
                    .await
                    .is_err(),
                "truncated, linked, and unexpected-root archives must fail before publication"
            );
        }
        assert!(
            relative_member(Path::new("root/../escape"), "root").is_err(),
            "traversal must be rejected before removing the source-root component"
        );
        assert!(
            relative_member(Path::new("/root/file"), "root").is_err(),
            "absolute members must never write outside staging"
        );
        let mut corrupt = valid;
        corrupt[0] ^= 1;
        assert!(
            extract(&mut corrupt.as_slice(), root.path(), "root")
                .await
                .unwrap_err()
                .to_string()
                .contains("checksum"),
            "header corruption must not silently redirect extracted members"
        );
    }

    /// Archive production must bound each payload chunk independently of member length.
    #[tokio::test]
    async fn production_bounds_chunks_and_preserves_empty_trees() {
        let root = crate::test_support::TempDir::create();
        let file = tokio::fs::File::create(root.path().join("large"))
            .await
            .unwrap();
        file.set_len(4 * 1024 * 1024).await.unwrap();
        let mut chunks = Box::pin(stream(root.path().to_owned()));
        let mut count = 0;
        while let Some(chunk) = chunks.try_next().await.unwrap() {
            assert!(
                chunk.len() <= 64 * 1024,
                "archive members must not create whole-file upload buffers"
            );
            count += chunk.len();
        }
        assert_eq!(
            count,
            4 * 1024 * 1024 + 512 + 1024,
            "tar framing must account for the member header and complete terminator"
        );
        let empty = root.path().join("empty");
        tokio::fs::create_dir(&empty).await.unwrap();
        let chunks = stream(empty).try_collect::<Vec<_>>().await.unwrap();
        assert_eq!(
            chunks.concat(),
            vec![0; 1024],
            "an empty recursive upload must still emit a valid complete archive"
        );
    }
}
