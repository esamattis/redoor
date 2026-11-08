import { type APIRequest, test as base } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

export * from "@playwright/test";

/** What `storageState` accepts: the cookies and origins of a signed-in browser. */
type StorageState = Awaited<
    ReturnType<Awaited<ReturnType<APIRequest["newContext"]>>["storageState"]>
>;

/**
 * Signs in a new browser session and returns it as a storage state for a browser context.
 *
 * Every context needs a session of its own: the server rotates the session cookie's secret
 * while a page is used, and a second context still presenting the old secret looks exactly
 * like a copied browser profile, so the server would sign both out.
 */
export async function signedInStorageState(
    request: APIRequest,
): Promise<StorageState> {
    // Without cookies of its own: inside a test, request contexts inherit the test's signed-in
    // storage state, and a login that presents a session ends that session, which would sign
    // out the test's own page.
    const context = await request.newContext({
        baseURL: WEB_BASE_URL,
        storageState: { cookies: [], origins: [] },
    });

    try {
        const response = await context.post("/api/v1/login", {
            data: { username: "test-user", password: "test-password" },
        });

        if (!response.ok()) {
            throw new Error(`Playwright login failed: ${response.status()}`);
        }

        return await context.storageState();
    } finally {
        await context.dispose();
    }
}

/**
 * The browser suite's `test`: each test starts signed in with a session of its own (see
 * `signedInStorageState`). `test.use({ storageState })` still replaces it, for specs that
 * start signed out.
 */
export const test = base.extend({
    storageState: async ({ playwright }, use) => {
        await use(await signedInStorageState(playwright.request));
    },
});
