use crate::types::{ChunkIndex, RequestId};

pub const PROTOCOL_MAGIC: u32 = 0x52415844;
pub const HEADER_SIZE: usize = 23;
pub const CHUNK_SIZE: usize = 64 * 1024;

/// Identifies how the chunk payload bytes should be interpreted by the receiver.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamPayloadKind {
    RawFile = 0,
    Tar = 1,
}

impl StreamPayloadKind {
    fn from_byte(byte: u8) -> Result<Self, String> {
        match byte {
            0 => Ok(Self::RawFile),
            1 => Ok(Self::Tar),
            _ => Err(format!("Invalid payload kind byte: {}", byte)),
        }
    }
}

#[derive(Debug, Clone)]
pub struct StreamChunk {
    pub request_id: RequestId,
    pub chunk_index: ChunkIndex,
    pub is_last: bool,
    pub is_error: bool,
    /// Marks whether `data` contains raw file bytes or a tar stream chunk.
    pub payload_kind: StreamPayloadKind,
    pub data: Vec<u8>,
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

    pub fn parse_data(bytes: &[u8]) -> Result<Vec<u8>, String> {
        Self::from_bytes(bytes).map(|chunk| chunk.data)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < HEADER_SIZE {
            return Err(format!(
                "Chunk too short: {} bytes (minimum {})",
                bytes.len(),
                HEADER_SIZE
            ));
        }

        let magic = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        if magic != PROTOCOL_MAGIC {
            return Err(format!(
                "Invalid magic: 0x{:08x} (expected 0x{:08x})",
                magic, PROTOCOL_MAGIC
            ));
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

#[cfg(test)]
mod tests {
    use super::*;

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
    }
}
