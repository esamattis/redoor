# Inode-Preserving File Editing Plan

## Goal and semantic contract

Add an explicit file-edit operation for the browser editor without changing raw upload's replacement-publication contract; separately fix raw upload's metadata lookup so that contract is consistently no-follow.

- **Edit** means rewrite an already-existing regular-file inode. Every successful edit must preserve its device/inode identity, all hard-link relationships, owner, group, and exact ordinary user/group/other `rwx` bits. ACLs and other inode-attached metadata remain attached unless the operating system normally alters them on write. Size, modification time, and change time change. The operating system may intentionally clear setuid/setgid bits, file capabilities, or security attributes when content is written; handling those security-sensitive values is separated from the mandatory ordinary-permission guarantee below.
- **Edit through a symlink** means follow the requested pathname to its existing regular-file target, rewrite that target inode, and never rename, unlink, or replace any symlink in the chain.
- **Upload** continues to mean stage a new regular file and publish it at the requested directory entry. A destination symlink is replaced rather than followed. Replacing one pathname of a hard-linked file breaks only that pathname away from the old inode.
- Do not make `PUT /raw` inspect callers or content types to guess whether an operation is an edit. The editor must call a dedicated endpoint and command.
- Both operations remain streamed through bounded queues and files. The implementation must not collect the request body or staged file into memory.

## Current implementation findings

### UI and REST flow

- `FileEditView()` in `ui/src/components/browser/file-views.tsx` owns the editor save mutation. Its `saveMutation` currently calls `props.agent.upload(...)` at lines 341-348, so UI save and generic upload have identical semantics.
- `Agent.upload()` in `ui/src/api-client.ts` lines 640-656 sends `PUT` to `Agent.getRawUrl(path)`. The same method is correctly used for actual uploads by `UploadQueueManager()` in `ui/src/upload-queue.ts`, `CreateFileAction()` in `ui/src/components/browser/directory-actions.tsx`, and `MissingPathCreationForm()` in `ui/src/components/browser/missing-path.tsx`.
- `raw_agent_put_handler()` in `src/server/raw/upload.rs` lines 334-424 requires `Content-Length`, creates `Command::RawUpload { on_existing: Override }`, streams Axum body chunks through `AgentUpload`, and waits for the agent completion result.
- `AgentUpload::start()`, `send()`, and `finish()` in `src/server/raw/upload.rs` already provide the required bounded REST-to-router plumbing, readiness barrier, exact byte-count validation, and drop-driven cancellation. This transport can be reused by a dedicated edit handler without reusing raw-upload semantics.
- `build_app()` in `src/server/routes.rs` lines 193-204 registers raw GET/PUT/DELETE routes. The entire browser-facing router is protected by `require_authentication` at lines 227-228.

### Router and agent flow

- `Command::RawUpload` and `CommandResult::RawUpload` are declared in `src/commands.rs` at lines 176-182 and 790-804. `Command::summary()` and `CommandResult::summary()` distinguish wire operations in logs.
- `StartUploadRequest`, `UploadStartOutcome`, and `SendStreamChunkRequest` in `src/actors/router/messages.rs` lines 274-319 are transport-level abstractions and can carry a different inbound-write command.
- `transfers::upload::start()`, `route_chunk()`, and `finish_transfer()` in `src/actors/router/transfers/upload.rs` keep network sends outside the router actor, track progress, and deliver cancellation. `finish_transfer()` currently recognizes only `CommandResult::RawUpload` as a successful direct upload at lines 398-409.
- `DirectUpload` in `src/actors/router/state.rs` lines 136-157 does not retain the semantic operation or expected completion type. Add that distinction instead of accepting either success result indiscriminately.
- `AgentActor::handle_incoming_message()` and `start_upload_session()` in `src/agent/protocol.rs` classify `RawUpload`/`TarUpload` as transfer commands, create a bounded worker before sending `TransferReady`, and route priority cancellation through `ActiveUploads`.
- `RawUploadWorker` in `src/agent/raw/upload.rs` writes chunks to a sibling temp file. `finalize()` restores the prior mode on the temp file and calls `place_temp_at_destination()`.
- `start_raw_upload_session()` currently captures `existing_permissions` with `tokio::fs::metadata(&path)` at `src/agent/raw/upload.rs` lines 372-390. Unlike the later destination checks, this follows a valid destination symlink and reads its target's mode. That violates the required no-follow upload contract even though final publication replaces the link.
- `place_temp_at_destination()` in `src/agent/transfers/destination.rs` publishes replacement content. `destination_entry_exists()` deliberately uses `symlink_metadata()`, and `remove_existing_path()` deliberately unlinks a symlink instead of following it. These are the desired upload semantics and should remain unchanged.
- `TransferDirection` in `src/commands.rs` lines 1370-1379 and `TransferList` in `ui/src/components/transfer-list.tsx` currently expose Upload, Download, Copy, and Move. Since Copy and Move are semantic rather than byte-direction labels, Edit should also be a distinct progress direction.

