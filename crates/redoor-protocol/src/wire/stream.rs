//! Binary framing for stream data on the multiplexed agent connection.
//!
//! Every binary websocket message is one frame of one stream: an 8-byte stream id, a flags
//! byte and up to 64 KiB of payload. Request streams use the request id as their stream id;
//! terminals and log streams get their own ids from the same per-connection id space.
//!
//! A stream that completes ends with a `FIN` frame. A request stream that fails simply stops:
//! its result, which always follows the stream's data, carries the error.

use crate::ids::RequestId;
use anyhow::{Result, bail};
use bytes::Bytes;

/// Fixed header length: stream id (8) + flags (1), so the payload offset is known without
/// parsing.
pub const HEADER_SIZE: usize = 9;
/// Preferred file read size for disk IO before websocket framing.
pub const CHUNK_SIZE: usize = 64 * 1024;
/// Keeps allocations, queue residency and the wait a control frame can see behind one data
/// frame small while many streams share one connection.
pub const MAX_TRANSFER_FRAME_PAYLOAD_BYTES: usize = 64 * 1024;
/// Largest binary message either side accepts.
pub const MAX_STREAM_MESSAGE_BYTES: usize = HEADER_SIZE + MAX_TRANSFER_FRAME_PAYLOAD_BYTES;

/// Payloads smaller than this are copied out of the received websocket message instead of
/// sliced from it.
///
/// A slice keeps the whole allocation it came from alive, and tungstenite cuts every message
/// out of one shared read buffer (128 KiB initially, at least 64 KiB when it grows), so any
/// sliced payload pins that whole buffer while it is queued. Copying everything below half a
/// frame keeps the pinned memory within a few times the payload, so the per-stream memory
/// bound stays meaningful, while full transfer frames, the ones worth not copying, still skip
/// the copy.
pub const SMALL_PAYLOAD_COPY_BYTES: usize = 32 * 1024;

/// Flag bit marking the final frame of a completed stream.
const FLAG_FIN: u8 = 0x01;

/// Non-terminal frames a receiver initially allows in flight per request or log stream.
///
/// Together with the 64 KiB frame size this bounds the memory one stream can occupy on its
/// receiver to `(window + 1)` frames, independently of how many streams share a connection.
pub const STREAM_CREDIT_WINDOW_FRAMES: u32 = 4;
/// Window of terminal streams in both directions.
///
/// Terminal frames are small keystroke and output bursts, so a larger window keeps typing and
/// output smooth without waiting for a grant round trip, while still bounding memory.
pub const TERMINAL_CREDIT_WINDOW_FRAMES: u32 = 16;
/// Receivers return credit in batches so a grant is not sent for every single frame.
///
/// Must not exceed the smallest window, or a drained receiver could hold back credit the
/// sender needs.
pub const STREAM_CREDIT_BATCH_FRAMES: u32 = 2;

/// Receive queue depth of a stream with `window` frames of credit: the full window plus the
/// `FIN` frame, which is exempt from credit so completion can never wait for a grant.
pub const fn receive_queue_frames(window: u32) -> usize {
    window as usize + 1
}

/// One binary frame of one stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamChunk {
    /// Stream the frame belongs to (the request id for request streams).
    pub request_id: RequestId,
    /// FIN: the stream completed and no frame of it follows.
    pub is_last: bool,
    /// Payload bytes; shared rather than owned so frames move between the socket, queues and
    /// HTTP bodies without copying.
    pub data: Bytes,
}

impl StreamChunk {
    /// A data frame; `is_last` marks the successful end of the stream.
    ///
    /// Accepts anything convertible into [`Bytes`] so callers holding a `Vec<u8>` hand over
    /// its allocation instead of copying it.
    pub fn data(request_id: RequestId, data: impl Into<Bytes>, is_last: bool) -> Self {
        Self {
            request_id,
            is_last,
            data: data.into(),
        }
    }

    /// Whether sending this frame spends one frame of per-stream credit.
    ///
    /// `FIN` frames are exempt: each stream has at most one, the receive queue reserves a slot
    /// for it, and requiring credit for it would let a stalled consumer block completion.
    pub fn consumes_credit(&self) -> bool {
        !self.is_last
    }

