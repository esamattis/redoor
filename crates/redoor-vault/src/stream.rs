//! STREAM encryption of the payload as `AsyncRead` adapters.
//!
//! The payload is a sequence of chunks of [`CHUNK_SIZE`] plaintext bytes, each followed by
//! its Poly1305 tag. The nonce is an 11-byte big-endian chunk counter followed by a flag
//! byte that is 1 only on the final chunk, which detects truncation, reordering and
//! appended data. An empty file is a single empty final chunk.
//!
//! Both adapters read one chunk ahead by a single byte, because whether a chunk is final
//! decides its nonce and is only known once the next byte (or the end) has been seen.

use super::{CHUNK_SIZE, FileKey, TAG_LEN, VaultFormatError, VaultPreamble};
use chacha20poly1305::{AeadInOut, ChaCha20Poly1305, KeyInit, Nonce, Tag};
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll, ready};
use tokio::io::{AsyncRead, ReadBuf};
use zeroize::Zeroizing;

/// Builds the nonce of chunk `counter`.
fn chunk_nonce(counter: u64, is_final: bool) -> Nonce {
    let mut nonce = Nonce::default();
    nonce[3..11].copy_from_slice(&counter.to_be_bytes());
    nonce[11] = u8::from(is_final);
    nonce
}

/// The cipher of one payload.
fn payload_cipher(
    preamble: &VaultPreamble,
    key: &FileKey,
) -> Result<ChaCha20Poly1305, VaultFormatError> {
    let payload_key = preamble.payload_key(key)?;
    Ok(ChaCha20Poly1305::new_from_slice(payload_key.as_ref()).expect("32-byte ChaCha20 key"))
}

/// Shared chunk bookkeeping of both directions: an input buffer that fills to one chunk
/// plus one byte, and an output buffer drained into the caller's `ReadBuf`.
struct ChunkBuffers {
    /// Raw input, zeroed on drop because it holds plaintext when encrypting.
    input: Zeroizing<Vec<u8>>,
    filled: usize,
    input_done: bool,
    /// Processed bytes not yet handed out, zeroed on drop because they hold plaintext
    /// when decrypting.
    output: Zeroizing<Vec<u8>>,
    output_pos: usize,
    counter: u64,
    finished: bool,
    /// Set after a failure, so later reads repeat it instead of continuing past it.
    failed: Option<VaultFormatError>,
}

impl ChunkBuffers {
    /// Allocates buffers for input chunks of up to `chunk_len` bytes.
    fn new(chunk_len: usize) -> Self {
        Self {
            input: Zeroizing::new(vec![0u8; chunk_len + 1]),
            filled: 0,
            input_done: false,
            output: Zeroizing::new(Vec::with_capacity(chunk_len + TAG_LEN)),
            output_pos: 0,
            counter: 0,
            finished: false,
            failed: None,
        }
    }

    /// Copies pending output into `buf`; true when something was copied.
    fn drain_into(&mut self, buf: &mut ReadBuf<'_>) -> bool {
        let pending = &self.output[self.output_pos..];
        if pending.is_empty() || buf.remaining() == 0 {
            return false;
        }
        let count = pending.len().min(buf.remaining());
        buf.put_slice(&pending[..count]);
        self.output_pos += count;
        true
    }

