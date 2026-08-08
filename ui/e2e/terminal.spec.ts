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

    test("initializes a shell and executes a command", async ({ page }) => {
        let terminalOutput = "";
        page.on("websocket", (socket) => {
            if (!socket.url().includes("/terminal/ws")) {
                return;
            }
            socket.on("framereceived", (event) => {
                terminalOutput +=
                    typeof event.payload === "string"
                        ? event.payload
                        : event.payload.toString("utf8");
            });
        });

        await page.goto(ctx.agentBrowserUrl);
        await page.getByRole("button", { name: "New terminal" }).click();
        await expect(
            page.getByRole("status", { name: "Terminal 1: Connected" }),
        ).toBeVisible();

        const terminalInput = page
            .getByLabel(`Terminal 1 for ${ctx.agentName}`)
            .locator("textarea");
        await terminalInput.focus();
        // Octal escapes print "terminal-ok" without putting that marker in the echoed command.
        await terminalInput.pressSequentially(
            "printf '\\164\\145\\162\\155\\151\\156\\141\\154\\055\\157\\153\\n'",
        );
        await terminalInput.press("Enter");

        // Only an executed printf produces the decoded marker in PTY output.
        await expect.poll(() => terminalOutput).toContain("terminal-ok");
    });

    test("keeps independent terminal tabs in their captured directories", async ({
        page,
        request,
    }) => {
        const terminalSockets: PlaywrightWebSocket[] = [];
        page.on("websocket", (socket) => {
            if (socket.url().includes("/terminal/ws")) {
                terminalSockets.push(socket);
            }
        });
        const detailsResponse = await request.get(
            `${WEB_BASE_URL}/api/v1/agents/${ctx.agentId}`,
        );
        const agentDetails = (await detailsResponse.json()) as { cwd: string };

        await page.goto(ctx.agentBrowserUrl);
        await expect(
            page.getByRole("tablist", { name: "Terminal tabs" }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "New terminal" }),
        ).toBeVisible();
        // An agent route must begin without allocating a Ghostty socket or PTY.
        await expect(page.getByRole("tab", { name: /^Terminal / })).toHaveCount(
            0,
        );
        await expect(
            page.getByRole("status", { name: "Terminal count" }),
        ).toHaveText("No terminals");
        // Rendering the empty tab strip must not eagerly open a terminal socket.
        expect(terminalSockets).toHaveLength(0);

        await page.getByRole("button", { name: "New terminal" }).click();
        await expect(
            page.getByRole("tab", { name: "Terminal 1" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
            page.getByRole("status", { name: "Terminal 1: Connected" }),
        ).toBeVisible();
        // The first tab snapshots the canonical cwd from the browser root.
        expect(terminalSockets).toHaveLength(1);
        expect(
            new URL(terminalSockets[0]?.url() ?? "").searchParams.get("cwd"),
        ).toBe(agentDetails.cwd);
        await expect(
            page.getByLabel(`Terminal 1 for ${ctx.agentName}`),
        ).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");

        await page
            .getByRole("button", { name: "Minimize Terminal" })
            .press("Enter");
        await page
            .getByRole("button", { name: "Expand Terminal" })
            .press("Enter");
        await expect(
            page.getByRole("status", { name: "Terminal 1: Connected" }),
        ).toBeVisible();
        // Minimize and re-expand retain the existing terminal session.
        expect(terminalSockets).toHaveLength(1);

        await page
            .getByRole("link", { name: ctx.testDirName, exact: true })
            .click();
        // The file listing proves the directory loader has committed before cwd is captured.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: "New terminal" }).click();
        await expect(
            page.getByRole("status", { name: "Terminal 2: Connected" }),
        ).toBeVisible();
        // A terminal created in a directory uses the committed canonical path.
        expect(terminalSockets).toHaveLength(2);
        expect(
            new URL(terminalSockets[1]?.url() ?? "").searchParams.get("cwd"),
        ).toBe(ctx.testDirPath);

        await page.getByRole("tab", { name: "Terminal 1" }).click();
        await expect(
            page.getByRole("tab", { name: "Terminal 1" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
            page.getByLabel(`Terminal 1 for ${ctx.agentName}`),
        ).toBeVisible();
        await page.getByRole("tab", { name: "Terminal 1" }).press("ArrowRight");
        await expect(
            page.getByRole("tab", { name: "Terminal 2" }),
        ).toHaveAttribute("aria-selected", "true");
        // Mouse and keyboard tab switching preserve both live sockets.
        expect(terminalSockets).toHaveLength(2);

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        // The detail heading proves the file loader has committed before cwd is captured.
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("file1.txt");
        await page.getByRole("button", { name: "New terminal" }).click();
        await expect(
            page.getByRole("status", { name: "Terminal 3: Connected" }),
        ).toBeVisible();
        // An open file contributes its parent directory, not the file path.
        expect(terminalSockets).toHaveLength(3);
        expect(
            new URL(terminalSockets[2]?.url() ?? "").searchParams.get("cwd"),
        ).toBe(ctx.testDirPath);

        const secondSocket = terminalSockets[1];
        if (!secondSocket) {
            throw new Error("second terminal socket was not created");
        }
        const secondSocketClosed = secondSocket.waitForEvent("close");
        await page.getByRole("button", { name: "Close Terminal 2" }).click();
        await secondSocketClosed;
        // Closing an inactive tab leaves the active tab and sibling sockets alive.
        await expect(
            page.getByRole("tab", { name: "Terminal 3" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tab", { name: "Terminal 2" })).toHaveCount(
            0,
        );

        const thirdSocket = terminalSockets[2];
        if (!thirdSocket) {
            throw new Error("third terminal socket was not created");
        }
        const thirdSocketClosed = thirdSocket.waitForEvent("close");
        await page.getByRole("button", { name: "Close Terminal 3" }).click();
        await thirdSocketClosed;
        // Closing the active rightmost tab selects its left neighbor.
        await expect(
            page.getByRole("tab", { name: "Terminal 1" }),
        ).toHaveAttribute("aria-selected", "true");

        const firstSocket = terminalSockets[0];
        if (!firstSocket) {
            throw new Error("first terminal socket was not created");
        }
        const firstSocketClosed = firstSocket.waitForEvent("close");
        await page.getByRole("button", { name: "Close Terminal 1" }).click();
        await firstSocketClosed;
        // Closing the final tab restores the initial zero-terminal state.
        await expect(page.getByRole("tab", { name: /^Terminal / })).toHaveCount(
            0,
        );
        await expect(
            page.getByRole("status", { name: "Terminal count" }),
        ).toHaveText("No terminals");

        await page.getByRole("button", { name: "New terminal" }).click();
        await expect(
            page.getByRole("status", { name: "Terminal 4: Connected" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "New terminal" }).click();
        await expect(
            page.getByRole("status", { name: "Terminal 5: Connected" }),
        ).toBeVisible();
        const fourthSocket = terminalSockets[3];
        const fifthSocket = terminalSockets[4];
        if (!fourthSocket || !fifthSocket) {
            throw new Error("replacement terminal sockets were not created");
        }
        const fourthSocketClosed = fourthSocket.waitForEvent("close");
        const fifthSocketClosed = fifthSocket.waitForEvent("close");
        await page
            .getByRole("tab", { name: "agent2_custom, connected" })
            .click();
        await Promise.all([fourthSocketClosed, fifthSocketClosed]);
        // Agent changes destroy every old tab and mount an empty panel.
        await expect(page.getByRole("tab", { name: /^Terminal / })).toHaveCount(
            0,
        );
        await expect(
            page.getByRole("status", { name: "Terminal count" }),
        ).toHaveText("No terminals");
        expect(terminalSockets).toHaveLength(5);

        // Transfers live in the burger menu so agent tabs remain dedicated to agents.
        await page.getByRole("button", { name: "Open menu" }).click();
        await page
            .getByRole("dialog", { name: "Menu" })
            .getByRole("link", { name: "Transfers" })
            .click();
        // Non-agent routes must not retain the terminal panel.
        await expect(
            page.getByRole("heading", { name: "Terminal" }),
        ).toHaveCount(0);
    });

    test("shows connection state and restart on the owning tab", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page.getByRole("button", { name: "New terminal" }).click();
        await expect(
            page.getByRole("status", { name: "Terminal 1: Connected" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "New terminal" }).click();
        await expect(
            page.getByRole("status", { name: "Terminal 2: Connected" }),
        ).toBeVisible();

        await page.getByRole("tab", { name: "Terminal 1" }).click();
        const firstTerminalInput = page
            .getByLabel(`Terminal 1 for ${ctx.agentName}`)
            .locator("textarea");
        await firstTerminalInput.pressSequentially("exit");
        await firstTerminalInput.press("Enter");

        await expect(
            page.getByRole("status", { name: "Terminal 1: Disconnected" }),
        ).toBeVisible();
        await expect(
            page.getByRole("status", { name: "Terminal 2: Connected" }),
        ).toBeVisible();
        // Recovery belongs to the failed tab instead of appearing as a shared panel action.
        await expect(
            page.getByRole("button", { name: "Restart Terminal 1" }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Restart Terminal 2" }),
        ).toHaveCount(0);
    });
});
