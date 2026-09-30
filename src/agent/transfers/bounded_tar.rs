//! Checks extension sizes before tar's normal iterator can allocate their bodies.

use std::io::{self, Read};

/// Matches the CLI's long-name bound; each GNU/PAX metadata member may use at most 64 KiB.
pub(super) const MAX_METADATA_BYTES: u64 = 64 * 1024;

/// Identifies input validation errors through tar's iterator without relying on error strings.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(super) struct InvalidMetadata(pub String);

/// Preserves tar's GNU/PAX interpretation while preventing extension read_to_end from growing unchecked.
pub(super) struct BoundedTarReader<R> {
    inner: R,
    header: [u8; 512],
    header_offset: usize,
    remaining: u64,
    padding: u64,
    local_pax: Option<Vec<u8>>,
    collecting_pax: bool,
    ended: bool,
}

impl<R: Read> BoundedTarReader<R> {
    /// Keeps only one bounded local PAX body to mirror the dependency's next-file size override.
    pub(super) fn new(inner: R) -> Self {
        Self {
            inner,
            header: [0; 512],
            header_offset: 512,
            remaining: 0,
            padding: 0,
            local_pax: None,
            collecting_pax: false,
            ended: false,
        }
    }

    /// Mirrors tar 0.4's first valid size record, including its handling of malformed records.
    fn pax_size(&self) -> Option<u64> {
        for record in tar::PaxExtensions::new(self.local_pax.as_deref()?) {
            let record = record.ok()?;
            if record.key() == Ok("size") {
                return record.value().ok()?.parse().ok();
            }
        }
        None
    }

    /// Rejects huge declarations from the header alone, before returning any header bytes to tar.
    fn prepare_header(&mut self) -> io::Result<()> {
        let header = tar::Header::from_byte_slice(&self.header);
        let kind = header.entry_type();
        let extension = kind.is_gnu_longname()
            || kind.is_gnu_longlink()
            || kind.is_pax_local_extensions()
            || kind.is_pax_global_extensions();
        let mut size = header.entry_size()?;
        if extension && size > MAX_METADATA_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                InvalidMetadata(format!(
                    "Tar metadata member exceeds 64 KiB limit: {size} bytes"
                )),
            ));
        }
        // Sparse entries have a separate extension-block layout and were never
        // supported by uploads. Reject them before the iterator parses that layout.
        if kind.is_gnu_sparse() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                InvalidMetadata("Unsupported tar sparse entry".into()),
            ));
        }
        if !extension {
            if let Some(pax_size) = self.pax_size() {
                size = pax_size;
            }
            self.local_pax = None;
        }
        self.collecting_pax = kind.is_pax_local_extensions()
            && (header.as_gnu().is_some() || header.as_ustar().is_some());
        if self.collecting_pax {
            // The iterator rejects duplicate local headers before reading the
            // second body, so its memory use is also bounded for repeated metadata.
            self.local_pax = Some(Vec::new());
        }
        self.remaining = size;
        self.padding = (512 - size % 512) % 512;
        self.header_offset = 0;
        Ok(())
    }
}

impl<R: Read> Read for BoundedTarReader<R> {
    /// Never reads ahead into a member payload while validating its header declaration.
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.header_offset < 512 {
                let count = buf.len().min(512 - self.header_offset);
                buf[..count]
                    .copy_from_slice(&self.header[self.header_offset..self.header_offset + count]);
                self.header_offset += count;
                return Ok(count);
            }
            if self.ended {
                // Retain the existing iterator's termination behavior. A future
                // strict-termination check can replace this pass-through phase.
                return self.inner.read(buf);
            }
            if self.remaining > 0 {
                let limit = self.remaining.min(buf.len() as u64) as usize;
                let count = self.inner.read(&mut buf[..limit])?;
                self.remaining -= count as u64;
                if self.collecting_pax
                    && let Some(pax) = self.local_pax.as_mut()
                {
                    pax.extend_from_slice(&buf[..count]);
                }
                return Ok(count);
            }
            if self.padding > 0 {
                let limit = self.padding.min(buf.len() as u64) as usize;
                let count = self.inner.read(&mut buf[..limit])?;
                self.padding -= count as u64;
                return Ok(count);
            }
            // Allow clean EOF as before, but don't hide a partial header.
            if self.inner.read(&mut self.header[..1])? == 0 {
                return Ok(0);
            }
            self.inner.read_exact(&mut self.header[1..])?;
            if self.header == [0; 512] {
                self.ended = true;
                self.header_offset = 0;
            } else {
                self.prepare_header()?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The documented bound is inclusive and must not accidentally limit ordinary file bodies.
    #[test]
    fn metadata_at_limit_and_larger_regular_payloads_remain_valid() {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::GNULongLink);
        header.set_size(MAX_METADATA_BYTES);
        header.set_cksum();
        let mut link = vec![b'a'; MAX_METADATA_BYTES as usize];
        link[MAX_METADATA_BYTES as usize - 1] = 0;
        builder.append(&header, link.as_slice()).unwrap();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(MAX_METADATA_BYTES + 1);
        builder
            .append_data(
                &mut header,
                "file",
                io::repeat(b'z').take(MAX_METADATA_BYTES + 1),
            )
            .unwrap();
        let bytes = builder.into_inner().unwrap();
        let mut archive = tar::Archive::new(BoundedTarReader::new(bytes.as_slice()));
        let mut entries = archive.entries().unwrap();
        let mut entry = entries.next().unwrap().unwrap();
        assert_eq!(
            entry.link_name_bytes().unwrap().len(),
            MAX_METADATA_BYTES as usize - 1,
            "GNU long-link metadata at exactly the limit must retain its normal semantics"
        );
        assert_eq!(
            io::copy(&mut entry, &mut io::sink()).unwrap(),
            MAX_METADATA_BYTES + 1,
            "regular payloads must stream even when larger than the metadata limit"
        );
        drop(entry);
        assert!(
            entries.next().is_none(),
            "the reader must preserve payload padding and the following terminator"
        );
    }

