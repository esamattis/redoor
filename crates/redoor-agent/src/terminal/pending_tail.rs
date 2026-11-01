//! Tracks the bytes of a UTF-8 character or escape sequence that output has started but not
//! finished, so a snapshot taken between two chunks can hand the browser the same prefix.
//!
//! The emulator keeps such a prefix in its parser state, and the live output after a
//! snapshot starts with the rest of it. The formatter writes the screen, not the parser
//! state, so without the prefix the browser would see half a sequence and print it as text.
//! `libghostty-vt` does not expose its parser state, so this is a minimal byte-level parser
//! that only finds where the stream was last in the ground state.

/// Largest prefix kept. A longer sequence (a huge OSC 52 clipboard write) is cut down to
/// its opener, which loses only that sequence's content.
pub(crate) const MAX_PENDING_TAIL_BYTES: usize = 4096;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
/// CAN and SUB abort any sequence in progress.
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;

/// Where the byte parser is between two bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ParserState {
    /// Nothing is in progress; the next byte starts something new.
    Ground,
    /// Inside a multi-byte UTF-8 character, with this many continuation bytes still due.
    Utf8(u8),
    /// After ESC.
    Escape,
    /// After ESC and one or more intermediate bytes (charset selection and the like).
    EscapeIntermediate,
    /// Inside a CSI sequence.
    Csi,
    /// Inside an OSC string, which BEL or ST ends.
    Osc,
    /// Inside a DCS, SOS, PM or APC string, which only ST ends.
    String,
    /// After ESC inside an OSC or other string: `\` completes ST, anything else starts a new
    /// escape sequence.
    StringEscape,
}

/// Bytes of an unfinished sequence, replayed after a snapshot.
#[derive(Debug)]
pub(crate) struct PendingTail {
    state: ParserState,
    /// Raw bytes fed since the stream was last in the ground state.
    bytes: Vec<u8>,
    /// Set when the unfinished sequence outgrew the cap; `bytes` then holds only its opener.
    truncated: bool,
}

impl Default for PendingTail {
    fn default() -> Self {
        Self {
            state: ParserState::Ground,
            bytes: Vec::new(),
            truncated: false,
        }
    }
}

impl PendingTail {
    /// Follows one chunk of output exactly as it was fed to the emulator.
    pub(crate) fn feed(&mut self, chunk: &[u8]) {
        let mut ground_end = None;
        for (index, &byte) in chunk.iter().enumerate() {
            self.state = next_state(self.state, byte);
            if self.state == ParserState::Ground {
                ground_end = Some(index + 1);
            }
        }
        if let Some(end) = ground_end {
            self.bytes.clear();
            self.truncated = false;
            self.append(&chunk[end..]);
        } else {
            self.append(chunk);
        }
    }

    /// The prefix a fresh emulator needs so the next live byte continues the same sequence.
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Adds bytes of the unfinished sequence, cutting it to its opener past the cap.
    fn append(&mut self, bytes: &[u8]) {
        if self.truncated || bytes.is_empty() {
            return;
        }
        if self.bytes.len() + bytes.len() <= MAX_PENDING_TAIL_BYTES {
            self.bytes.extend_from_slice(bytes);
            return;
        }
        // Replaying an opener keeps the rest of the sequence inside a sequence in the browser,
        // where it is ignored as malformed instead of being printed as text.
        self.bytes.clear();
        self.bytes.extend_from_slice(opener(self.state));
        self.truncated = true;
    }
}

/// The bytes that put a fresh parser back into the kind of sequence `state` is in.
fn opener(state: ParserState) -> &'static [u8] {
    match state {
        ParserState::Csi => b"\x1b[",
        ParserState::Osc => b"\x1b]",
        ParserState::String | ParserState::StringEscape => b"\x1bP",
        ParserState::Escape | ParserState::EscapeIntermediate => b"\x1b",
        ParserState::Ground | ParserState::Utf8(_) => b"",
    }
}