### Existing path and symlink behavior

- Filesystem APIs accept absolute paths outside the configured agent home. `AgentArgs.home` explicitly says it does not limit filesystem access in `src/agent/state.rs` lines 61-63, and `tests/absolute-paths.test.ts` locks in that contract.
- `absolute_path_from_url()` in `src/server/agent_helpers.rs` only restores the URL's leading slash; it does not canonicalize or confine the path.
- `CommandHandler::ls()` and `commands::metadata::execute()` use following metadata calls, so a symlink to a regular UTF-8 file can already be presented as editable. `commands::metadata::execute()` also bounds UI-editable content to 2 MiB, while `fileContentQueryOptions()` in `ui/src/queries.ts` downloads the editor text.
- No per-path authorization policy exists. Authentication authorizes use of the connected agent account's full filesystem authority. If the agent runs as root, an authenticated Redoor user can already explicitly read, upload, delete, or otherwise address root-accessible absolute paths.

## Recommended architecture

### 1. Add a dedicated REST edit resource

- Add `src/server/file_edit.rs` and declare it from `src/server/mod.rs`.
- Register exact and wildcard forms in `build_app()`:
  - `PUT /api/v1/agents/{agent}/edit`
  - `PUT /api/v1/agents/{agent}/edit/{*path}`
- Implement `file_edit_handler()` with the same required `Content-Length`, body streaming, readiness, byte-count, error mapping, and cancellation behavior as `raw_agent_put_handler()`.
- Reuse `AgentUpload` as the transport object, passing `Command::EditFile { path }`. Do not call `raw_agent_put_handler()` and do not add an edit query flag to `/raw`.
- Extract only the small duplicated HTTP-body forwarding/`Content-Length` parsing pieces from `src/server/raw/upload.rs` if both handlers would otherwise duplicate them substantially. Keep `raw_upload_completion_response()` and the new `file_edit_completion_response()` separate so each endpoint accepts only its own `CommandResult`.
- Add an exported `FileEditResponse { path, bytes_written }` in `src/commands.rs` with `Serialize`, `Deserialize`, `TS`, and `#[ts(export)]`. The raw request body needs no JSON request type.
- Map `CommandResult::EditFile` to `200` plus `FileEditResponse`; map `CommandResult::Error` through `command_error_status()` as existing file endpoints do.

### 2. Make edit a distinct wire command and progress operation

