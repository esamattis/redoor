# Linux Trash Support Plan

## Scope and API decisions

- Keep `Command::RawDelete` permanently destructive because smart-move cleanup relies on it.
- Extend `DELETE /api/v1/agents/{agent}/raw/{*path}` with a `trash` boolean query flag. Omitted or `false` preserves permanent deletion; `trash=true` sends a new agent trash command. Keep `RawDeleteResponse { path }` stable for both modes.
- Add `GET /api/v1/agents/{agent}/trash` to list trash locations and their items.
- Add `POST /api/v1/agents/{agent}/trash/restore` with a generated `RestoreTrashItemRequest { location_id, item_id }` and a dedicated generated response containing the restored destination path.
- Use opaque location and item identifiers returned by listing. Resolve them only against the agent's currently discovered trash inventory so request values can never become arbitrary filesystem paths.
- Return groups ordered by their newest item, newest first, and items within each group ordered by deletion time, newest first. Use a deterministic identifier tie-breaker for equal timestamps.
- Return a platform-neutral model such as `TrashListResponse`, `TrashLocation`, and `TrashItem`. A location carries an opaque ID and display path; an item carries its opaque ID, trash name, nullable original path, and `UnixTimestampSeconds` deletion time. Do not expose Linux implementation names as enum variants so a macOS provider can implement the same contract later.
- Add generated TypeScript bindings and `Agent.deleteFile(path, { trash })`, `Agent.listTrash()`, and `Agent.restoreTrashItem(...)` API-client methods. UI components and routes remain out of this phase.

## Agent capability and configuration

- Add a defaulted `supports_trash` registration capability and propagate it through router connection state and `AgentInfoResponse`. Advertise it only when the current target has an implemented provider (Linux initially). Gate the new REST operations before dispatch so older or unsupported agents fail immediately instead of timing out on an unknown command.
- Add `--trash-directory <path>` with `REDOOR_AGENT_TRASH_DIRECTORY` to `AgentArgs`. Treat this as an agent-runtime override rather than server state or a process global.
- Resolve the override once during agent startup and carry an immutable trash configuration through `AgentState` into command workers. Without the override, select locations using the platform provider. With it, use that exact directory as the sole trash root for trashing and listing; create private `files/` and `info/` children there.
- The override is primarily for tests but is a valid operator option. It bypasses mount discovery, not atomicity checks: trash and restore must reject a source/destination on another device instead of falling back to copy/delete.
- Extend `startServerAndAgent` with `agentEnv` forwarding so integration tests can set the override without touching the developer's real trash.

## Rust architecture

- Add a platform-neutral trash service boundary owned by the command layer, with operations for trashing, listing, and restoring. Keep public command/result types transport-neutral and put Linux policy under a dedicated `trash/linux.rs` provider selected with `cfg`.
- Provide an unsupported provider/error for other targets now. A future `trash/macos.rs` should implement the same internal service contract without changing REST or command models.
- Add `Command` and `CommandResult` variants for trash, list, and restore, with concise command summaries. Dispatch the short asynchronous filesystem work through command tasks so long directory scans do not block WebSocket control handling.
- Add a dedicated `src/server/trash.rs` endpoint module and register its routes in `src/server/routes.rs`; only the existing delete handler's query dispatch remains in `src/server/files.rs`.
- Keep filesystem paths as `Path`/`OsStr` internally. At the REST boundary, omit entries whose trash filename cannot be represented safely by the current UTF-8 API, and make `original_path` nullable when metadata cannot yield a representable valid path.

## Reusable atomic move primitive

- Extract the Linux `renameat2` and macOS `renamex_np` code from `src/agent/transfers/move.rs` into a shared Rust module usable by both smart move and trash.
- Expose explicit no-replace and exchange outcomes rather than embedding copy-fallback policy in the syscall helper. Preserve smart move's current behavior by interpreting unsupported/cross-device outcomes as its existing copy fallback.
- Require trash and restore to use only the no-replace atomic rename. Treat `EXDEV` or an unsupported syscall/filesystem as an operation error; never copy, recursively load, or delete as a fallback.
- Retain unit coverage for Linux/macOS exclusive rename, exchange, destination races, unsupported outcomes, and different entry types in the extracted module.

## Linux freedesktop provider

