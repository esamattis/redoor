
Rust Tokio app using Axum and the Ractor Actor framework.

Architecture:

- Websocket server
- redoor agents that connects to the server
- web client: Web clients sees the connected agents and can execute commands on the agents

Guidelines

- Always use async apis from tokio instead of sync apis instead
- Always after changes run `./scripts/build-and-test`


# UI

The application UI  in in redoor-ui directory. 

It is a Tanstack Router application using file based routing.

Use Tailwind for styling.