- Add `Command::EditFile { path: String }` and `CommandResult::EditFile` in `src/commands.rs`.
- Update both `summary()` methods without logging body bytes.
- Add `TransferDirection::Edit` so transfer listings and cancellation diagnostics do not describe an inode rewrite as a generic upload.
- Add an internal direct-write kind to `DirectUpload` in `src/actors/router/state.rs`, for example `DirectUploadKind::{RawUpload, TarUpload, EditFile}`. Derive it from the command in `transfers::upload::start()` and populate it at the existing copy-side `DirectUpload` construction sites.
- Retain the same kind in the REST-side `AgentUpload` so `finish()` invokes the non-cancelable commit transition only for EditFile; raw upload must continue directly to its terminal publication frame.
- Give that kind methods for expected completion and public progress direction. `finish_transfer()` must reject a mismatched success result rather than treating `EditFile` as a successful raw upload or vice versa.
- Change `progress::record_upload_start()` in `src/actors/router/progress.rs` to accept the selected direction. Update `mark_transfer_completed()` so both Upload and Edit trigger `RoutesChanged`; currently only Upload does so at lines 300-307.
- Extend `ui/src/components/transfer-list.tsx` with an explicit Edit label/icon/color branch rather than allowing it to fall through to Copy.
- Keep `StreamPayloadKind::RawFile` in `src/streaming.rs`. The binary payload is still raw bytes; the control command, completion result, and progress type carry the semantic distinction.

### 3. Add an inode-preserving agent edit worker

- Add `src/agent/raw/edit.rs` and expose it from `src/agent/raw.rs`. Keep the implementation behaviorally separate from `RawUploadWorker`; share only small chunk/cancellation helpers if that genuinely reduces duplication.
- Extend the upload classification in `AgentActor::handle_incoming_message()` and `AgentActor::start_upload_session()` in `src/agent/protocol.rs` so `Command::EditFile` requires the transfer socket, bypasses the ordinary 32-command admission limit like other inbound streams, registers in `ActiveUploads`, and sends `TransferReady` only after setup succeeds.
- At setup, require an absolute pathname again at the agent trust boundary. Open the requested path for writing **without** `create` and **without** `truncate`. Opening the path through normal Unix pathname resolution intentionally follows final and intermediate symlinks, including relative links relative to their containing directory.
- Use `O_CLOEXEC | O_NONBLOCK` through `OpenOptionsExt::custom_flags` while opening. `O_NONBLOCK` is ignored for regular files but prevents a raced FIFO/device-like entry from hanging setup. Immediately inspect the opened descriptor with `File::metadata()` and reject anything that is not a regular file before accepting body bytes.
- Retain that open `tokio::fs::File` for the whole edit. This pins the selected inode even if a symlink or pathname is renamed/replaced during transfer and avoids resolving the symlink a second time at commit.
- Record the opened descriptor's Unix device/inode identity, uid, gid, and `mode() & 0o777` ordinary permission bits. Inode, hard-link, owner, group, and ordinary `rwx` preservation are mandatory success conditions, not configuration choices.
- Immediately before commit, compare the pinned descriptor identity with following `tokio::fs::metadata(requested_path)`. Return a typed conflict if the pathname no longer resolves to the pinned inode. This catches common symlink/path replacement races; the write still uses only the pinned descriptor, so a later path swap cannot redirect bytes into another inode.
- Classify a dangling link/absent target as NotFound, a link loop (`ELOOP`) as InvalidInput with an actionable message, a directory as IsDirectory, permission failures as PermissionDenied, and a path-identity change as Conflict. Add `CommandErrorKind::Conflict` and map it to HTTP 409 in `src/server/responses.rs` rather than overloading AlreadyExists.

### 4. Stage all input before touching the inode

- Create a mode-0600 staging file with `tokio::fs::OpenOptions::create_new(true)` under `std::env::temp_dir()`, retrying a bounded number of random UUID names on collision.
- Unlink the staging pathname immediately after opening it. Linux, macOS, and Android Termux retain the open inode until the worker closes or crashes, so cancellation/crash automatically reclaims it and no sensitive named partial file remains. If immediate unlink fails, fail setup and explicitly remove the owned path.
- Stream each `RawFile` chunk into this staging descriptor with `write_all()`, retaining the current bounded `mpsc` channel and transfer-socket backpressure. Reject payload-kind mismatches and server error frames as the current raw worker does.
- Before commit, require the terminal frame, exact HTTP byte count (already checked by `AgentUpload`), a successful staging flush, and a seek back to offset zero. No `Vec` should scale with file size; use `tokio::io::copy()` or an explicit `streaming::CHUNK_SIZE` loop.
- Cancellation, HTTP disconnect, transfer-socket loss, or a staging write/flush failure before commit closes the pinned target and staging descriptor without calling `set_len()`. The original inode and bytes remain untouched.

