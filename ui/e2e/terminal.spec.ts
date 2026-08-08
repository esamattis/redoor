import {
    expect,
    test,
    type WebSocket as PlaywrightWebSocket,
} from "@playwright/test";
import {
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe.serial("Terminal panel lifecycle", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("terminal");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("starts lazily and distinguishes minimize from close", async ({
        page,
    }) => {
        const terminalSockets: PlaywrightWebSocket[] = [];
        page.on("websocket", (socket) => {
            if (socket.url().includes("/terminal/ws")) {
                terminalSockets.push(socket);
            }
        });

        await page.goto(`${WEB_BASE_URL}/agents/${ctx.agentId}/browser`);
        await expect(
            page.getByText("Not started", { exact: true }),
        ).toBeVisible();
        // No dedicated data-plane socket is created by page load or the minimized launcher.
        expect(terminalSockets).toHaveLength(0);

        await page
            .getByRole("button", { name: "Expand Terminal" })
            .press("Enter");
        await expect(
            page.getByText("Connected", { exact: true }),
        ).toBeVisible();
        // First expansion initializes exactly one ephemeral terminal session.
        expect(terminalSockets).toHaveLength(1);

        await page
            .getByRole("button", { name: "Minimize Terminal" })
            .press("Enter");
        await page
            .getByRole("button", { name: "Expand Terminal" })
            .press("Enter");
        await expect(
            page.getByText("Connected", { exact: true }),
        ).toBeVisible();
        // Re-expansion reuses the live PTY rather than opening another socket.
        expect(terminalSockets).toHaveLength(1);

        const firstSocket = terminalSockets[0];
        if (!firstSocket) {
            throw new Error("first terminal socket was not created");
        }
        const firstSocketClosed = firstSocket.waitForEvent("close");
        await page
            .getByRole("button", { name: "Close terminal" })
            .press("Enter");
        await firstSocketClosed;
        await expect(
            page.getByText("Not started", { exact: true }),
        ).toBeVisible();

        await page
            .getByRole("button", { name: "Expand Terminal" })
            .press("Enter");
        await expect(
            page.getByText("Connected", { exact: true }),
        ).toBeVisible();
        // Expansion after Close creates a fresh non-sticky shell session.
        expect(terminalSockets).toHaveLength(2);

        const secondSocket = terminalSockets[1];
        if (!secondSocket) {
            throw new Error("second terminal socket was not created");
        }
        const secondSocketClosed = secondSocket.waitForEvent("close");
        await page.getByRole("tab", { name: "agent2_custom" }).click();
        await secondSocketClosed;
        await expect(
            page.getByText("Not started", { exact: true }),
        ).toBeVisible();
        // Switching agents mounts a fresh minimized controller without eager setup.
        expect(terminalSockets).toHaveLength(2);

        await page.getByRole("tab", { name: "Transfers" }).click();
        await expect(
            page.getByRole("heading", { name: "Terminal" }),
        ).toHaveCount(0);
    });
});
