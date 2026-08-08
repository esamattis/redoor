import { request } from "@playwright/test";
import path from "node:path";

import { WEB_BASE_URL } from "./helpers";

/** Logs the browser suite in once so existing scenarios all cross the cookie boundary. */
export default async function globalSetup(): Promise<void> {
    const storagePath = path.resolve(".test-playwright-auth.json");
    const context = await request.newContext({ baseURL: WEB_BASE_URL });
    const response = await context.post("/api/v1/login", {
        data: {
            username: "test-user",
            password: "test-password",
        },
    });
    if (!response.ok()) {
        throw new Error(`Playwright login failed: ${response.status()}`);
    }
    await context.storageState({ path: storagePath });
    await context.dispose();
}
