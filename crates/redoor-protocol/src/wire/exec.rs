//! Lossless bounded execution events shared by HTTP consumers and agent workers.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Keeps argv separate from environment so execution never implies shell parsing.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ExecRequest {
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[ts(type = "number | null")]
    pub timeout_ms: Option<u64>,
}

impl ExecRequest {
    /// Rejects invalid process inputs before accepting remote work.
    pub fn validate(&self) -> Result<(), String> {
        if self.argv.first().is_none_or(|arg| arg.is_empty())
            || self.argv.iter().any(|arg| arg.contains('\0'))
        {
            return Err("argv requires a nonempty command and cannot contain NUL".into());
        }
        if self
            .cwd
            .as_ref()
            .is_some_and(|cwd| !cwd.starts_with('/') || cwd.contains('\0'))
        {
            return Err("cwd must be an absolute remote path without NUL".into());
        }
        if self
            .env
            .iter()
            .any(|(key, value)| key.is_empty() || key.contains(['=', '\0']) || value.contains('\0'))
        {
            return Err(
                "environment requires nonempty keys without '=' or NUL, and values without NUL"
                    .into(),
            );
        }
        if self
            .timeout_ms
            .is_some_and(|ms| ms == 0 || ms > 31_536_000_000)
        {
            return Err("timeout must be positive and at most 365 days".into());
        }
        Ok(())
    }
}

/// One execution event of the NDJSON output stream.
///
/// Output bytes travel as standard padded base64 strings: like a byte array they are
/// binary-safe and keep UTF-8 sequences split across reads intact, but they cost about 1.33×
/// the output size instead of the ~3.5× of a JSON number array, and encode without a
/// per-byte formatting loop.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(tag = "type", rename_all = "snake_case")]
pub enum ExecEvent {
    Stdout {
        #[serde(with = "base64_data")]
        #[ts(type = "string")]
        data: Vec<u8>,
    },
    Stderr {
        #[serde(with = "base64_data")]
        #[ts(type = "string")]
        data: Vec<u8>,
    },
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
    },
    TimedOut,
    Canceled,
    Error {
        message: String,
    },
}

/// Output event that borrows the bytes of one pipe read.
///
/// The agent emits one of these per read, so serializing straight from the read buffer
/// avoids copying the bytes into an owned [`ExecEvent`] first. It mirrors the output
/// variants of [`ExecEvent`] and shares its base64 adapter, so both produce the same line.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecOutput<'a> {
    Stdout {
        #[serde(serialize_with = "base64_data::serialize")]
        data: &'a [u8],
    },
    Stderr {
        #[serde(serialize_with = "base64_data::serialize")]
        data: &'a [u8],
    },
}

impl ExecOutput<'_> {
    /// Fixed JSON around the base64 payload: `{"type":"stdout","data":""}` plus the newline;
    /// both variant names have the same length.
    const LINE_OVERHEAD: usize = r#"{"type":"stdout","data":""}"#.len() + 1;

    /// Largest pipe read the agent turns into one line. Shared so consumers that reassemble
    /// lines can bound their buffer by what an agent can actually send.
    pub const MAX_READ: usize = 8192;

    /// Longest possible output line including its newline: the base64 of a full read plus the
    /// fixed JSON around it.
    pub const MAX_LINE: usize = Self::LINE_OVERHEAD + 4 * Self::MAX_READ.div_ceil(3);

    /// Serializes the event as one NDJSON line into a buffer allocated once at its final
    /// size, because this runs for every read of a chatty process.
    pub fn ndjson_line(&self) -> Vec<u8> {
        let (Self::Stdout { data } | Self::Stderr { data }) = self;
        let capacity = Self::LINE_OVERHEAD + base64::encoded_len(data.len(), true).unwrap_or(0);
        let mut line = Vec::with_capacity(capacity);
        serde_json::to_writer(&mut line, self).expect("execution output always serializes");
        line.push(b'\n');
        line
    }
}

/// Serde adapter that writes output bytes as a standard padded base64 string.
mod base64_data {
    use base64::{Engine, display::Base64Display, engine::general_purpose::STANDARD};
    use serde::{Deserialize, Deserializer, Serializer};

    /// Streams the encoding into the serializer so no intermediate `String` is allocated.
    pub(super) fn serialize<S: Serializer>(
        data: &impl AsRef<[u8]>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&Base64Display::new(data.as_ref(), &STANDARD))
    }

    /// Decodes the base64 string back into raw bytes; the old number-array format is not
    /// accepted because agents and server always speak the same protocol version.
    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<u8>, D::Error> {
        let encoded = String::deserialize(deserializer)?;
        STANDARD
            .decode(encoded.as_bytes())
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies the borrowed agent fast path writes exactly what the owned event would.
    #[test]
    fn borrowed_output_line_matches_owned_event() {
        // Covers empty data, every padding length and bytes that are not valid UTF-8.
        let samples: [&[u8]; 5] = [b"", b"a", b"ab", b"abc", &[0xe2, 0x82, 0x00, 0xff, 0x7f]];
        for data in samples {
            for (borrowed, owned) in [
                (
                    ExecOutput::Stdout { data },
                    ExecEvent::Stdout {
                        data: data.to_vec(),
                    },
                ),
                (
                    ExecOutput::Stderr { data },
                    ExecEvent::Stderr {
                        data: data.to_vec(),
                    },
                ),
            ] {
                let mut expected = serde_json::to_vec(&owned).unwrap();
                expected.push(b'\n');
                let line = borrowed.ndjson_line();
                // Consumers parse both paths with the same type, so the bytes must be identical.
                assert_eq!(line, expected);
                // The up-front capacity is exact, so building the line never reallocates.
                assert_eq!(line.capacity(), line.len());
            }
        }
    }

    /// Verifies output is a standard padded base64 string that decodes back losslessly.
    #[test]
    fn output_data_is_padded_standard_base64() {
        let event = ExecEvent::Stdout {
            data: vec![0xfb, 0xff, b'h', b'i'],
        };
        let json = serde_json::to_string(&event).unwrap();
        // The standard alphabet uses `+`/`/` and pads to a multiple of four characters.
        assert_eq!(json, r#"{"type":"stdout","data":"+/9oaQ=="}"#);
        let decoded: ExecEvent = serde_json::from_str(&json).unwrap();
        // Binary bytes survive the round trip unchanged.
        assert!(matches!(decoded, ExecEvent::Stdout { data } if data == [0xfb, 0xff, b'h', b'i']));
    }

    /// Verifies the retired number-array encoding is rejected instead of misread.
    #[test]
    fn number_array_data_is_rejected() {
        // No compatibility is kept, so the old format must fail loudly.
        assert!(
            serde_json::from_str::<ExecEvent>(r#"{"type":"stdout","data":[104,105]}"#).is_err()
        );
    }
}