    /// Makes a huge body available without allocating it, recording exactly how far tar reads.
    #[test]
    fn oversized_metadata_is_rejected_before_any_payload_read() {
        for kind in [
            tar::EntryType::GNULongName,
            tar::EntryType::GNULongLink,
            tar::EntryType::XHeader,
            tar::EntryType::XGlobalHeader,
        ] {
            for size in [MAX_METADATA_BYTES + 1, 8 * 1024 * 1024 * 1024] {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(kind);
                header.set_size(size);
                header.set_cksum();
                let mut source =
                    io::Cursor::new(header.as_bytes()).chain(io::repeat(b'x').take(size));
                let reader = BoundedTarReader::new(&mut source);
                let mut archive = tar::Archive::new(reader);
                let error = archive.entries().unwrap().next().unwrap().err().unwrap();
                assert!(
                    error.get_ref().unwrap().is::<InvalidMetadata>(),
                    "every allocating extension type must fail on its declaration"
                );
                drop(archive);
                let (header_source, payload_source) = source.into_inner();
                assert_eq!(
                    header_source.position(),
                    512,
                    "the header alone must be sufficient to reject a huge supplied payload"
                );
                assert_eq!(
                    payload_source.limit(),
                    size,
                    "no bytes of the available huge payload may be consumed or buffered"
                );
            }
        }
    }

    /// Exercises size overrides across intermediary GNU metadata so framing cannot bypass later bounds.
    #[test]
    fn pax_size_override_keeps_subsequent_metadata_on_header_boundaries() {
        let mut builder = tar::Builder::new(Vec::new());
        builder
            .append_pax_extensions([("size", b"513".as_slice())])
            .unwrap();
        let mut long = tar::Header::new_gnu();
        long.set_entry_type(tar::EntryType::GNULongName);
        long.set_size(5);
        long.set_cksum();
        builder.append(&long, b"file\0".as_slice()).unwrap();
        let mut file = tar::Header::new_gnu();
        file.set_path("placeholder").unwrap();
        file.set_size(0);
        file.set_cksum();
        let mut bytes = builder.into_inner().unwrap();
        // Disagreeing header size is valid PAX: the override controls both parsers' framing.
        bytes.truncate(2048);
        bytes.extend_from_slice(file.as_bytes());
        bytes.extend_from_slice(&[b'a'; 513]);
        bytes.extend_from_slice(&[0; 511]);
        long.set_size(MAX_METADATA_BYTES + 1);
        long.set_cksum();
        bytes.extend_from_slice(long.as_bytes());
        let mut archive = tar::Archive::new(BoundedTarReader::new(bytes.as_slice()));
        let mut entries = archive.entries().unwrap();
        let mut entry = entries.next().unwrap().unwrap();
        assert_eq!(
            entry.path().unwrap().as_ref(),
            std::path::Path::new("file"),
            "intermediary GNU metadata must preserve the effective long path"
        );
        let mut contents = Vec::new();
        entry.read_to_end(&mut contents).unwrap();
        assert_eq!(
            contents.len(),
            513,
            "PAX size must override the regular header size"
        );
        drop(entry);
        let error = entries.next().unwrap().err().unwrap();
        assert!(
            error.get_ref().unwrap().is::<InvalidMetadata>(),
            "the following extension must still be validated at its real boundary"
        );
    }
}
