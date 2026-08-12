# Tools

- Node.js, mise, pnpm
- Rust, Tokio, Axum
- Always execute shell commands with `mise exec -- …` so the correct toolchain (Node, pnpm, etc.) is on PATH

# Architecture

- REST API and Websocket server
- redoor agents connects to the server via Websockets
- The server exposes REST API which can be used to execute commands in the agents using the websocket connection
- Support for memory restrained environments: All file uploads and downloads must be streamed without reading to whole file into the memory, this includes the tar streaming and any other streaming that could use lot of memory with big files
- Control commands should stay response even during long streaming downloads or uploads.

# Guidelines

- Always use async apis from tokio instead of sync apis instead
- Always comments to functions, structs, enums and methods
    - The comments should try to answer the "why" question
- Do not add one-line passthrough wrappers that only call another function or re-export a type. Call the real module directly.
- When adding a retust api always create a dedicated struct for it's reponse with `#[ts(export)]` derive macro which genertes the related typescript interface.
- Put behaviorally distinct REST endpoints in dedicated modules instead of adding them to an unrelated resource module. Group handlers only when they operate on the same domain and share a clear responsibility.
- When creating or updating structs or enums with `#[ts(export)]` always run `scripts/generate-ts-bindings` afterwards to generate the typescript interfaces
- The generated ts bindings are put in the `bindings` directory
- Never sleep in tests. Instead wait for a log message to appear or poll some API until the desired state is set
- Integration tests for the server and agent are in the `tests` directory. The tests are authored in Typescript and vitest. Run with `pn integration-test`
- Add comments to test assertions why they are there
- Add integration tests for all rest api features
- Always after changes run `pn test` with a timeout of at least 300 seconds so the integration and Playwright tests have enough time to finish
- Always add `| cat` to git commands to avoid getting stuck in interactive pager
- When making git commits always add description explaining why the change was made, not what it does
- Make multiple commits if there are clear distinct edits
- On test failures see the ./log dir for related logs
- When a single test needs cleanup, always use onTestFinished() instead of try-finally
- When using `tokio::select!` keep the arm bodies small be delegating to methods/functions, since `cargo fmt` does not work with it.
- Always write multiline strings with real newlines inside the quotes, never escaped `\n` sequences.
- If you are asked to write a plan: Write a .md file to ./plans dir. Come up with short name
- When you see a transient flaky test that succeeds on second run log them to `./flaky-tests.md`

# UI

The application UI is in the `ui` dir

It is a Tanstack Router application using file based routing.

Use TanStack Router route loaders for data that must be fetched immediately during navigation. Use TanStack Query for interactive page fetching and all mutations, and let loaders prime the Query cache when route data is shared with components.

Never call the API client from `useEffect`. Effects may coordinate browser APIs and subscriptions, but server reads belong in route loaders or TanStack Query and server writes belong in TanStack Query mutations.

Use Tailwind for styling.

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

When adding a completely new UI feature, always add a Playwright test that covers its primary user workflow.

Never use ! to fix nullish issues in typescript. Always handle nullish values properly.

Reuse the overlay components in `ui/src/components`: `Toast` for transient live-region feedback, `Dialog` for modal workflows, and `Tooltip` for hover and keyboard-focus descriptions. Do not use the native `<dialog>` element for toasts or tooltips because they must remain non-modal.
