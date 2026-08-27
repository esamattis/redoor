# Structured Logging Plan

## Scope and semantics

- Replace string-only live log entries with one canonical structured record shared by the server logger, agent logger, WebSocket protocol, and UI. Keep logging bounded and non-blocking so slow file output or viewers cannot block control commands.
- Model a record as `LogEntry { timestamp, level, message, error }`. Export it with `#[ts(export)]`; use an RFC 3339 timestamp with milliseconds and an explicit offset, the existing `Level` enum, the human-facing message without timestamp/level prefixes, and nullable error details.
- Model error details as `LogErrorDetails { chain, backtrace }`. `chain` is the complete anyhow debug rendering requested by the feature (`format!("{error:?}")`); `backtrace` is a separate string obtained from the anyhow error backtrace. Keep both fields out of ordinary records rather than encoding them into the message.
- Establish and test the backtrace policy explicitly. Prefer the backtrace captured by `anyhow::Error` because it points at error construction; when capture is disabled, send an empty/null backtrace state and have the UI say that no backtrace was captured rather than presenting a logging-site stack as the original failure. Document that operators must enable Rust backtraces when they require stack capture.
- Keep `warning` behavior distinct from errors. Warnings receive warning styling but do not become clickable error records unless they intentionally carry structured error details in a later feature.
- Retain at most the latest 1,000 structured entries in process memory for browser snapshots, alongside the bounded producer and live-broadcast queues. Preserve the lag event followed by reconnect and existing WebSocket frame limits. Add explicit maximum lengths for error chains and backtraces before enqueueing/serialization, with a visible truncation marker, so one pathological error cannot consume unbounded memory or exceed the agent relay's 256 KiB frame limit.

## Logger model and output formats

- Refactor `src/logging.rs` so formatting is a sink concern rather than part of `LogMessage`. Producers enqueue owned structured `LogEntry` values; the logger writes each accepted record and broadcasts the same structured value only after file/stdout handling preserves ordering.
- Add a serializable `LogFormat` enum with `line` and `json`. Default to `line` to preserve existing operator behavior and external consumers unless a later compatibility decision deliberately changes the default.
- Keep `line` output compatible with the current representation: `[YYYY-MM-DD HH:mm:ss.SSS] [LEVEL] message`. Do not append multiline error diagnostics to the normal line. The browser receives the in-memory structured record and does not parse this representation.
- Define `json` output as newline-delimited JSON, one complete `LogEntry` per physical line. JSON output includes `timestamp`, lowercase `level`, `message`, and nullable structured error details for external consumers while remaining streamable with `tail` and the existing `server logs`/`agent logs` commands.
- Keep stdout and the configured file on the same selected format so redirected managed-agent/SSH output is not ambiguous. Logger-internal failures must continue to use direct stderr fallback to avoid recursive logging.
- Remove file-backed browser history and `read_latest_entries`. Log files are output artifacts only and are never opened or parsed to initialize a WebSocket snapshot.
- Make the logger task own a `VecDeque<LogEntry>` capped at exactly 1,000 entries. After writing an accepted record to stdout/file, append the same structured record to the deque, evict the oldest entry when over capacity, and publish it to live subscribers.
- Subscription setup captures a clone of the current deque and creates the live receiver at one logger command boundary. This gives every server or agent log socket a deterministic snapshot/live boundary without duplicate or missing records while producers remain non-blocking.
- Accept that browser history begins with the current process lifetime. After a server or agent restart, the browser can replay only records emitted since that process initialized its logger; operators use the raw log file commands for older persisted output.
- Keep synthetic queue-overflow notices structured (`warning` level, normal message, no error details). Ensure multiline messages remain one structured record and are escaped into one NDJSON line in JSON mode.

## Dedicated error API and migration

