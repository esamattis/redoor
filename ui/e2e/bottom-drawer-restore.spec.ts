import { expect, test } from "@playwright/test";
import { ApiClient } from "#ui/api-client";
import {
    API_BASE_URL,
    deleteIsolatedTerminalSessions,
    deviceBrowserUrl,
    isolateTerminalSessions,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

test.describe("Bottom drawer after a reload", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("bottom-drawer-restore");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.beforeEach(async ({ page }) => {
        // Terminal sessions are shared server state; see `isolateTerminalSessions`.
        await isolateTerminalSessions(page);
    });

    test.afterEach(async ({ page }) => {
        await deleteIsolatedTerminalSessions(page);
    });

    test("keeps the drawer open on the same tab and height", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page.getByRole("tab", { name: "Transfers" }).click();

        const separator = page.getByRole("separator", {
            name: "Resize bottom drawer",
        });

        await separator.focus();
        await separator.press("ArrowUp");
        await separator.press("ArrowUp");
        // Two keyboard steps of 24px from the default height.
        await expect(separator).toHaveAttribute("aria-valuenow", "448");

        await page.reload();

        // The drawer comes back expanded instead of folded to its tab strip.
        await expect(
            page.getByRole("button", { name: "Minimize bottom drawer" }),
        ).toBeVisible();
        // The pane the user was looking at is still the one shown.
        await expect(
            page.getByRole("tab", { name: "Transfers" }),
        ).toHaveAttribute("aria-selected", "true");
        // The dragged height survives instead of snapping back to the default.
        await expect(
            page.getByRole("separator", { name: "Resize bottom drawer" }),
        ).toHaveAttribute("aria-valuenow", "448");
    });

    test("shows another terminal when the remembered one was destroyed", async ({
        page,
    }) => {
        // A directory of its own tells this spec's sessions apart in the server's list.
        const url = deviceBrowserUrl(ctx.agentName, ctx.testDirPath);
        await page.goto(url);
        await page.getByRole("tab", { name: "Terminal" }).click();

        const newTerminal = page.getByRole("button", {
            name: "New terminal",
            exact: true,
        });

        await newTerminal.click();
        await expect(
            page.getByRole("status", { name: /: Connected$/ }),
        ).toHaveCount(1);
        await newTerminal.click();
        await newTerminal.click();

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");

        const ownSessions = async () =>
            (await api.listTerminalSessions()).sessions
                .filter((session) => session.cwd === ctx.testDirPath)
                .sort((left, right) => left.created_at - right.created_at);

        await expect.poll(async () => (await ownSessions()).length).toBe(3);

        const [kept, waiting, destroyed] = await ownSessions();

        if (
            kept === undefined ||
            waiting === undefined ||
            destroyed === undefined
        ) {
            throw new Error("All three terminal sessions should be listed");
        }

        // The newest terminal is the active one this tab remembers.
        await expect(
            page.getByRole("status", { name: `${destroyed.title}: Connected` }),
        ).toBeVisible();

        // Leave the page so it cannot follow the deletion live; session storage stays with
        // the browser tab, like when a closed laptop wakes up after the shell was killed.
        await page.goto("about:blank");
        await api.deleteTerminalSession(destroyed.id);
        // A fresh load rather than going back, which could resume the page from the cache.
        await page.goto(url);

        // The drawer is restored open on the terminal pane and shows the surviving shell
        // instead of an empty pane.
        await expect(
            page.getByRole("tab", { name: "Terminal" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
            page.getByRole("status", { name: `${kept.title}: Connected` }),
        ).toBeVisible();
        // A restored tab that is not shown attaches only when opened, so it must not look
        // like a connection that never finishes.
        await expect(
            page.getByRole("status", {
                name: `${waiting.title}: Not attached`,
            }),
        ).toBeVisible();
    });
});