/// Advances the parser by one byte.
fn next_state(state: ParserState, byte: u8) -> ParserState {
    use ParserState::*;
    if matches!(byte, CAN | SUB) && state != Ground {
        return Ground;
    }
    match state {
        Ground => ground(byte),
        Utf8(remaining) => {
            if (0x80..=0xbf).contains(&byte) {
                if remaining <= 1 {
                    Ground
                } else {
                    Utf8(remaining - 1)
                }
            } else {
                // A broken character ends there; the byte starts something new.
                ground(byte)
            }
        }
        Escape => escape(byte),
        EscapeIntermediate => match byte {
            ESC => Escape,
            0x20..=0x2f => EscapeIntermediate,
            0x30..=0x7e => Ground,
            _ => EscapeIntermediate,
        },
        Csi => match byte {
            ESC => Escape,
            0x40..=0x7e => Ground,
            _ => Csi,
        },
        Osc => match byte {
            BEL => Ground,
            ESC => StringEscape,
            _ => Osc,
        },
        String => match byte {
            ESC => StringEscape,
            _ => String,
        },
        StringEscape => match byte {
            b'\\' => Ground,
            _ => escape(byte),
        },
    }
}

/// The state after `byte` in the ground state.
fn ground(byte: u8) -> ParserState {
    match byte {
        ESC => ParserState::Escape,
        0xc2..=0xdf => ParserState::Utf8(1),
        0xe0..=0xef => ParserState::Utf8(2),
        0xf0..=0xf4 => ParserState::Utf8(3),
        _ => ParserState::Ground,
    }
}

/// The state after `byte` following ESC.
fn escape(byte: u8) -> ParserState {
    match byte {
        b'[' => ParserState::Csi,
        b']' => ParserState::Osc,
        b'P' | b'X' | b'^' | b'_' => ParserState::String,
        ESC => ParserState::Escape,
        0x20..=0x2f => ParserState::EscapeIntermediate,
        _ => ParserState::Ground,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds each chunk and returns the tail after the last one.
    fn tail_after(chunks: &[&[u8]]) -> Vec<u8> {
        let mut tail = PendingTail::default();
        for chunk in chunks {
            tail.feed(chunk);
        }
        tail.bytes().to_vec()
    }

    #[test]
    fn finished_output_leaves_no_tail() {
        // Plain text, a full CSI, a full OSC and a full UTF-8 character need no replay.
        assert!(tail_after(&[b"text \x1b[31mred\x1b]0;title\x07 \xc3\xa4"]).is_empty());
    }

    #[test]
    fn keeps_the_unfinished_prefix_across_chunks() {
        // Half a UTF-8 character must be replayed so its second byte completes it.
        assert_eq!(tail_after(&[b"ok \xe2\x82"]), b"\xe2\x82");
        // A CSI split over two chunks keeps both parts until it ends.
        assert_eq!(tail_after(&[b"a\x1b[3", b"8;5"]), b"\x1b[38;5");
        // The final byte of the CSI completes it, so nothing is kept after it.
        assert!(tail_after(&[b"a\x1b[3", b"1mb"]).is_empty());
        // An OSC waits for its BEL or ST.
        assert_eq!(tail_after(&[b"\x1b]0;ti", b"tle"]), b"\x1b]0;title");
        assert!(tail_after(&[b"\x1b]0;ti", b"tle\x1b", b"\\"]).is_empty());
        // A DCS ends only with ST, not BEL.
        assert_eq!(tail_after(&[b"\x1bPq\x07"]), b"\x1bPq\x07");
    }

    #[test]
    fn cuts_an_oversized_sequence_to_its_opener() {
        let mut long = b"\x1b]52;c;".to_vec();
        long.extend(std::iter::repeat_n(b'A', MAX_PENDING_TAIL_BYTES * 2));
        // The prefix is bounded, and the opener keeps the rest of the sequence out of the
        // browser's text.
        assert_eq!(tail_after(&[&long]), b"\x1b]");
        // Once the sequence ends, the next one is tracked normally again.
        assert_eq!(tail_after(&[&long, b"\x07x\x1b["]), b"\x1b[");
    }
}
