# Tools

- Node.js, mise, pnpm
- Rust, Tokio, Axum
- Always execute shell commands with `mise exec -- …` so the correct toolchain (Node, pnpm, etc.) is on PATH
- Spawn commands from Node/TypeScript scripts with zx (`$`). Do not use `node:child_process`.

# Architecture

- Supported platforms are Linux, macOS, and Android Termux
- REST API and Websocket server
- redoor agents connects to the server via Websockets
- The server exposes REST API which can be used to execute commands in the agents using the websocket connection
- Support for memory restrained environments: All file uploads and downloads must be streamed without reading to whole file into the memory, this includes the tar streaming and any other streaming that could use lot of memory with big files
- Control commands should stay response even during long streaming downloads or uploads.

# Guidelines

- Always use async apis from tokio instead of sync apis instead
- Recursive directory deletion must always use `safe_rm_all`, never `remove_dir_all`
- Always comments to functions, structs, enums and methods
    - The comments should try to answer the "why" question
- When creating a function always consider first if it should be a method on a struct instead
- Do not add one-line passthrough wrappers that only call another function or re-export a type. Call the real module directly.
- When adding a retust api always create a dedicated struct for it's reponse with `#[ts(export)]` derive macro which genertes the related typescript interface.
- Put behaviorally distinct REST endpoints in dedicated modules instead of adding them to an unrelated resource module. Group handlers only when they operate on the same domain and share a clear responsibility.
- After every architectural change (new or changed crates, actors, flows, wire protocol, lifecycles, trust boundaries, or the reasons behind them) update `ARCHITECTURE.md` in the same change so it never describes a design that no longer exists
- When creating or updating structs or enums with `#[ts(export)]` always run `scripts/generate-ts-bindings` afterwards to generate the typescript interfaces
- The generated ts bindings are put in the `bindings` directory
- Never sleep in tests. Instead wait for a log message to appear or poll some API until the desired state is set
- Integration tests for the server and agent are in the `tests` directory. The tests are authored in Typescript and vitest. Run with `pn integration-test`
- UI unit tests live next to the source in `ui/src` as `*.test.ts(x)`. Run with `pn test:unit` (also part of `pn test`)
- Run Rust unit tests with `cargo nextest run --locked` (also part of `pn test`). Install the pinned runner with `mise install`.
- Add comments to test assertions why they are there
- Add integration tests for all rest api features
- Run `pn test` only after real code changes, including changes to executable scripts, tests, or configuration that affects application or build behavior. Use a timeout of at least 1200 seconds so cargo, integration, and Playwright can finish without the runner aborting mid-suite.
- Do not run tests or builds for changes limited to documentation, plans, or code comments. If those edits accompany real code changes, run the checks required for the code changes.
- If the changes are purely visual, running `pn build-and-restart` is enough instead of `pn test`; it builds the UI and server binary and restarts the `redoor-dev` systemd unit
- Purely visual changes (layout, spacing, wrapping, responsive breakpoints, colors) must not have tests. Do not assert element positions, sizes or styles in Playwright or unit tests
- Always add `| cat` to git commands to avoid getting stuck in interactive pager
- Do all work and commits directly on the `main` branch; do not create feature branches
- When making git commits always add description explaining why the change was made, not what it does
- Make multiple commits if there are clear distinct edits
- To make a release run `node scripts/release.mts <patch|minor|major>` on a clean `main`. It pushes `main`, bumps the version in `Cargo.toml`, commits, tags and pushes the tag, so do not bump versions or tag by hand
- On test failures see the ./log dir for related logs
- When a single test needs cleanup, always use onTestFinished() instead of try-finally
- When using `tokio::select!` keep the arm bodies small be delegating to methods/functions, since `cargo fmt` does not work with it.
- Always write multiline strings with real newlines inside the quotes, never escaped `\n` sequences.
- If you are asked to write a plan: Write a .md file to ./plans dir. Come up with short name
- When you see a transient flaky test that succeeds on second run log them to `./flaky-tests.md`
- When `./flaky-tests.md` shows the same test has been flaky more than once, spawn a subagent to fix its flakiness at the root cause, or to remove the test if it cannot be made reliable

# UI

The application UI is in the `ui` dir

It is a Tanstack Router application using file based routing.