### 5. Define the non-atomic commit boundary explicitly

- In `AgentUpload::finish()`, after the HTTP body reaches its exact declared length but before forwarding the terminal frame, send a focused router request such as `BeginDirectUploadCommit`. The router must validate that the request is an active EditFile, set its progress entry's `cancelable` field to false, notify transfer subscribers, and acknowledge the transition before `AgentUpload` sends the terminal frame. This makes the operation non-cancelable slightly before agent staging/final validation completes, but guarantees the agent cannot observe the frame that permits truncation before the router publishes the boundary.
- On the agent, treat receipt of the valid terminal frame as the local point after which cancellation is ignored until commit returns. This mirrors the existing short finalization race but is important for a non-atomic rewrite: stopping halfway is more destructive than finishing the already-authorized bytes.
- At commit, seek the pinned target descriptor to zero, call `set_len(0)`, stream-copy the staged bytes into it, verify the copied byte count, and flush.
- After the content copy succeeds, read the pinned descriptor's current mode. If `current_mode & 0o777` still equals the snapshot, do not call chmod; this is the normal path and avoids needlessly rewriting POSIX ACL masks. If ordinary bits differ, restore them through that same descriptor while preserving the descriptor's **current** special-bit state: effectively combine `current_mode & 0o7000` with `original_mode & 0o777`, then apply it with descriptor-based `File::set_permissions()`/`fchmod`. This guarantees ordinary permissions on success without re-enabling setuid/setgid bits the kernel deliberately cleared.
- If ordinary-mode restoration fails, return an edit error and do not report success. Be explicit that content has already been rewritten and cannot be rolled back; the failure can therefore leave new content with altered ordinary permissions. A concurrent `chmod` racing the edit may have its ordinary `rwx` change overwritten and descriptor chmod can update the ACL mask on ACL-capable files, while concurrent special-bit changes are preserved only to the extent allowed by the final descriptor metadata/read-modify-write race.
- Finish with the approved sync operation only after ordinary-mode restoration. If durability includes permission metadata, prefer `sync_all()` over `sync_data()`; this is called out for confirmation below.
- Do not rename the stage over the target, call `chown`, or resolve/canonicalize a replacement path. Those actions would either replace the inode, risk changing mandatory ownership, or introduce a second symlink-follow race.
- Success leaves uid/gid and device/inode untouched because all mutation occurs through the pinned inode descriptor and no ownership call is made. Hard links all observe the new content because they still reference that inode. Every symlink entry remains untouched.

## Symlink edge-case decisions

- **Relative link:** Let `open(2)` resolve it relative to the directory containing each link. Do not join a relative `read_link()` result against the process working directory.
- **Absolute link:** Follow it under the existing unrestricted absolute-path authorization model.
- **Chain:** Let the kernel follow the chain and enforce its platform link-depth limit. Retain only the final opened regular-file descriptor; no manual chain walker is needed.
- **Dangling link:** Return 404 before `TransferReady`; do not create the target and do not replace the link.
- **Loop/excessive chain:** Return 400 with a loop-specific message; do not consume body bytes or alter links.
- **Link changed during staging:** Continue to hold the original descriptor, but fail with 409 before truncation when the requested path no longer resolves to that descriptor. Both old and new targets remain untouched.
- **Link changed after the final identity check:** The operation can only write the pinned descriptor, never the newly selected target. It may complete on an inode no longer reachable by the requested name. Namespace locking is not portable, so this residual race must be documented rather than hidden.
- **Symlink target is another hard-link name:** Editing rewrites that shared target inode, so every hard-link name changes as required.
- **Symlink to directory/special file:** Reject; editing is only for existing regular files.