    /// Serializes the frame into its binary wire form for one websocket message.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(HEADER_SIZE + self.data.len());
        bytes.extend_from_slice(&self.request_id.to_le_bytes());
        bytes.push(if self.is_last { FLAG_FIN } else { 0 });
        bytes.extend_from_slice(&self.data);
        bytes
    }

    /// Parses and validates a binary websocket message, rejecting short or oversized frames
    /// and unknown flags so corrupt data is never treated as stream content.
    ///
    /// Takes the message by value so large payloads are sliced out of it without a copy; small
    /// ones are copied (see [`SMALL_PAYLOAD_COPY_BYTES`]) so they do not pin the websocket
    /// reader's shared read buffer.
    pub fn from_bytes(bytes: Bytes) -> Result<Self> {
        if bytes.len() < HEADER_SIZE {
            bail!(
                "Frame too short: {} bytes (minimum {})",
                bytes.len(),
                HEADER_SIZE
            );
        }
        if bytes.len() > MAX_STREAM_MESSAGE_BYTES {
            bail!("Frame too long: {} bytes", bytes.len());
        }
        let request_id = RequestId::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]);
        let flags = bytes[8];
        if flags & !FLAG_FIN != 0 {
            bail!("Unknown frame flags: 0x{flags:02x}");
        }
        let payload = &bytes[HEADER_SIZE..];
        let data = if payload.len() < SMALL_PAYLOAD_COPY_BYTES {
            Bytes::copy_from_slice(payload)
        } else {
            bytes.slice(HEADER_SIZE..)
        };
        Ok(Self {
            request_id,
            is_last: flags & FLAG_FIN != 0,
            data,
        })
    }

    /// Splits one logical payload into frame-sized chunks; `is_last` marks the final one.
    ///
    /// An empty final payload still yields one (empty) FIN frame, so a stream can always be
    /// ended; an empty non-final payload yields nothing. Frames share `data`'s buffer instead
    /// of copying it.
    pub fn split(
        request_id: RequestId,
        data: Bytes,
        is_last: bool,
    ) -> impl Iterator<Item = StreamChunk> {
        let pieces = data.len().div_ceil(MAX_TRANSFER_FRAME_PAYLOAD_BYTES);
        let count = if pieces == 0 && is_last { 1 } else { pieces };
        (0..count).map(move |index| {
            let start = index * MAX_TRANSFER_FRAME_PAYLOAD_BYTES;
            let end = (start + MAX_TRANSFER_FRAME_PAYLOAD_BYTES).min(data.len());
            StreamChunk::data(
                request_id,
                data.slice(start.min(end)..end),
                is_last && index + 1 == count,
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies data and FIN frames survive the round trip.
    #[test]
    fn frames_round_trip() {
        for frame in [
            StreamChunk::data(RequestId::new(123), vec![1, 2, 3], false),
            StreamChunk::data(RequestId::new(u64::MAX), Vec::new(), true),
            StreamChunk::data(
                RequestId::new(7),
                vec![5; MAX_TRANSFER_FRAME_PAYLOAD_BYTES],
                false,
            ),
        ] {
            // Both sides must decode exactly what the other side encoded.
            assert_eq!(
                StreamChunk::from_bytes(Bytes::from(frame.to_bytes())).unwrap(),
                frame
            );
        }
    }

    /// Verifies the header layout the fake agents in the integration tests encode by hand.
    #[test]
    fn header_is_stream_id_then_flags() {
        let bytes = StreamChunk::data(RequestId::new(0x0102), vec![9], true).to_bytes();
        // Little-endian stream id, then FIN, then the payload.
        assert_eq!(bytes, vec![0x02, 0x01, 0, 0, 0, 0, 0, 0, 0x01, 9]);
    }

    /// Verifies malformed frames are rejected instead of misread.
    #[test]
    fn malformed_frames_are_rejected() {
        // Shorter than the header.
        assert!(StreamChunk::from_bytes(Bytes::from_static(&[0; 8])).is_err());
        // An unknown flag bit means a corrupt sender; failures travel in results instead.
        let mut bytes = vec![0; HEADER_SIZE];
        bytes[8] = 0x02;
        assert!(StreamChunk::from_bytes(Bytes::from(bytes)).is_err());
        // Oversized payloads would defeat the per-frame memory bound.
        assert!(
            StreamChunk::from_bytes(Bytes::from(vec![0; MAX_STREAM_MESSAGE_BYTES + 1])).is_err()
        );
    }

    /// Verifies small payloads are copied out of the message while large ones share it.
    #[test]
    fn small_payloads_do_not_pin_the_message_buffer() {
        let message = |payload: usize| {
            Bytes::from(StreamChunk::data(RequestId::new(1), vec![3; payload], false).to_bytes())
        };
        let inside = |chunk: &StreamChunk, message: &Bytes| {
            let range = message.as_ptr_range();
            range.contains(&chunk.data.as_ptr())
        };

        let small = message(SMALL_PAYLOAD_COPY_BYTES - 1);
        let chunk = StreamChunk::from_bytes(small.clone()).unwrap();
        // A frame below half a frame (a keystroke or redraw burst) gets its own allocation, so
        // queuing it does not keep the websocket reader's whole read buffer alive.
        assert!(!inside(&chunk, &small));
        // The copy still carries the exact payload.
        assert_eq!(chunk.data.len(), SMALL_PAYLOAD_COPY_BYTES - 1);

        let large = message(SMALL_PAYLOAD_COPY_BYTES);
        let chunk = StreamChunk::from_bytes(large.clone()).unwrap();
        // A frame at the threshold is large enough that pinning the read buffer costs only a
        // few times its size, so it is sliced, not copied, to keep large transfers copy-free.
        assert!(inside(&chunk, &large));
        assert_eq!(chunk.data.len(), SMALL_PAYLOAD_COPY_BYTES);
    }

    /// Verifies payload splitting at frame boundaries.
    #[test]
    fn split_respects_frame_size_and_fin() {
        let exact = vec![7u8; MAX_TRANSFER_FRAME_PAYLOAD_BYTES];
        let frames: Vec<_> =
            StreamChunk::split(RequestId::new(1), Bytes::from(exact), true).collect();
        // Exactly one full frame carries FIN.
        assert_eq!(frames.len(), 1);
        assert!(frames[0].is_last);

        let over = vec![7u8; MAX_TRANSFER_FRAME_PAYLOAD_BYTES + 1];
        let frames: Vec<_> =
            StreamChunk::split(RequestId::new(1), Bytes::from(over), true).collect();
        // One byte over the limit needs a second frame, and only it is final.
        assert_eq!(frames.len(), 2);
        assert!(!frames[0].is_last && frames[1].is_last);
        assert_eq!(frames[1].data, vec![7u8]);

        // An empty final payload still ends the stream.
        let empty: Vec<_> = StreamChunk::split(RequestId::new(1), Bytes::new(), true).collect();
        assert_eq!(empty.len(), 1);
        assert!(empty[0].is_last && empty[0].data.is_empty());
        // An empty non-final payload sends nothing.
        assert_eq!(
            StreamChunk::split(RequestId::new(1), Bytes::new(), false).count(),
            0
        );
    }
}