- For paths on the home filesystem, use `$XDG_DATA_HOME/Trash` or `$HOME/.local/share/Trash` when `XDG_DATA_HOME` is absent.
- For another mounted filesystem, find the source's actual top directory from mount information and device IDs. Prefer `<mount>/.Trash/<uid>` only when `.Trash` is a real, sticky directory that satisfies the specification; otherwise use `<mount>/.Trash-<uid>`. Never follow a symlink while selecting or creating trash directories.
- Create per-user roots and their `files/` and `info/` children with private permissions. Validate ownership, directory type, permissions, and device identity each time before a destructive rename because mount and path state can race.
- Generate a collision-safe payload name from the source basename. Reserve `info/<name>.trashinfo` with exclusive creation, write `[Trash Info]`, the percent-encoded original path, and a freedesktop `DeletionDate`, then atomically no-replace rename the source to `files/<name>`. Remove the metadata reservation if publication fails and retry with a new name on collisions.
- Store an absolute `Path` for the home trash and a path relative to the mount top directory for mount-specific trash, as required by the specification. Decode only valid percent escapes and reconstruct mount-relative paths without allowing traversal outside that mount.
- Use `symlink_metadata` so trashing a symlink moves the link itself. Reject filesystem roots, trash roots and their descendants, missing entries, invalid source names, and paths whose same-device trash cannot be made secure.
- Listing discovers the home trash plus valid per-mount trash roots, or only the forced root when configured. Read direct entries only, pair payloads with `.trashinfo`, parse deletion dates, and avoid recursive size scans.
- Ignore and log orphan metadata. Include payloads with a parseable deletion date even if their original path is missing, malformed, unsafe, or non-UTF-8 by returning `original_path: null`; omit records without a trustworthy deletion timestamp so every returned item satisfies the API contract.
- Restore only an item selected from a freshly validated location. Require valid original-path metadata and an existing real parent directory, verify the payload and destination parent are on the same device, and atomically rename with no replacement. An occupied destination returns a conflict and leaves payload plus metadata intact. Remove `.trashinfo` only after successful restoration; if cleanup then fails, report/log the orphan without moving the restored item back.

## REST and protocol errors

- Reuse `CommandErrorKind` mappings for not found, permission denied, invalid input, already exists/conflict, and internal I/O failures. Add an explicit unsupported kind only if capability gating cannot express the target-platform case cleanly.
- Validate `trash` query syntax at the REST boundary and validate restore identifiers in both the server model and agent provider.
- Keep operation timeouts consistent with other control commands, while ensuring directory iteration and file I/O use Tokio APIs and mount/syscall-only blocking work uses `spawn_blocking`.

## Tests

- Add Rust unit tests for trash-location selection, sticky-bit/ownership validation, home versus mount-relative `.trashinfo` encoding, percent encoding/decoding, collision naming, malformed metadata, ordering/grouping, identifier validation, and restore path containment.
- Add `tests/trash.test.ts` using a source tree and forced trash root under the same temporary filesystem. Cover files, populated directories, symlinks, duplicate basenames, concurrent requests, metadata contents, nullable original paths, group/item ordering, missing sources, restore success, restore conflict preservation, orphan/malformed entries, and permanent delete behavior when `trash` is omitted or false.
- Add a Linux cross-filesystem integration case using a second writable device such as `/dev/shm` when available. Verify natural mount-trash selection and verify a forced trash root on another device fails without copying; skip only when the environment cannot provide distinct devices.
- Verify inode/device continuity before and after trash/restore to prove the operations used rename semantics. Also issue an unrelated lightweight API command while a large trash directory is being listed to ensure control commands remain responsive; poll observable state or logs rather than sleeping.
- Keep existing raw-delete integration tests as the permanent-delete regression suite and add assertions for explicit `trash=false` if useful.
- No new Playwright workflow is required before the UI exposes trash. Existing delete Playwright tests continue exercising permanent deletion because the query flag defaults to false. In the later UI phase, configure the Playwright agents with `REDOOR_AGENT_TRASH_DIRECTORY`, then add a real-server `ui/e2e/trash.spec.ts` covering move-to-trash, grouped listing, restore, conflict feedback, and destructive confirmation; do not duplicate backend edge-case matrices there.

## Generated artifacts and verification

1. Run `mise exec -- scripts/generate-ts-bindings` after adding or changing `#[ts(export)]` request/response types.
2. Run `mise exec -- pnpm --dir ui run build` after route or API-client changes so generated route/type checks remain current.
3. Run focused Rust and `tests/trash.test.ts` tests during implementation.
4. Run the full `mise exec -- pn test` suite with at least a 600-second timeout, which includes integration and Playwright coverage. Record any transient test that passes on rerun in `flaky-tests.md`.
