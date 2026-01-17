
Rust Tokio app using Axum and the Ractor Actor framework.

Architecture:

- Websocket server
- redoor agents that connects to the server via via Websockets 
- The server exposes REST API which can be used to execute commands in the agents using the websocket connection

Guidelines

- Always use async apis from tokio instead of sync apis instead
- Never sleep in tests. Instead wait for a log message to appear or poll some API until the desired state is set
- Add comments to test assertions why they are there
- Always after changes run `./scripts/build-and-test`


# UI

The application UI  in in redoor-ui directory. 

It is a Tanstack Router application using file based routing.

Use Tailwind for styling.

