use crate::types::{ChunkIndex, RequestId};
use anyhow::{bail, Result};

pub const PROTOCOL_MAGIC: u32 = 0x52415844;
pub const HEADER_SIZE: usize = 23;
/// Preferred file read size for disk IO before websocket framing.
pub const CHUNK_SIZE: usize = 64 * 1024;
/// Control messages can only preempt transfer traffic between websocket frames,
/// so all streamed binary transfers share one payload cap.
pub const MAX_TRANSFER_FRAME_PAYLOAD_BYTES: usize = 8 * 1024;

/// Identifies how the chunk payload bytes should be interpreted by the receiver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamPayloadKind {
    RawFile = 0,
    Tar = 1,
}

impl StreamPayloadKind {
    fn from_byte(byte: u8) -> Result<Self> {
        match byte {
            0 => Ok(Self::RawFile),
            1 => Ok(Self::Tar),
            _ => bail!("Invalid payload kind byte: {}", byte),
        }
    }
}

#[derive(Debug, Clone)]
/// One websocket transfer frame carrying a portion of a logical streamed
/// payload. `StreamChunkFrameRequest` describes the full logical payload to
/// send, `StreamChunkFrames` splits it into frame-sized pieces, and each item
/// yielded by that iterator is one `StreamChunk` serialized on the wire.
pub struct StreamChunk {
    pub request_id: RequestId,
    pub chunk_index: ChunkIndex,
    pub is_last: bool,
    pub is_error: bool,
    /// Marks whether `data` contains raw file bytes or a tar stream chunk.
    pub payload_kind: StreamPayloadKind,
    pub data: Vec<u8>,
}

/// Iterator state type implementing `Iterator<Item = StreamChunk>`, produced
/// from a `StreamChunkFrameRequest` to emit that one logical payload as one or
/// more websocket-sized frames while preserving chunk ordering and final-frame
/// semantics.
pub struct StreamChunkFrames<'a> {
    request_id: RequestId,
    next_chunk_index: ChunkIndex,
    payload_kind: StreamPayloadKind,
    is_error: bool,
    data: &'a [u8],
    offset: usize,
    is_last: bool,
    emitted_empty_final_chunk: bool,
}

/// Builder-style description of one logical transfer payload that should be
/// reframed into websocket-sized `StreamChunk` values by `StreamChunkFrames`.
#[derive(Debug, Clone, Copy)]
pub struct StreamChunkFrameRequest<'a> {
    request_id: RequestId,
    starting_chunk_index: ChunkIndex,
    payload_kind: StreamPayloadKind,
    is_error: bool,
    data: &'a [u8],
    is_last: bool,
}

impl<'a> StreamChunkFrameRequest<'a> {
    pub fn new(request_id: RequestId, data: &'a [u8]) -> Self {
        Self {
            request_id,
            starting_chunk_index: ChunkIndex::new(0),
            payload_kind: StreamPayloadKind::RawFile,
            is_error: false,
            data,
            is_last: true,
        }
    }

    pub fn starting_chunk_index(mut self, starting_chunk_index: ChunkIndex) -> Self {
        self.starting_chunk_index = starting_chunk_index;
        self
    }

    pub fn payload_kind(mut self, payload_kind: StreamPayloadKind) -> Self {
        self.payload_kind = payload_kind;
        self
    }

    pub fn is_error(mut self, is_error: bool) -> Self {
        self.is_error = is_error;
        self
    }

    pub fn is_last(mut self, is_last: bool) -> Self {
        self.is_last = is_last;
        self
    }

    pub fn is_error_flag(&self) -> bool {
        self.is_error
    }

    pub fn is_last_flag(&self) -> bool {
        self.is_last
    }

    pub fn into_frames(self) -> StreamChunkFrames<'a> {
        StreamChunkFrames {
            request_id: self.request_id,
            next_chunk_index: self.starting_chunk_index,
            payload_kind: self.payload_kind,
            is_error: self.is_error,
            data: self.data,
            offset: 0,
            is_last: self.is_last,
            emitted_empty_final_chunk: false,
        }
    }
}

