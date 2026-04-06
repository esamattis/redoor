
Rust Tokio app using Axum and the Ractor Actor framework.

Architecture:

- REST API and Websocket server
- redoor agents connects to the server via Websockets
- The server exposes REST API which can be used to execute commands in the agents using the websocket connection
- Support for memory restrained environments: All file uploads and downloads must be streamed without reading to whole file into the memory, this includes the tar streaming and any other streaming that could use lot of memory with big files
- Control commands should stay response even during long streaming downloads or uploads.



Guidelines

- Always use async apis from tokio instead of sync apis instead
- When adding a retust api always create a dedicated struct for it's reponse with `#[ts(export)]` derive macro which genertes the related typescript interface.
- When creating or updating structs or enums with `#[ts(export)]` always run `scripts/generate-ts-bindings` afterwards to generate the typescript interfaces
- The generated ts bindings are put in the `bindings` directory
- Never sleep in tests. Instead wait for a log message to appear or poll some API until the desired state is set
- Integration tests for the server and agent are in the `tests` directory. The tests are authored in Typescript and vitest. Run with `pnpm run test`
- Add comments to test assertions why they are there
- Always after changes run `./scripts/build-and-test`
- Always add `| cat` to git commands to avoid getting stuck in interactive pager
- Never make git commit unless asked to!
- On test failures see the ./log dir for related logs
- When a single test needs cleanup, always use onTestFinished() instead of try-finally
- When using `tokio::select!` keep the arm bodies small be delegating to methods/functions, since `cargo fmt` does not work with it.


# UI

The application UI is in the `ui` dir

It is a Tanstack Router application using file based routing.

Use Tailwind for styling.

Always use the rest apis using `ui/src/api-client.ts`

If you need to add new apis to the client always use the generated typescript bindings

Never destructure props. Always to this with components:

```tsx
function DetailCard(props: {
    title: string;
    icon: React.ReactNode;
    children: React.ReactNode;
}) { }
```

After modifying the routes run `cd ui && pnpm run build` to regenerate the route types.

Do dot use class names in the playwright tests. Add accessibility aria attributes if there are no text to select with.

Never use ! to fix nullish issues in typescript. Always handle nullish values properly.