- Add a dedicated public function such as `logging::log_error(message: String, error: &anyhow::Error)`. It checks `enabled(Level::Error)` before rendering expensive diagnostics, captures `format!("{error:?}")` and `error.backtrace()` synchronously into owned bounded strings, and enqueues a structured error record at `Level::Error`.
- Keep the regular `log!` macro for trace/debug/info/warning records. Migrate every runtime `log!(Level::Error, ...)` call to `log_error`; add a source-level guard test or lint/search check that fails when a new `log!(Level::Error, ...)` call is introduced outside logger tests.
- For existing `anyhow::Error` values, pass the error directly and make the short message describe the failed operation without repeating the complete chain.
- For typed standard errors (`std::io::Error`, `serde_json::Error`, `JoinError`, channel errors, and project `thiserror` types), convert to `anyhow::Error` and add operation context before logging. Preserve the typed value until conversion instead of formatting it into a string first.
- Change SSH/relay/watchdog paths that currently return `Box<dyn Error>` or `String` to return `anyhow::Result` where practical. This preserves source chains and satisfies the dedicated API without lossy `to_string()` conversion. Avoid debug-formatting unsent router messages or other payload-bearing channel values because they can contain large or sensitive data; map those failures to a small contextual anyhow error.
- Recover source errors at call sites that currently keep only a preformatted string, especially raw upload and process-spawn paths. For timeout, process-status, protocol-string, PAM invariant, and other message-only failures, construct a contextual `anyhow!` error at the detection point so they use the same structured error contract and have an explicit reporting origin.
- Review lower-severity error values separately. Preserve intentional warning/info/debug severity during this migration rather than silently promoting all failed operations to `error`; only current error-severity logging is required to use the new special function.
- Leave pre-logger CLI/config failures, logger self-failures, and low-level exec/process emergency paths on stderr. They cannot safely use the async global logger and should be documented exclusions from the migration guard.

## Configuration

- Add `--log-format line|json` to both `redoor server` and `redoor agent` startup arguments.
- Add role-specific environment variables `REDOOR_SERVER_LOG_FORMAT` and `REDOOR_AGENT_LOG_FORMAT`.
- Add `log_format = "line" | "json"` to `[server]` and `[agent]` TOML sections, parsed into `LogFormat` with the same validation style as `log_level`.
- Resolve format with the established precedence: CLI, role-specific environment, TOML, then `line`. Pass the resolved format into logger initialization alongside path and level rather than reading environment variables inside the logger.
- Propagate the selected agent format through service/relay/managed-agent process construction wherever startup arguments are synthesized. Decide per owner: standalone agents use `[agent]`; server-launched local and SSH agents should receive an explicit format derived from their managed configuration or the documented agent default, not accidentally inherit the server's role environment.
- Update default config generation, strict-key validation, configuration parsing tests, `docs/config.md`, CLI help tests, and systemd/launchd/relay argument construction. Do not add a runtime REST mutation for format in this phase; unlike level, changing encoding while a file is open is a startup concern.
- Keep `redoor server logs`, `redoor agent logs`, and relay log commands as raw `tail` operations. They remain the way to inspect entries older than the in-memory browser window. NDJSON remains valid operator output and no whole-file parsing or buffering is added to these memory-sensitive commands.

## WebSocket protocol

- Change `LogEvent::Snapshot.entries` from `Vec<String>` to `Vec<LogEntry>` and `LogEvent::Entry.entry` from `String` to `LogEntry`. Keep the existing `snapshot`, `entry`, `lagged`, and setup `error` tags; the setup `error` event remains a transport/viewer failure and must not be confused with a structured error-level log entry.
- Send the same structured payload from server logs and dedicated agent log sockets regardless of the selected file/stdout format. The output-format option controls process output and persistence, not the browser protocol.
- Keep `file_logging_enabled` in the snapshot only as an output-status indicator. Update the UI copy so `false` says persistent file output is disabled, not that browser history is unavailable; the 1,000-entry in-memory replay works in either state.
- Update the logger broadcast type, `LogSubscription`, server snapshot path, agent snapshot path, relay validation, generated TypeScript bindings, and protocol serialization tests together. Run `mise exec -- scripts/generate-ts-bindings` after changing exported Rust types.
- Keep the initial snapshot/live ordering boundary deterministic. Validate error chain/backtrace size before the agent sends a frame and again when the server accepts a relayed `LogEvent`; close invalid/oversized streams through the existing safe behavior.
- Treat this as an intentional protocol break between matched Redoor server/agent/UI versions rather than adding dual string/object payloads without a concrete mixed-version requirement. If mixed binary versions are supported operationally, add an explicit protocol capability/version negotiation before implementation rather than guessing from JSON shapes.

## UI behavior