    /// Reads until the input holds a whole chunk plus one byte, or the source ended.
    fn poll_fill<R: AsyncRead + Unpin>(
        &mut self,
        inner: &mut R,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<()>> {
        while !self.input_done && self.filled < self.input.len() {
            let mut read = ReadBuf::new(&mut self.input[self.filled..]);
            ready!(Pin::new(&mut *inner).poll_read(cx, &mut read))?;
            match read.filled().len() {
                0 => self.input_done = true,
                count => self.filled += count,
            }
        }
        Poll::Ready(Ok(()))
    }

    /// Splits off the next chunk of up to `chunk_len` bytes and whether it is final.
    fn next_chunk(&self, chunk_len: usize) -> (usize, bool) {
        if self.input_done && self.filled <= chunk_len {
            (self.filled, true)
        } else {
            (chunk_len, false)
        }
    }

    /// Drops a processed chunk from the input, keeping the look-ahead byte.
    fn consume(&mut self, count: usize) {
        self.input.copy_within(count..self.filled, 0);
        self.filled -= count;
    }
}

/// Encrypts a plaintext source into the STREAM payload (without the preamble, which the
/// caller writes first).
pub struct EncryptingReader<R> {
    inner: R,
    cipher: ChaCha20Poly1305,
    buffers: ChunkBuffers,
}

impl<R> EncryptingReader<R> {
    /// Encrypts `inner` with the payload key that `preamble` and `key` define.
    pub fn new(
        inner: R,
        preamble: &VaultPreamble,
        key: &FileKey,
    ) -> Result<Self, VaultFormatError> {
        Ok(Self {
            inner,
            cipher: payload_cipher(preamble, key)?,
            buffers: ChunkBuffers::new(CHUNK_SIZE),
        })
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for EncryptingReader<R> {
    /// Hands out encrypted bytes, encrypting the next chunk whenever the last one is drained.
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            let buffers = &mut this.buffers;
            if buffers.drain_into(buf) || buffers.finished {
                return Poll::Ready(Ok(()));
            }
            ready!(buffers.poll_fill(&mut this.inner, cx))?;
            let (len, is_final) = buffers.next_chunk(CHUNK_SIZE);
            buffers.output.clear();
            buffers.output.extend_from_slice(&buffers.input[..len]);
            let tag = this
                .cipher
                .encrypt_inout_detached(
                    &chunk_nonce(buffers.counter, is_final),
                    &[],
                    buffers.output.as_mut_slice().into(),
                )
                .map_err(|_| io::Error::other("chunk encryption failed"))?;
            buffers.output.extend_from_slice(&tag);
            buffers.output_pos = 0;
            buffers.consume(len);
            buffers.counter += 1;
            buffers.finished = is_final;
        }
    }
}

/// Decrypts a STREAM payload (the source positioned after the preamble) into plaintext.
///
/// Fails with an `io::Error` wrapping [`VaultFormatError`] when a chunk does not
/// authenticate or the payload ends early; see [`VaultFormatError::from_io`].
pub struct DecryptingReader<R> {
    inner: R,
    cipher: ChaCha20Poly1305,
    buffers: ChunkBuffers,
}

impl<R> DecryptingReader<R> {
    /// Decrypts `inner` after checking the header MAC, so a wrong key or a tampered header
    /// fails before the first chunk.
    pub fn new(
        inner: R,
        preamble: &VaultPreamble,
        key: &FileKey,
    ) -> Result<Self, VaultFormatError> {
        preamble.verify(key)?;
        Ok(Self {
            inner,
            cipher: payload_cipher(preamble, key)?,
            buffers: ChunkBuffers::new(CHUNK_SIZE + TAG_LEN),
        })
    }

    /// Records a failure so every later read repeats it.
    fn fail(&mut self, error: VaultFormatError) -> io::Error {
        self.buffers.failed = Some(error.clone());
        error.into_io()
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for DecryptingReader<R> {
    /// Hands out plaintext of authenticated chunks only.
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            if let Some(error) = this.buffers.failed.clone() {
                return Poll::Ready(Err(error.into_io()));
            }
            let buffers = &mut this.buffers;
            if buffers.drain_into(buf) || buffers.finished {
                return Poll::Ready(Ok(()));
            }
            ready!(buffers.poll_fill(&mut this.inner, cx))?;
            let (len, is_final) = buffers.next_chunk(CHUNK_SIZE + TAG_LEN);
            let offset = buffers.counter * CHUNK_SIZE as u64;
            if len < TAG_LEN {
                // Less than a tag: the file ends inside a chunk, or the payload is missing.
                return Poll::Ready(Err(this.fail(VaultFormatError::Truncated)));
            }
            let body = len - TAG_LEN;
            let tag = Tag::try_from(&buffers.input[body..len]).expect("16-byte tag");
            buffers.output.clear();
            buffers.output.extend_from_slice(&buffers.input[..body]);
            let decrypted = this.cipher.decrypt_inout_detached(
                &chunk_nonce(buffers.counter, is_final),
                &[],
                buffers.output.as_mut_slice().into(),
                &tag,
            );
            if decrypted.is_err() {
                // Unauthenticated plaintext must never be handed out.
                buffers.output.clear();
                return Poll::Ready(Err(this.fail(VaultFormatError::CorruptChunk { offset })));
            }
            buffers.output_pos = 0;
            buffers.consume(len);
            buffers.counter += 1;
            buffers.finished = is_final;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::header::tests::test_header;
    use crate::{payload_len, plaintext_len};
    use tokio::io::AsyncReadExt;

    /// Deterministic content that differs at every offset, so reordering shows.
    fn content(len: usize) -> Vec<u8> {
        (0..len)
            .map(|index| (index * 31 + index / 251) as u8)
            .collect()
    }

    /// Encrypts `plaintext` into a whole file.
    async fn encrypt(plaintext: &[u8], key: &FileKey) -> (VaultPreamble, Vec<u8>) {
        let preamble = VaultPreamble::build(test_header(), key).unwrap();
        let mut payload = Vec::new();
        EncryptingReader::new(plaintext, &preamble, key)
            .unwrap()
            .read_to_end(&mut payload)
            .await
            .unwrap();
        (preamble, payload)
    }

    /// Decrypts a payload, returning the plaintext or the format error.
    async fn decrypt(
        preamble: &VaultPreamble,
        payload: &[u8],
        key: &FileKey,
    ) -> Result<Vec<u8>, VaultFormatError> {
        let mut plaintext = Vec::new();
        DecryptingReader::new(payload, preamble, key)?
            .read_to_end(&mut plaintext)
            .await
            .map_err(|error| VaultFormatError::from_io(&error).expect("format error"))?;
        Ok(plaintext)
    }

    /// Every size around the chunk boundaries must round trip and match the computed size.
    #[tokio::test]
    async fn round_trips_at_chunk_boundaries() {
        for len in [0, 1, 65535, 65536, 65537, 3 * 1024 * 1024 + 11] {
            let key = FileKey::generate();
            let plaintext = content(len);
            let (preamble, payload) = encrypt(&plaintext, &key).await;
            // Content-Length is computed, so the real output must have exactly that size.
            assert_eq!(
                payload.len() as u64,
                payload_len(len as u64),
                "length {len}"
            );
            assert_eq!(plaintext_len(payload.len() as u64), Some(len as u64));
            // The plaintext must come back unchanged.
            assert_eq!(decrypt(&preamble, &payload, &key).await.unwrap(), plaintext);
        }
    }

    /// Small reads must not change the result, because HTTP bodies arrive in any sizes.
    #[tokio::test]
    async fn round_trips_through_tiny_reads() {
        let key = FileKey::generate();
        let plaintext = content(65536 * 2 + 3);
        let (preamble, payload) = encrypt(&plaintext, &key).await;
        let (client, mut server) = tokio::io::duplex(7);
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            server.write_all(&payload).await.unwrap();
        });
        let mut decrypted = Vec::new();
        DecryptingReader::new(client, &preamble, &key)
            .unwrap()
            .read_to_end(&mut decrypted)
            .await
            .unwrap();
        writer.await.unwrap();
        // A 7-byte pipe splits every chunk, which must not affect the output.
        assert_eq!(decrypted, plaintext);
    }

