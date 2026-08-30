# Grep Binary and Large-File Skipping Plan

## Current flow

- `POST /api/v1/grep` enters `content_grep_handler()` in `src/server/agents/content_grep.rs`, which validates the request and dispatches `Command::ContentGrep` to the agent. Keep filtering on the agent so the REST/control path remains lightweight and responsive.
- `execute_with_cancellation()` and `collect_matches()` in `src/commands/content_grep.rs` run the deadline/cancellation-aware incremental traversal. `collect_matches()` currently uses entry type and followed metadata for directories/symlinks, then calls `scan_file()` for every regular-file candidate.
- `scan_file()` currently opens each file, reads through an 8 KiB `BufReader`, bounds retained physical lines, and discards all tentative file matches if any chunk contains NUL. This protects responses from binary matches but can still open and scan large files and binary files without NUL bytes.
- `detect_mime_type()` and `is_browser_viewable_image_magic()` in `src/commands/metadata.rs` contain the existing common magic-byte checks for PDF, images, archives, executables, compressed files, audio, and video. They are private and partly overlap; their async prefix reader should not be used by grep because grep already has the first buffered chunk.

## Implementation

1. Add an 8 MiB file-size limit in `src/commands/content_grep.rs`. During `collect_matches()`, obtain followed metadata for each regular-file candidate using the metadata already loaded for symlinks or an async entry metadata lookup for direct files, and skip candidates whose `Metadata::len()` exceeds the limit before `scan_file()` can open them. Pass only eligible paths onward; do not add whole-tree collection or whole-file buffering.
2. In `scan_file()`, inspect the first non-empty result from `BufReader::fill_buf()` before processing lines or retaining matches. Skip the entire file when that chunk has a recognized binary signature, while retaining the existing all-chunk NUL check so binary content without known magic, including a late NUL after tentative matches, is still suppressed.
3. Refactor the pure signature checks in `src/commands/metadata.rs` into a shared command-internal classifier/predicate usable by both metadata MIME/image detection and content grep. Preserve the metadata endpoint's existing MIME and browser-viewability behavior and tests, distinguish explicitly textual signatures such as shebang/BOM from binary signatures, and consolidate overlapping image signatures where practical. Grep should call the byte-slice classifier directly on its existing first chunk rather than invoke `read_file_prefix()` or reopen the file.
4. Preserve best-effort traversal semantics: an entry metadata failure should skip only that entry, as current file-type/open/read failures do; an open or read failure in `scan_file()` should continue to suppress only that file. Treat the metadata size as a pre-open optimization rather than a race-free guarantee because a file may grow or be replaced between metadata and open; existing bounded-line memory controls, deadline cancellation, the exclusive grep slot, and Tokio async filesystem/I/O APIs must remain intact.
5. Keep the response schema and truncation counters unchanged: skipped oversized/binary files produce no matches and do not count as omitted long lines. Empty files and files exactly 8 MiB remain eligible; symlinks to regular files use followed target size; directories, special files, ignore rules, hidden-file policy, symlink-cycle handling, and late-NUL behavior remain unchanged.

## Tests

- Extend `grep_is_bounded_and_discards_binary_file_matches()` or add focused unit tests beside `scan_file()` in `src/commands/content_grep.rs` for a known-magic binary containing the query but no NUL, an oversized text file containing the query, the exact 8 MiB boundary, and continued late-NUL suppression. Include assertion comments explaining each behavior.
- Keep or extend the signature-focused tests in `src/commands/metadata.rs` to prove the shared refactor preserves MIME/image classification and that textual signatures are not treated as binary. Add direct classifier coverage for representative common signatures and short prefixes.
- Extend the grep workflow in `tests/agents.test.ts` with no-NUL magic-byte and greater-than-8-MiB fixtures, asserting the REST response excludes them while ordinary eligible text still matches. Retain the existing responsiveness/cancellation test as regression coverage; do not introduce sleeps.

## Verification

1. Run focused Rust tests with `mise exec -- cargo test commands::content_grep` and `mise exec -- cargo test commands::metadata`.
2. Build the current debug binary, then run the affected integration suite with `mise exec -- cargo build` and `mise exec -- pn integration-test tests/agents.test.ts`.
3. Run the required full suite with `mise exec -- pn test` using a timeout of at least 600 seconds. Inspect `log/` on failures and record any transient test that passes on rerun in `flaky-tests.md`.