impl StreamChunk {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(HEADER_SIZE + self.data.len());

        bytes.extend_from_slice(&PROTOCOL_MAGIC.to_le_bytes());
        bytes.extend_from_slice(&self.request_id.to_le_bytes());
        bytes.extend_from_slice(&self.chunk_index.to_le_bytes());
        bytes.push(if self.is_last { 1 } else { 0 });
        bytes.push(if self.is_error { 1 } else { 0 });
        bytes.push(self.payload_kind as u8);
        bytes.extend_from_slice(&self.data);

        bytes
    }

    pub fn parse_data(bytes: &[u8]) -> Result<Vec<u8>> {
        Self::from_bytes(bytes).map(|chunk| chunk.data)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < HEADER_SIZE {
            bail!(
                "Chunk too short: {} bytes (minimum {})",
                bytes.len(),
                HEADER_SIZE
            );
        }

        let magic = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        if magic != PROTOCOL_MAGIC {
            bail!(
                "Invalid magic: 0x{:08x} (expected 0x{:08x})",
                magic,
                PROTOCOL_MAGIC
            );
        }

        let request_id = RequestId::from_le_bytes([
            bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11],
        ]);

        let chunk_index = ChunkIndex::from_le_bytes([
            bytes[12], bytes[13], bytes[14], bytes[15], bytes[16], bytes[17], bytes[18], bytes[19],
        ]);

        let is_last = bytes[20] == 1;
        let is_error = bytes[21] == 1;
        let payload_kind = StreamPayloadKind::from_byte(bytes[22])?;

        let data = bytes[HEADER_SIZE..].to_vec();

        Ok(StreamChunk {
            request_id,
            chunk_index,
            is_last,
            is_error,
            payload_kind,
            data,
        })
    }
}

/// Splits one logical payload into websocket-sized transfer frames while
/// preserving ordering, `ChunkIndex` progression, and final-chunk semantics.
pub fn split_stream_chunk_bytes(request: StreamChunkFrameRequest<'_>) -> StreamChunkFrames<'_> {
    request.into_frames()
}

impl StreamChunkFrames<'_> {
    /// Returns the next chunk index that should be used after exhausting the
    /// iterator or after stopping early during incremental forwarding.
    pub fn next_chunk_index(&self) -> ChunkIndex {
        self.next_chunk_index
    }
}