## Upload behavior to retain and lock down

- Leave `Command::RawUpload`, `RawUploadWorker::finalize()`, and `place_temp_at_destination()` on replacement publication. Do not share the edit finalizer with raw upload.
- Change permission capture in `start_raw_upload_session()` from following `tokio::fs::metadata()` to `tokio::fs::symlink_metadata()`/lstat semantics. Set `existing_permissions` only when that metadata says the destination directory entry itself is a regular file. A symlink, directory, or other entry gets `None`; no later code may query a symlink target to obtain replacement metadata.
- Keep `destination_entry_exists()`, preflight, permission capture, and final placement consistently no-follow for the destination entry. Upload over a valid or dangling symlink must not inspect, open, chmod, truncate, or otherwise mutate its target. It must move the symlink entry aside and publish the staged regular file at that selected pathname.
- Preserve the existing regular-destination mode-copy behavior only for a destination whose lstat type is regular. This includes a hard-linked regular-file name because a hard link is not a pointer to traverse: the directory entry directly names the shared inode, so lstat metadata for that entry may supply the replacement mode.
- Keep hard-link replacement behavior precise: publication assigns only the selected pathname to the staged inode. Peer hard-link names remain attached to the prior inode with their prior content, owner/group, and mode; permission capture for the replacement must not chmod or otherwise mutate that prior inode.
- Do not imply that uploads preserve owner/group or inode identity. The replacement regular file has the staged inode and uploader ownership, with copied mode only in the regular-destination case.
- While touching staging code, harden raw upload temp creation without changing replacement semantics: replace `File::create(temp_path)` with bounded `OpenOptions::create_new(true)` retries so a colliding sibling symlink cannot be followed by a root agent. Use the same new-file creation mode/umask behavior as the current `File::create` path rather than silently changing generic upload modes. Continue final publication through `place_temp_at_destination()`.

## UI/API client changes

- Import generated `FileEditResponse` in `ui/src/api-client.ts`.
- Add `Agent.editFile(path, file)` that validates the absolute path through `appendFilesystemPath`, sends `PUT` to `/api/v1/agents/{id}/edit/{path}`, uses existing authentication/error handling, and returns `FileEditResponse`.
- Keep `Agent.upload()` and every upload/create-file call site unchanged.
- Change only `FileEditView.saveMutation` in `ui/src/components/browser/file-views.tsx` to call `props.agent.editFile(...)`. Retain its current TanStack Query cache update, dirty-draft race handling, status, keyboard shortcut, and focus behavior.
- Do not add an API call in `useEffect`, do not alter route loading, and do not modify the browser route unless an optional edit-precondition token is approved below.
- Do not fall back to `Agent.upload()` when edit is unsupported or fails. A fallback would silently destroy the requested inode/link semantics.

## Failure, cancellation, and crash behavior

- **Before terminal input:** target descriptor is open but unmodified; cancel/failure closes both descriptors and preserves original bytes and metadata.
- **After HTTP body reception but before truncate:** the router has made Edit non-cancelable before sending the terminal frame; the agent may still be draining ordered frames, flushing staging, or checking identity. Any failure still leaves the target unmodified, but a new cancellation request is rejected because permitting it to race the terminal frame would risk a half-written inode.
- **After truncate starts:** there is no portable atomic publication that also preserves the inode. Concurrent readers through any hard link can observe empty/partial/new data. Write, flush, disk-full, I/O, power, kernel, or process failure can leave the inode empty or partially rewritten.
- **Cancellation at commit:** reject new cancellation after the server marks the edit non-cancelable and let an already-started agent commit finish. A cancel racing exactly with that boundary can report completion rather than cancellation; tests should lock in that successful publication wins.
- **Agent crash while staging:** the unlinked stage and pinned descriptor are reclaimed by the kernel; target bytes are unchanged.
- **Agent crash while committing:** target inode remains the same but can contain partial content. The reconnecting agent cannot infer or atomically repair it. Surface the transfer as errored/disconnected and do not claim rollback.
- **Server crash/disconnect:** before the agent receives a terminal frame, worker teardown/cancellation leaves the target unchanged. After the terminal frame, the agent should complete the local commit and report if the control connection survives; otherwise router state is lost even though filesystem commit may have occurred.
- A final `sync_all()` makes returned content and restored ordinary-mode metadata stronger than the current upload `flush()` behavior, but it cannot make the rewrite atomic. Directory sync is irrelevant because edit changes no directory entry.