    /// Truncation at and between chunk boundaries, including a dropped final chunk, must
    /// fail instead of looking like a shorter complete file.
    #[tokio::test]
    async fn truncation_is_detected() {
        let key = FileKey::generate();
        let plaintext = content(65536 * 3 + 100);
        let (preamble, payload) = encrypt(&plaintext, &key).await;
        let chunk = CHUNK_SIZE + TAG_LEN;
        for cut in [
            0,
            10,
            chunk,
            chunk + 1,
            2 * chunk,
            3 * chunk,
            payload.len() - 1,
        ] {
            // Every cut must fail; a success would hand out a silently shortened file.
            assert!(
                decrypt(&preamble, &payload[..cut], &key).await.is_err(),
                "cut at {cut}"
            );
        }
    }

    /// Reordered, duplicated and appended chunks must fail.
    #[tokio::test]
    async fn reordering_and_appending_are_detected() {
        let key = FileKey::generate();
        let (preamble, payload) = encrypt(&content(65536 * 3), &key).await;
        let chunk = CHUNK_SIZE + TAG_LEN;
        let mut swapped = payload.clone();
        swapped[..chunk].copy_from_slice(&payload[chunk..2 * chunk]);
        swapped[chunk..2 * chunk].copy_from_slice(&payload[..chunk]);
        // The counter in the nonce makes a swapped chunk fail at its new position.
        assert_eq!(
            decrypt(&preamble, &swapped, &key).await.unwrap_err(),
            VaultFormatError::CorruptChunk { offset: 0 }
        );
        let mut appended = payload.clone();
        appended.extend_from_slice(&payload[..chunk]);
        // The final flag makes the old last chunk fail once something follows it.
        assert!(decrypt(&preamble, &appended, &key).await.is_err());
    }

    /// A flipped bit in any chunk fails at that chunk, and nothing of it is released.
    #[tokio::test]
    async fn flipped_payload_bits_fail_without_releasing_plaintext() {
        let key = FileKey::generate();
        let plaintext = content(65536 * 2 + 5);
        let (preamble, mut payload) = encrypt(&plaintext, &key).await;
        let chunk = CHUNK_SIZE + TAG_LEN;
        payload[chunk + 3] ^= 1;
        let mut reader = DecryptingReader::new(payload.as_slice(), &preamble, &key).unwrap();
        let mut released = Vec::new();
        let error = reader.read_to_end(&mut released).await.unwrap_err();
        // The failure names the plaintext offset of the damaged chunk.
        assert_eq!(
            VaultFormatError::from_io(&error),
            Some(VaultFormatError::CorruptChunk { offset: 65536 })
        );
        // Only the authenticated first chunk was released before the failure.
        assert_eq!(released, plaintext[..CHUNK_SIZE]);
    }

    /// A wrong key fails at the header MAC, before any chunk is touched.
    #[tokio::test]
    async fn wrong_key_fails_before_the_payload() {
        let key = FileKey::generate();
        let (preamble, payload) = encrypt(b"secret", &key).await;
        // The MAC check runs when the reader is built, so no plaintext can be produced.
        assert_eq!(
            DecryptingReader::new(payload.as_slice(), &preamble, &FileKey::generate())
                .err()
                .unwrap(),
            VaultFormatError::HeaderMac
        );
    }
}
