//! Turns agent exec output into spoolable bytes, and retained output into text a model can
//! read directly: no NDJSON, no base64, no escaping in the text block.

use super::operations::SpoolState;
use redoor_protocol::wire::exec::{ExecEvent, ExecOutput};
use serde_json::Value;

/// Reassembles the agent's NDJSON exec lines across stream frames.
///
/// Frames are cut at arbitrary bytes, so a line can start in one frame and end in the next.
/// Only the unfinished line is buffered, and an agent line is never longer than
/// [`ExecOutput::MAX_LINE`], so the buffer stays small whatever the command prints.
#[derive(Default)]
pub(super) struct LineAssembler {
    partial: Vec<u8>,
}

/// Decoded bytes of one frame, split by pipe so each pipe goes to its own spool.
#[derive(Default, Debug, PartialEq, Eq)]
pub(super) struct DecodedOutput {
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
}

impl LineAssembler {
    /// Decodes every line the frame completes and keeps its unfinished end for the next one.
    pub(super) fn push(&mut self, frame: &[u8]) -> Result<DecodedOutput, String> {
        let mut decoded = DecodedOutput::default();
        let mut rest = frame;
        while let Some(newline) = rest.iter().position(|byte| *byte == b'\n') {
            let line = &rest[..newline];
            rest = &rest[newline + 1..];
            if self.partial.is_empty() {
                decode_line(line, &mut decoded)?;
            } else {
                self.extend(line)?;
                let line = std::mem::take(&mut self.partial);
                decode_line(&line, &mut decoded)?;
            }
        }
        self.extend(rest)?;
        Ok(decoded)
    }

    /// Rejects output that ended in the middle of a line, which the agent never sends.
    pub(super) fn finish(&self) -> Result<(), String> {
        if self.partial.is_empty() {
            Ok(())
        } else {
            Err("execution output ended in the middle of a line".into())
        }
    }

    /// Buffers part of an unfinished line, refusing more than any agent line can hold.
    fn extend(&mut self, bytes: &[u8]) -> Result<(), String> {
        if self.partial.len() + bytes.len() > ExecOutput::MAX_LINE {
            return Err(format!(
                "execution output line exceeds {} bytes",
                ExecOutput::MAX_LINE
            ));
        }
        self.partial.extend_from_slice(bytes);
        Ok(())
    }
}

/// Parses one exec line and appends its bytes to the pipe it came from.
fn decode_line(line: &[u8], decoded: &mut DecodedOutput) -> Result<(), String> {
    if line.is_empty() {
        return Ok(());
    }
    match serde_json::from_slice::<ExecEvent>(line) {
        Ok(ExecEvent::Stdout { data }) => decoded.stdout.extend_from_slice(&data),
        Ok(ExecEvent::Stderr { data }) => decoded.stderr.extend_from_slice(&data),
        // The status arrives on the terminal lane; the output stream never carries it.
        Ok(_) => {}
        Err(error) => return Err(format!("malformed execution output line: {error}")),
    }
    Ok(())
}

/// One pipe's page of retained output as text.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Page {
    pub(super) text: String,
    /// Retained offset where the next page starts.
    pub(super) next_offset: u64,
    /// Whether invalid UTF-8 was replaced with U+FFFD.
    pub(super) binary: bool,
}

