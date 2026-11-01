---
name: add-rest-endpoint
description: Use when adding or changing a REST API endpoint, its response type, or its method in `ui/src/api-client.ts`.
---

# Add a REST Endpoint

1. Put a behaviorally distinct endpoint in a dedicated module instead of an unrelated resource module. Group handlers only when they operate on the same domain and share a clear responsibility.
2. Give the response a dedicated struct with the `#[ts(export)]` derive macro, which generates the TypeScript interface.
3. Run `scripts/generate-ts-bindings`. The interfaces are written to `bindings/`.
4. If the UI calls the endpoint, add the method to `ui/src/api-client.ts` typed with the generated bindings.
5. Add integration tests in `tests/`, following the `write-tests` skill.