## Authorization and confinement assessment

- The new route inherits the existing authenticated API middleware. One-time raw-download tokens must not authorize edits.
- The repository currently treats the agent's configured home as a starting location, not a sandbox. The edit endpoint should initially preserve that contract: any authenticated user may edit any existing regular file writable by the agent account.
- Running an agent as root therefore grants authenticated Redoor users root-level edit authority. This is pre-existing for upload/delete and must be explicit in documentation/UI deployment guidance.
- Holding the target descriptor from setup through commit removes the dangerous second pathname lookup and prevents a symlink swap during a slow transfer from redirecting the commit. `create_new` plus immediate unlink protects the root-owned staging file from local link planting.
- The final path-identity check reduces stale-name races but cannot lock a Unix namespace. Advisory file locks are insufficient because other processes need not honor them.
- Do not add Linux-only `openat2(RESOLVE_BENEATH)` in this feature: it is unavailable on macOS, conflicts with the existing unrestricted absolute-path contract, and would change whether absolute/escaping symlinks are editable. If confinement is desired, design one explicit cross-endpoint agent-root policy for read, edit, upload, copy, move, delete, terminal cwd, and Git operations rather than securing only this endpoint.

## Test plan

### Rust unit tests

Add focused tests beside the new worker in `src/agent/raw/edit.rs`, using `crate::test_support::TempDir` and assertion comments required by the repository.

1. Rewrite a regular file and assert device/inode, exact ordinary `rwx` mode, uid, gid, and hard-link count are unchanged while contents/size change.
2. Rewrite one hard-link name and assert the peer name has the same inode and new bytes.
3. Edit through an absolute symlink and assert `symlink_metadata().is_symlink()`, unchanged `read_link()` text, unchanged target inode, and new target bytes.
4. Repeat with a relative symlink and a multi-link chain.
5. Verify dangling links and loops return the intended typed errors without altering the link entries.
6. Start/pin an edit, replace the symlink/path before commit, and assert the identity recheck returns Conflict while both possible targets retain their original bytes.
7. Verify directories, FIFO/special entries, and non-absolute command paths are rejected without hanging or mutation.
8. Feed a canceled/error/missing-final stream and assert the target inode and bytes are unchanged.
9. Exercise zero-length edits and shorter/longer replacements.
10. Simulate or induce the kernel clearing special bits and verify ordinary `rwx` restoration does not re-enable cleared setuid/setgid bits.
11. Inject a descriptor permission-restoration failure and assert the edit returns an error after content commit rather than falsely claiming both content and mode preservation; owner/group and inode must still remain unchanged.
12. Use an injected failing async reader/writer seam around the commit copy only if needed to deterministically prove post-truncate failures are surfaced; assert inode preservation and explicitly allow partial bytes rather than claiming rollback.

Update protocol/router unit tests:

1. Extend `non_upload_command_admission_is_bounded()` in `src/agent/protocol.rs` to prove EditFile uses bounded transfer-worker admission rather than ordinary command slots.
2. Extend `slow_upload_send_does_not_block_unrelated_router_work()` or add a parallel focused test in `src/actors/router/mod.rs` for an EditFile stream.
3. Test direct-write kind/result mismatch rejection and Edit progress direction/completion/route refresh in `src/actors/router/transfers/upload.rs` and `src/actors/router/progress.rs`.
4. Test the cancelable-to-non-cancelable transition and the completion-wins boundary.
5. Add raw-upload temp reservation tests if `create_new` hardening is included.
6. Add a focused raw-upload permission-capture test proving lstat returns no preserved mode for valid/dangling symlinks and does return mode for a regular destination entry, including a hard-link name.