/// Renders retained bytes `[start, start + bytes.len())` of a pipe read under `state`.
///
/// A page never ends inside a UTF-8 character: an incomplete character at its end is left
/// for the next page, unless the page reaches the end of output that can no longer grow
/// (`settled`). Where the head meets the tail, the characters the omitted gap cut in half are
/// dropped and a marker shows how many bytes are missing. `skip_partial_start` drops the
/// continuation bytes a page starting at an arbitrary offset may begin with.
pub(super) fn render_page(
    state: &SpoolState,
    start: u64,
    bytes: &[u8],
    settled: bool,
    skip_partial_start: bool,
) -> Page {
    let end = start + bytes.len() as u64;
    let gap = state.omitted() > 0;
    // Without a gap the tail continues the head directly, so the bytes decode as one piece
    // and a character spanning the two is not mistaken for invalid UTF-8.
    let split = if gap {
        (state.head.clamp(start, end) - start) as usize
    } else {
        bytes.len()
    };
    let (mut head, mut tail) = bytes.split_at(split);
    if skip_partial_start {
        if head.is_empty() {
            tail = &tail[continuation_prefix_len(tail)..];
        } else {
            head = &head[continuation_prefix_len(head)..];
        }
    }
    if gap && !head.is_empty() && end >= state.head {
        // The rest of this character is omitted, so it can never be shown.
        head = &head[..complete_prefix_len(head)];
    }
    if gap && start <= state.head {
        tail = &tail[continuation_prefix_len(tail)..];
    }
    let mut next_offset = end;
    let may_continue = !(settled && end == state.retained());
    if may_continue && !(gap && end == state.head) {
        let last = if bytes.len() > split {
            &mut tail
        } else {
            &mut head
        };
        let keep = complete_prefix_len(last);
        // Never trim a page to nothing mid-output, or the caller could not make progress;
        // callers give every page at least four bytes, so that only happens to invalid
        // bytes. At the end of a running command's output the character is still arriving,
        // so it is left for a later read instead.
        if keep > 0 || end - start > last.len() as u64 || end == state.retained() {
            next_offset = end - (last.len() - keep) as u64;
            *last = &last[..keep];
        }
    }
    let mut page = Page {
        text: String::new(),
        next_offset,
        binary: false,
    };
    page.push_text(head);
    let marker = gap && start <= state.head && (end > state.head || state.ring == 0);
    if marker {
        if !page.text.is_empty() && !page.text.ends_with('\n') {
            page.text.push('\n');
        }
        page.text
            .push_str(&format!("[... {} bytes omitted ...]\n", state.omitted()));
    }
    page.push_text(tail);
    page
}

impl Page {
    /// Appends bytes as text, replacing invalid UTF-8 and remembering that it did.
    fn push_text(&mut self, bytes: &[u8]) {
        match std::str::from_utf8(bytes) {
            Ok(text) => self.text.push_str(text),
            Err(_) => {
                self.binary = true;
                self.text.push_str(&String::from_utf8_lossy(bytes));
            }
        }
    }
}

/// Length of `bytes` without an incomplete UTF-8 character at its end (looking back at most
/// three bytes, the longest incomplete sequence).
fn complete_prefix_len(bytes: &[u8]) -> usize {
    let len = bytes.len();
    for back in 1..=len.min(3) {
        let byte = bytes[len - back];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let width = match byte {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => 1,
        };
        return if width > back { len - back } else { len };
    }
    len
}

/// Number of UTF-8 continuation bytes (at most three) at the start of `bytes`, which belong
/// to a character that started before them.
fn continuation_prefix_len(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .take(3)
        .take_while(|byte| **byte & 0xC0 == 0x80)
        .count()
}

/// Splits a byte budget between two pipes: each gets half, and what one does not need goes
/// to the other, so a quiet stderr never wastes the space stdout could use.
pub(super) fn split_budget(budget: u64, first: u64, second: u64) -> (u64, u64) {
    let first = first.min((budget / 2).max(budget.saturating_sub(second)));
    (first, second.min(budget - first))
}