Use TanStack Router route loaders for data that must be fetched immediately during navigation. Use TanStack Query for interactive page fetching and all mutations, and let loaders prime the Query cache when route data is shared with components.

Never call the API client from `useEffect`. Effects may coordinate browser APIs and subscriptions, but server reads belong in route loaders or TanStack Query and server writes belong in TanStack Query mutations.

Before reaching for local component state with `useState`, consider whether the state should be stored with `useHistoryEntryState` from `ui/src/history-entry-state.ts` so it is restored when the user navigates "back", or in the URL search params with `useSearch()` so it can be linked to.

Use Tailwind for styling.

Always consider mobile usability for every UI change, even when it is not asked for, because the app is used from phones. Lay controls out so they still fit and stay readable in a phone-narrow content column, keep touch targets large enough to tap, and prefer native controls such as `Select` where phones offer a better picker of their own.

Prefer container queries over viewport media queries for responsive layouts, including when asked to fix something "on mobile" or "on phones". Persistent side menus can make the content column phone-narrow on a wide screen, so content must respond to the column, not the viewport. `OverlayChromeLayout` makes the content column (page, top bar and bottom drawer) the `@container/main` container: use `@xl:` / `@max-xl:` (36rem) where the old viewport `sm:` would go, `@2xl:` for `md:`, and `@4xl:` for `lg:`. Inside a component that is its own `@container`, name the main container explicitly (`@max-xl/main:`). In JS use `useIsContentBelow("xl")` instead of `useIsBelowBreakpoint`. Viewport media queries (`sm:` etc. and `useIsBelowBreakpoint`) are only for shell decisions such as side menu drawers and for modal dialogs, which are sized against the viewport.

Combine and conditionally apply class names with `cn` from `ui/src/utils/cn.ts`. Do not call `twMerge` directly.

Always use the rest apis using `ui/src/api-client.ts`

If you need to add new apis to the client always use the generated typescript bindings

Never destructure props. Always to this with components:

```tsx
function DetailCard(props: {
    title: string;
    icon: React.ReactNode;
    children: React.ReactNode;
}) {}
```

After modifying the routes run `cd ui && pnpm run build` to regenerate the route types.

Do dot use class names in the playwright tests. Add accessibility aria attributes if there are no text to select with.

When adding a completely new UI feature, always add a Playwright test that covers its primary user workflow. Purely visual tweaks to existing UI are not new features and get no tests.

Playwright specs that mutate state shared by all specs (server or agent restarts, the device list, user settings/preferences such as theme, the hidden-file filter, bookmarks or pins, ...) go in `ui/e2e/serial/` with a top comment saying why; they run one at a time after the parallel specs. Everything else in `ui/e2e/` runs in parallel and must use its own fixtures and directories.

Never use ! to fix nullish issues in typescript. Always handle nullish values properly.

Reuse the overlay components in `ui/src/components`: `Toast` for transient live-region feedback, `Dialog` for modal workflows, and `Tooltip` for hover and keyboard-focus descriptions. Do not use the native `<dialog>` element for toasts or tooltips because they must remain non-modal.

Use `Tooltip` to clarify the purpose of most buttons and other form controls, especially icon-only or potentially ambiguous actions.

Do not use use plain <button> or <input> elements. Always use reusable component or create one.

Reusable components (update this list when adding new ones): ActionMenu, ActionMenuButton, AgentLifecycle, AgentRestartButton, AgentStatusDot, BrowserViewCard, Button, Checkbox, ClearableInput, ConfirmationDialog, ContextMenu, CopyableCodeRow, CopyableGitRef, CopyablePath, DecryptedDownloadMenuButton, DetailCard, Dialog, DialogActions, FileInput, FoldingSection, FullWindowToggle, HighlightedLines, HighlightedTokens, IconButton, IconLinkButton, InputControl, LinkButton, LogViewer, OpenInBackgroundButton, OptionalTooltip, OverlayChromeLayout, Password, PathBreadcrumbs, ProvisioningStatusList, RadioCardGroup, RadioCardOption, ResponsiveAnchoredDialog, RestartDialog, SearchButton, SegmentedControl, Select, SidebarModeToggle, SideMenu, SortableItem, SortableList, SshKeySetupDialog, Tab, TabbedBottomDrawer, TabList, TextField, ThemeToggle, Toast, ToggleButton, Tooltip, VaultDialog, ViewCardHeader