- Update `LogViewer` and its Zod schema to consume structured entries. Keep stable local IDs separate from record content so duplicate entries remain valid.
- Raise the UI rolling-window limit from 500 to 1,000 so it retains the complete replay snapshot and then continues evicting the oldest entry as live records arrive.
- Render timestamp, level, and message as separate elements. Use a fixed-width timestamp/level column on desktop and a wrapping compact layout on mobile; preserve the existing wrap-lines and auto-scroll controls and do not reconstruct the old prefixed string solely for display.
- Apply accessible, theme-consistent severity colors without relying on color alone: subdued slate for trace/debug, normal foreground or blue accent for info, amber for warning, and a red-tinted interactive treatment plus an explicit Error label/icon for errors. Ensure contrast remains adequate in the existing dark visual language.
- Render error records as reusable `Button`/accessible interactive rows rather than plain clickable `<div>` elements. Clicking an error opens the existing `Dialog` component; keyboard activation and focus restoration must work through the reusable controls.
- Add an error-details dialog showing the short message, timestamp/source context, a scrollable preformatted anyhow chain, and a separately labeled scrollable backtrace. Use `CopyableCodeRow` or another existing copy control where appropriate; show a clear unavailable state when no backtrace was captured. Use a wide dialog and constrain long diagnostics so it remains usable on phones.
- Keep setup `LogEvent::Error` as viewer status feedback and reconnect behavior; it does not open the diagnostic dialog because it intentionally contains only a safe transport message.
- Decide and test redaction expectations before exposing error details. The current log stream is authenticated, but full debug chains and backtraces may include paths or operational data; do not include credentials/tokens in contexts, and preserve existing safe generic WebSocket setup errors.

## Tests

- Add Rust unit tests for structured record serialization, RFC 3339 timestamps, line rendering compatibility, NDJSON rendering/escaping, multiline messages, full anyhow debug-chain capture, separate backtrace state, truncation limits, queue-drop notices, and format resolution precedence/validation.
- Add bounded in-memory history tests for empty startup, chronological snapshot order, exact 1,000-entry retention and oldest-entry eviction, deterministic snapshot/live boundaries, multiple independent subscribers, lag/reconnect replay, and full structured error retention. Assert that neither line nor JSON files are read during subscription.
- Extend `tests/agent-logs.test.ts` to assert exact structured snapshot/entry payloads for server and agent streams, error-level details, lag/reconnect behavior, authentication, runtime level filtering, and agent relay preservation of every field. Add startup cases for CLI, env, and TOML format precedence and inspect output incrementally rather than reading unbounded files.
- Replace integration and Playwright fixtures that pre-seed log files with runtime-generated records emitted after logger startup. Assert pre-existing file-only markers are absent from browser snapshots while the raw log commands/files still retain them.
- Add focused tests around each migrated error category: native anyhow chains, wrapped I/O/serde/join errors, message-only failures, and payload-bearing channel failures that must not leak debug payloads. Assert the migration guard finds no runtime `log!(Level::Error, ...)` call sites.
- Extend the server and agent log Playwright suites to verify separate timestamp/level/message rendering, colors/labels for all levels, mobile layout, unchanged auto-scroll/wrapping behavior, keyboard-accessible error rows, dialog open/close/focus restoration, chain content, separate backtrace content, copy behavior if provided, and the unavailable-backtrace state.
- Use ARIA/text selectors rather than classes in Playwright. Add assertion comments explaining the behavior protected, and never use sleeps; poll observable WebSocket/UI/log state.

## Implementation sequence

1. Define `LogFormat`, `LogEntry`, and `LogErrorDetails`; refactor logger storage, the 1,000-entry replay deque, and broadcast delivery around structured records, then add line/NDJSON output codecs with unit tests.
2. Add server/agent CLI, environment, and TOML resolution; propagate the format through all process launch paths and update config documentation/tests.
3. Change `LogEvent` to carry structured records, update server and dedicated-agent streams, regenerate TypeScript bindings, and update backend integration tests.
4. Add `logging::log_error`, migrate existing error-severity call sites by category without losing source errors, and add the guard against ordinary error-level macro calls.
5. Update `LogViewer` severity presentation and implement the reusable error-details dialog with accessible desktop/mobile behavior.
6. Add/extend Playwright coverage, then run `mise exec -- pnpm --dir ui run build` if route-generated types are affected and run `mise exec -- pn test` with at least a 600-second timeout. Record any transient failure that passes on rerun in `flaky-tests.md`.

## Compatibility and non-goals

- The default remains current line output and JSON is opt-in. The selected format affects only stdout/file consumers; it does not change browser snapshots or WebSocket payloads.
- Browser history is intentionally process-local and capped at 1,000 entries. It does not replay any pre-start file content after a server or agent restart, even when the selected output format is JSON. Full structured error details survive browser reconnects only while the producing process remains alive.
- Do not add external telemetry, remote log shipping, arbitrary structured key/value fields, log search/filter APIs, runtime output-format mutation, or an unbounded in-memory history.
- Do not expose raw logger/file-system failures through WebSocket setup errors. Detailed errors belong only to authenticated structured log records intentionally emitted through `log_error`.