### REST integration tests

Add `tests/file-edit.test.ts`, following `tests/raw-upload.test.ts`, `startServerAndAgent()`, `waitForValue()`, and `onTestFinished()` cleanup patterns. Do not sleep; poll transfer/API/filesystem state or wait for a specific log message.

Use existing tracked temporary-directory helpers for TypeScript fixtures. Any new Rust cleanup that recursively removes a directory must call `safe_rm_all`; staging cleanup itself should close/unlink only its owned regular file.

1. Edit a regular file and compare BigInt `stat` device/inode before/after, contents, size, mode, uid, and gid.
2. Set a non-default ordinary mode such as 0751 and verify the exact `mode & 0o777` survives as a mandatory successful-edit guarantee.
3. Where `process.getuid() === 0`, chown the fixture to a different numeric uid/gid, edit through the root-run agent, and assert ownership survives. On non-root runs, retain inode/uid/gid assertions but conditionally skip only the different-owner case with an explicit reason.
4. Edit one of two hard links and verify both names retain the original inode and expose the new content.
5. Cover relative symlink, absolute symlink, symlink chain, dangling symlink, and loop behavior; assert every link's `lstat`/`readlink` state.
6. Stream a two-part request, hold after the first chunk, verify an unrelated `getDetails()` command completes promptly, then finish and verify progress direction Edit.
7. Abort that held request before its final chunk and assert the transfer settles errored/canceled, original inode/content/mode remain unchanged, and no named staging file is left.
8. Send a short/broken body relative to Content-Length and assert pre-commit preservation.
9. Exercise permission denied and directory targets with stable HTTP status/error JSON.
10. If a deterministic test hook/log boundary is acceptable, kill the agent after an `Edit commit started` log and assert only the honest guarantees: inode/link identity survives and the transfer does not report success; content may be partial. Do not make the test expect rollback.

Extend `tests/raw-upload.test.ts` with explicit regression coverage:

1. Upload onto a valid symlink whose target has distinctive content and mode. Assert the target content and mode are unchanged, the link pathname becomes a regular file, and the replacement uses ordinary new-file mode behavior rather than inheriting the target mode. Compare against a missing-destination upload under the same umask instead of hard-coding a platform mode.
2. Repeat with a dangling symlink and assert the missing target remains missing, proving upload neither creates nor inspects it before replacing the link entry.
3. Cover a valid symlink whose target is inaccessible where feasible. The upload must depend only on lstat and parent-directory publication permissions, not target metadata/read permission; conditionally account for root test processes that bypass target permission checks.
4. Upload onto one name of a hard-linked file; assert that pathname gets a different inode/new bytes while the peer keeps the old inode, old bytes, owner/group, and mode. This proves lstat mode capture did not traverse or mutate the shared inode and publication changed only the selected directory entry.
5. Retain the existing permission-preservation test for a destination entry that is itself a regular file, and assert the replacement mode matches that entry's prior mode.
6. Keep the current cancellation test proving incomplete uploads never publish a destination.

### Playwright coverage

Extend `ui/e2e/file-edit.spec.ts` rather than creating another editor suite.

1. Add a primary regression that opens a relative symlink to an editable text file, edits and saves through `FileEditView`, observes the existing Saved status, then polls `readlink` and target contents to prove the target changed and link survived.
2. Record network requests in that test and assert Save uses `PUT /api/v1/agents/{agent}/edit/...` and does not issue `PUT /raw/...`.
3. Keep existing Save button and `ControlOrMeta+s` workflows as ordinary-file UI coverage; update stale comments that currently call save an upload/PUT replacement.
4. Use roles/ARIA/text selectors only, as the current suite does.

## Generated artifacts and verification