/// Renders a command result for the MCP text block, which is what most clients show the
/// model: the outcome on one line, then each pipe's text unescaped.
pub(super) fn render_text(result: &Value) -> String {
    let id = result
        .get("operation_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let state = result
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut text = format!(
        "{} (operation {id})\n",
        status_line(state, result.get("termination").unwrap_or(&Value::Null))
    );
    let mut any = false;
    for pipe in ["stdout", "stderr"] {
        let Some(output) = result.get(pipe).and_then(Value::as_str) else {
            continue;
        };
        if output.is_empty() {
            continue;
        }
        any = true;
        text.push_str(&format!("--- {pipe} ---\n{output}"));
        if !output.ends_with('\n') {
            text.push('\n');
        }
    }
    if !any {
        text.push_str("(no output)\n");
    }
    if result.get("binary").and_then(Value::as_bool) == Some(true) {
        text.push_str("[output is not valid UTF-8; invalid bytes are shown as U+FFFD]\n");
    }
    if result.get("more").and_then(Value::as_bool) == Some(true) {
        let offsets = ["stdout", "stderr"]
            .into_iter()
            .filter_map(|pipe| {
                let offset = result.get("next_offsets")?.get(pipe)?;
                Some(format!(", {pipe}_offset={offset}"))
            })
            .collect::<String>();
        text.push_str(&format!(
            "[more output: call read_command_output with operation_id={id}{offsets}]\n"
        ));
    }
    text
}

/// Describes an operation's outcome the way a shell user would read it.
fn status_line(state: &str, termination: &Value) -> String {
    let field = |name: &str| termination.get(name).filter(|value| !value.is_null());
    match state {
        "completed" => match (field("code"), field("signal")) {
            (Some(code), _) => format!("exit code {code}"),
            (None, Some(signal)) => format!("killed by signal {signal}"),
            _ => "completed".into(),
        },
        "timed_out" => "timed out".into(),
        "interrupted" => "interrupted: the server restarted before the command finished".into(),
        "failed" => match ["message", "error", "reason"]
            .into_iter()
            .find_map(|name| field(name).and_then(Value::as_str))
        {
            Some(reason) => format!("failed: {reason}"),
            None => "failed".into(),
        },
        other => other.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};

    /// Builds the exact line an agent sends for one read.
    fn line(pipe: &str, data: &[u8]) -> Vec<u8> {
        format!(
            "{{\"type\":\"{pipe}\",\"data\":\"{}\"}}\n",
            STANDARD.encode(data)
        )
        .into_bytes()
    }

    /// Lines split at every possible frame boundary decode to the same bytes.
    #[test]
    fn reassembles_lines_across_frames() {
        let mut stream = line("stdout", b"hello ");
        stream.extend(line("stderr", b"oops"));
        stream.extend(line("stdout", b"world"));
        for cut in 0..=stream.len() {
            let mut assembler = LineAssembler::default();
            let mut decoded = DecodedOutput::default();
            for frame in [&stream[..cut], &stream[cut..]] {
                let part = assembler.push(frame).unwrap();
                decoded.stdout.extend(part.stdout);
                decoded.stderr.extend(part.stderr);
            }
            // Every split point yields the same per-pipe bytes, in order.
            assert_eq!(decoded.stdout, b"hello world", "cut at {cut}");
            assert_eq!(decoded.stderr, b"oops", "cut at {cut}");
            // Nothing is left over once the stream ends on a line boundary.
            assert!(assembler.finish().is_ok());
        }
    }

    /// A line longer than any agent can send fails instead of growing the buffer.
    #[test]
    fn rejects_overlong_and_malformed_lines() {
        let mut assembler = LineAssembler::default();
        let error = assembler
            .push(&vec![b'x'; ExecOutput::MAX_LINE + 1])
            .unwrap_err();
        // The cap bounds memory per operation regardless of what the stream contains.
        assert!(error.contains("exceeds"), "{error}");
        let mut assembler = LineAssembler::default();
        // A full-size agent line still fits, so the cap never rejects real output.
        let full = line("stdout", &[0xff; ExecOutput::MAX_READ]);
        assert_eq!(full.len(), ExecOutput::MAX_LINE);
        assert!(assembler.push(&full[..100]).is_ok());
        assert_eq!(
            assembler.push(&full[100..]).unwrap().stdout.len(),
            ExecOutput::MAX_READ
        );
        // Garbage is a protocol error, not silently dropped output.
        assert!(LineAssembler::default().push(b"not json\n").is_err());
        let mut assembler = LineAssembler::default();
        assembler.push(b"{\"type\"").unwrap();
        // A stream ending mid-line lost output and must be reported.
        assert!(assembler.finish().is_err());
    }

    /// State of a pipe whose output fully fits.
    fn whole(len: u64) -> SpoolState {
        SpoolState {
            total: len,
            head: len,
            ..SpoolState::default()
        }
    }

    /// Pages never split a character, and together they rebuild the text exactly.
    #[test]
    fn pages_do_not_split_utf8_characters() {
        let text = "aé€😀b".repeat(5);
        let bytes = text.as_bytes();
        let state = whole(bytes.len() as u64);
        for limit in 4..=9 {
            let mut offset = 0u64;
            let mut rebuilt = String::new();
            while offset < state.retained() {
                let end = (offset + limit).min(state.retained());
                let page = render_page(
                    &state,
                    offset,
                    &bytes[offset as usize..end as usize],
                    true,
                    false,
                );
                // A clean cut never needs a replacement character.
                assert!(!page.binary, "limit {limit} offset {offset}");
                // Every page makes progress, so paging always terminates.
                assert!(page.next_offset > offset);
                rebuilt.push_str(&page.text);
                offset = page.next_offset;
            }
            // Concatenated pages are exactly the original text.
            assert_eq!(rebuilt, text, "limit {limit}");
        }
    }

    /// A running command's incomplete last character is left unread instead of replaced.
    #[test]
    fn leaves_an_incomplete_trailing_character_of_running_output() {
        let partial = &"😀".as_bytes()[..2];
        let page = render_page(&whole(2), 0, partial, false, false);
        // Nothing is shown yet, so no replacement character appears for valid output.
        assert_eq!(page.text, "");
        assert!(!page.binary);
        // The offset stays put, so the next read gets the whole character.
        assert_eq!(page.next_offset, 0);
    }

    /// The gap between head and tail is marked once, and characters it cut are dropped.
    #[test]
    fn marks_the_omitted_gap_between_head_and_tail() {
        // Head "ab" plus the first byte of "é"; tail starts with the last byte of "€".
        let state = SpoolState {
            total: 100,
            head: 3,
            ring: 3,
            ..SpoolState::default()
        };
        let retained = [b'a', b'b', 0xC3, 0xAC, b'z', b'\n'];
        let page = render_page(&state, 0, &retained, true, false);
        // The cut characters vanish instead of showing as replacement characters.
        assert!(!page.binary);
        // The marker sits where the head meets the tail and counts the missing bytes.
        assert_eq!(page.text, "ab\n[... 94 bytes omitted ...]\nz\n");
        // A page that ends at the gap leaves the marker to the page that crosses it.
        let first = render_page(&state, 0, &retained[..3], true, false);
        assert_eq!(first.text, "ab");
        let second = render_page(&state, first.next_offset, &retained[3..], true, false);
        assert_eq!(second.text, "[... 94 bytes omitted ...]\nz\n");
    }

    /// Invalid UTF-8 is shown lossily and flagged instead of being encoded.
    #[test]
    fn flags_binary_output() {
        let page = render_page(&whole(3), 0, &[0xff, b'o', b'k'], true, false);
        // The flag tells the model the text is not the exact bytes.
        assert!(page.binary);
        assert_eq!(page.text, "\u{FFFD}ok");
    }

    /// The text block shows outcome and output without JSON escaping.
    #[test]
    fn renders_text_block() {
        let result = serde_json::json!({
            "operation_id": "id",
            "state": "completed",
            "termination": {"type": "exit", "code": 1, "signal": null},
            "stdout": "line \"one\"\n",
            "stderr": "boom",
            "more": true,
            "next_offsets": {"stdout": 11, "stderr": 4},
        });
        // Models read this block, so it must be compact and literal.
        assert_eq!(
            render_text(&result),
            "exit code 1 (operation id)\n--- stdout ---\nline \"one\"\n--- stderr ---\nboom\n[more output: call read_command_output with operation_id=id, stdout_offset=11, stderr_offset=4]\n"
        );
    }

    /// Budgets go to the pipe that needs them.
    #[test]
    fn splits_budget_between_pipes() {
        // A quiet pipe leaves the rest to the other one.
        assert_eq!(split_budget(100, 10, 500), (10, 90));
        assert_eq!(split_budget(100, 500, 10), (90, 10));
        // Two busy pipes share evenly.
        assert_eq!(split_budget(100, 500, 500), (50, 50));
    }
}