impl Iterator for StreamChunkFrames<'_> {
    type Item = StreamChunk;

    fn next(&mut self) -> Option<Self::Item> {
        if self.offset >= self.data.len() {
            if self.data.is_empty() && self.is_last && !self.emitted_empty_final_chunk {
                self.emitted_empty_final_chunk = true;
                let chunk = StreamChunk {
                    request_id: self.request_id,
                    chunk_index: self.next_chunk_index,
                    is_last: true,
                    is_error: self.is_error,
                    payload_kind: self.payload_kind,
                    data: Vec::new(),
                };
                self.next_chunk_index = self.next_chunk_index.saturating_next_index();
                return Some(chunk);
            }

            return None;
        }

        let end = (self.offset + MAX_TRANSFER_FRAME_PAYLOAD_BYTES).min(self.data.len());
        let is_final_data_chunk = end == self.data.len();
        let chunk = StreamChunk {
            request_id: self.request_id,
            chunk_index: self.next_chunk_index,
            is_last: self.is_last && is_final_data_chunk,
            is_error: self.is_error,
            payload_kind: self.payload_kind,
            data: self.data[self.offset..end].to_vec(),
        };

        self.offset = end;
        self.next_chunk_index = self.next_chunk_index.saturating_next_index();

        Some(chunk)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect_split_chunks(
        starting_chunk_index: ChunkIndex,
        payload_kind: StreamPayloadKind,
        is_error: bool,
        data: &[u8],
        is_last: bool,
    ) -> (Vec<StreamChunk>, ChunkIndex) {
        let mut frames = split_stream_chunk_bytes(
            StreamChunkFrameRequest::new(RequestId::new(42), data)
                .starting_chunk_index(starting_chunk_index)
                .payload_kind(payload_kind)
                .is_error(is_error)
                .is_last(is_last),
        );
        let chunks: Vec<_> = (&mut frames).collect();
        (chunks, frames.next_chunk_index())
    }

    #[test]
    fn test_stream_chunk_serialization() {
        let chunk = StreamChunk {
            request_id: RequestId::new(123),
            chunk_index: ChunkIndex::new(0),
            is_last: false,
            is_error: false,
            payload_kind: StreamPayloadKind::RawFile,
            data: vec![1u8, 2u8, 3u8, 4u8],
        };
        let bytes = chunk.to_bytes();
        let decoded = StreamChunk::from_bytes(&bytes).unwrap();
        println!(
            "Decoded: request_id={}, chunk_index={}, is_last={}, is_error={}, payload_kind={:?}, data.len={}, data={:?}",
            decoded.request_id,
            decoded.chunk_index,
            decoded.is_last,
            decoded.is_error,
            decoded.payload_kind,
            decoded.data.len(),
            decoded.data
        );
        assert_eq!(decoded.request_id, RequestId::new(123));
        assert_eq!(decoded.chunk_index, ChunkIndex::new(0));
        assert!(!decoded.is_last);
        assert!(!decoded.is_error);
        assert_eq!(decoded.payload_kind, StreamPayloadKind::RawFile);
        assert_eq!(decoded.data, vec![1u8, 2u8, 3u8, 4u8]);
    }

    #[test]
    fn test_stream_chunk_last_chunk() {
        let chunk = StreamChunk {
            request_id: RequestId::new(456),
            chunk_index: ChunkIndex::new(10),
            is_last: true,
            is_error: false,
            payload_kind: StreamPayloadKind::RawFile,
            data: Vec::<u8>::new(),
        };
        let bytes = chunk.to_bytes();
        let decoded = StreamChunk::from_bytes(&bytes).unwrap();
        assert_eq!(decoded.request_id, RequestId::new(456));
        assert_eq!(decoded.chunk_index, ChunkIndex::new(10));
        assert!(decoded.is_last);
        assert!(!decoded.is_error);
        assert_eq!(decoded.payload_kind, StreamPayloadKind::RawFile);
        assert_eq!(decoded.data, Vec::<u8>::new());
    }

    #[test]
    fn test_stream_chunk_tar_serialization() {
        let chunk = StreamChunk {
            request_id: RequestId::new(789),
            chunk_index: ChunkIndex::new(2),
            is_last: false,
            is_error: false,
            payload_kind: StreamPayloadKind::Tar,
            data: vec![9u8, 8u8, 7u8],
        };
        let bytes = chunk.to_bytes();
        let decoded = StreamChunk::from_bytes(&bytes).unwrap();

        assert_eq!(decoded.request_id, RequestId::new(789));
        assert_eq!(decoded.chunk_index, ChunkIndex::new(2));
        assert_eq!(decoded.payload_kind, StreamPayloadKind::Tar);
        assert_eq!(decoded.data, vec![9u8, 8u8, 7u8]);
    }

    #[test]
    fn test_stream_chunk_invalid_magic() {
        let mut bytes = vec![0u8; 24];
        bytes[0..4].copy_from_slice(&[0, 0, 0, 0]);
        assert!(StreamChunk::from_bytes(&bytes).is_err());
    }

    #[test]
    fn test_stream_chunk_invalid_payload_kind() {
        let mut bytes = vec![0u8; HEADER_SIZE];
        bytes[0..4].copy_from_slice(&PROTOCOL_MAGIC.to_le_bytes());
        bytes[22] = 2;

        assert!(StreamChunk::from_bytes(&bytes).is_err());
    }

    #[test]
    fn test_stream_chunk_too_short() {
        let bytes = vec![0u8; 10];
        assert!(StreamChunk::from_bytes(&bytes).is_err());
    }

    #[test]
    fn test_protocol_constants() {
        assert_eq!(PROTOCOL_MAGIC, 0x52415844);
        assert_eq!(HEADER_SIZE, 23);
        assert_eq!(CHUNK_SIZE, 64 * 1024);
        assert_eq!(MAX_TRANSFER_FRAME_PAYLOAD_BYTES, 8 * 1024);
    }

    #[test]
    fn test_split_stream_chunk_exact_boundary() {
        let data = vec![7u8; MAX_TRANSFER_FRAME_PAYLOAD_BYTES];
        let (chunks, next_chunk_index) = collect_split_chunks(
            ChunkIndex::new(3),
            StreamPayloadKind::RawFile,
            false,
            &data,
            true,
        );

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].chunk_index, ChunkIndex::new(3));
        assert!(chunks[0].is_last);
        assert_eq!(chunks[0].data, data);
        assert_eq!(next_chunk_index, ChunkIndex::new(4));
    }

    #[test]
    fn test_split_stream_chunk_one_byte_over_boundary() {
        let data = vec![9u8; MAX_TRANSFER_FRAME_PAYLOAD_BYTES + 1];
        let (chunks, next_chunk_index) = collect_split_chunks(
            ChunkIndex::new(0),
            StreamPayloadKind::RawFile,
            false,
            &data,
            true,
        );

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chunk_index, ChunkIndex::new(0));
        assert!(!chunks[0].is_last);
        assert_eq!(chunks[0].data.len(), MAX_TRANSFER_FRAME_PAYLOAD_BYTES);
        assert_eq!(chunks[1].chunk_index, ChunkIndex::new(1));
        assert!(chunks[1].is_last);
        assert_eq!(chunks[1].data, vec![9u8]);
        assert_eq!(next_chunk_index, ChunkIndex::new(2));
    }

    #[test]
    fn test_split_stream_chunk_empty_final_chunk() {
        let (chunks, next_chunk_index) = collect_split_chunks(
            ChunkIndex::new(11),
            StreamPayloadKind::Tar,
            false,
            &[],
            true,
        );

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].chunk_index, ChunkIndex::new(11));
        assert!(chunks[0].is_last);
        assert!(chunks[0].data.is_empty());
        assert_eq!(chunks[0].payload_kind, StreamPayloadKind::Tar);
        assert_eq!(next_chunk_index, ChunkIndex::new(12));
    }

    #[test]
    fn test_split_stream_chunk_large_error_payload() {
        let data = vec![5u8; MAX_TRANSFER_FRAME_PAYLOAD_BYTES * 2 + 3];
        let (chunks, next_chunk_index) = collect_split_chunks(
            ChunkIndex::new(8),
            StreamPayloadKind::Tar,
            true,
            &data,
            true,
        );

        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|chunk| chunk.is_error));
        assert_eq!(chunks[0].payload_kind, StreamPayloadKind::Tar);
        assert!(!chunks[0].is_last);
        assert!(!chunks[1].is_last);
        assert!(chunks[2].is_last);
        assert_eq!(chunks[2].data.len(), 3);
        assert_eq!(next_chunk_index, ChunkIndex::new(11));
    }

    #[test]
    fn test_split_stream_chunk_skips_empty_non_final_payload() {
        let (chunks, next_chunk_index) = collect_split_chunks(
            ChunkIndex::new(2),
            StreamPayloadKind::RawFile,
            false,
            &[],
            false,
        );

        assert!(chunks.is_empty());
        assert_eq!(next_chunk_index, ChunkIndex::new(2));
    }

    #[test]
    fn test_split_stream_chunk_preserves_chunk_indexes() {
        let data = vec![1u8; MAX_TRANSFER_FRAME_PAYLOAD_BYTES * 2];
        let (chunks, next_chunk_index) = collect_split_chunks(
            ChunkIndex::new(5),
            StreamPayloadKind::RawFile,
            false,
            &data,
            false,
        );

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chunk_index, ChunkIndex::new(5));
        assert_eq!(chunks[1].chunk_index, ChunkIndex::new(6));
        assert!(!chunks[0].is_last);
        assert!(!chunks[1].is_last);
        assert_eq!(next_chunk_index, ChunkIndex::new(7));
    }
}