1. After adding `FileEditResponse` and `TransferDirection::Edit`, run `mise exec -- scripts/generate-ts-bindings` and include the generated files under `bindings/`.
2. Run focused Rust tests, `tests/file-edit.test.ts`, `tests/raw-upload.test.ts`, and `ui/e2e/file-edit.spec.ts` during implementation.
3. No TanStack route shape change is recommended. If implementation does modify `ui/src/routes/agents.$agentId.browser.$.tsx`, run `mise exec -- pnpm --dir ui run build` immediately to regenerate/check route types.
4. Run final `mise exec -- pn test` with a timeout of at least 600 seconds. Inspect `log/` for failures and record any transient test that passes on rerun in `flaky-tests.md`.
5. Verify Linux, macOS, and Android Termux compilation. The open/unlink/descriptor design is Unix-specific but all currently supported targets are Unix; keep cfg use and errno mapping portable across those three targets.

## Implementation sequence

1. Add command/result/error/progress models and the router's explicit direct-write kind.
2. Implement and unit-test the agent EditFile setup, secure unlinked staging, symlink/identity handling, mandatory ordinary-mode restoration, and inode rewrite.
3. Add the dedicated REST module/routes and reuse the existing bounded `AgentUpload` transport.
4. Switch raw-upload permission capture to lstat-only regular-entry handling and harden temp reservation without changing replacement semantics.
5. Add generated bindings and `Agent.editFile()`, then switch only `FileEditView.saveMutation`.
6. Add edit integration tests and raw-upload replacement regressions.
7. Add the symlink-save Playwright regression and update inaccurate upload wording in existing editor assertions.
8. Run the required generation, focused verification, platform checks, and full `pn test` suite.

## Explicit non-goals

- Do not change generic upload into an in-place write.
- Do not create missing edit targets or repair dangling links.
- Do not replace the target inode to provide atomic publication.
- Do not add whole-file memory buffering, base64 content in control messages, or a large JSON edit body.
- Do not promise rollback after truncate/write begins.
- Do not treat owner/group, inode identity, hard-link relationships, or ordinary `rwx` preservation as optional successful-edit behavior.
- Do not introduce edit history, backups, merge/conflict UI, or collaborative locking in this change.
- Do not add edit-only path confinement that disagrees with every other absolute-path endpoint.

## Open questions requiring confirmation

1. **Filesystem authority:** Confirm that EditFile should retain the documented unrestricted absolute-path model, including following a symlink outside the configured agent home. If not, path confinement must become a broader cross-endpoint design before implementation.
2. **Stale editor precondition:** Is pinning the inode at edit-request start sufficient, or should the read/metadata API also return an opaque file-version token that Save must submit? A token could reject changes between editor load and Save, but making it race-free requires binding metadata and raw download to the same opened descriptor and is materially larger than this plan's minimum.
3. **Older connected agents:** Should a server/UI provide an explicit `supports_file_edit` registration capability and disable Save with a clear upgrade message for older agents? The recommendation is yes for rolling upgrades, with no upload fallback; omit it only if server and agents are guaranteed to upgrade together.
4. **Security-sensitive mode restoration:** The recommendation is to guarantee and restore only the original ordinary `rwx` bits, while preserving the post-write state of setuid/setgid and not restoring file capabilities/security attributes cleared by the kernel. Confirm whether exact pre-edit special bits or capabilities must instead be restored. Doing so can re-enable privileged execution on newly supplied content when the agent runs as root; a restoration failure would also occur after irreversible content mutation.
5. **Commit durability:** Confirm `sync_all()` after ordinary-mode restoration and before success. It adds latency compared with the current raw upload's `flush()` but gives a clearer durability guarantee for both content and required permission metadata.
6. **Crash integration test:** Confirm whether adding a deterministic commit-start test hook/log and killing the test agent is worth the suite cost. The behavior must be documented regardless; unit and cancellation tests can cover all pre-commit guarantees without a process-kill test.
