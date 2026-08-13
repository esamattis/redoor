import {
    expect,
    test,
    type WebSocket as PlaywrightWebSocket,
} from "@playwright/test";
import { z } from "zod";
import {
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

const terminalFrameSchema = z.union([
    z.string(),
    z.instanceof(Buffer).transform((payload) => payload.toString("utf8")),
]);

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
                terminalOutput += terminalFrameSchema.parse(event.payload);
            });
        });

        await page.goto(ctx.agentBrowserUrl);
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();

        const terminalInput = page
            .getByLabel(`agent1_src 1 for ${ctx.agentName}`)
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
        const agentDetails = z
            .object({ cwd: z.string() })
            .parse(await detailsResponse.json());

        await page.goto(ctx.agentBrowserUrl);
        await expect(
            page.getByRole("tablist", { name: "Terminal tabs" }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "New terminal", exact: true }),
        ).toBeVisible();
        // An agent route must begin without allocating a Ghostty socket or PTY.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(0);
        // Rendering the empty tab strip must not eagerly open a terminal socket.
        expect(terminalSockets).toHaveLength(0);

        await page
            .getByRole("button", { name: "Choose agent for new terminal" })
            .click();
        // The picker must escape the collapsed panel's clipping boundary.
        await expect(
            page.getByRole("dialog", { name: "New terminal" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Close agent picker" }).click();

        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("tab", { name: "agent1_src 1" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        // The first tab snapshots the canonical cwd from the browser root.
        expect(terminalSockets).toHaveLength(1);
        expect(
            new URL(terminalSockets[0]?.url() ?? "").searchParams.get("cwd"),
        ).toBe(agentDetails.cwd);
        await expect(
            page.getByLabel(`agent1_src 1 for ${ctx.agentName}`),
        ).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");

        await page
            .getByRole("button", { name: "Minimize Terminal" })
            .press("Enter");
        await page
            .getByRole("button", { name: "Expand Terminal" })
            .press("Enter");
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
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
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 2: Connected" }),
        ).toBeVisible();
        // A terminal created in a directory uses the committed canonical path.
        expect(terminalSockets).toHaveLength(2);
        expect(
            new URL(terminalSockets[1]?.url() ?? "").searchParams.get("cwd"),
        ).toBe(ctx.testDirPath);

        await page.getByRole("tab", { name: "agent1_src 1" }).click();
        await expect(
            page.getByRole("tab", { name: "agent1_src 1" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
            page.getByLabel(`agent1_src 1 for ${ctx.agentName}`),
        ).toBeVisible();
        // Activating a terminal must leave focus in the tablist for keyboard navigation.
        await expect(
            page.getByRole("tab", { name: "agent1_src 1" }),
        ).toBeFocused();
        await page
            .getByRole("tab", { name: "agent1_src 1" })
            .press("ArrowRight");
        await expect(
            page.getByRole("tab", { name: "agent1_src 2" }),
        ).toHaveAttribute("aria-selected", "true");
        // Arrow navigation moves both selection and keyboard focus together.
        await expect(
            page.getByRole("tab", { name: "agent1_src 2" }),
        ).toBeFocused();
        // Mouse and keyboard tab switching preserve both live sockets.
        expect(terminalSockets).toHaveLength(2);

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        // The detail heading proves the file loader has committed before cwd is captured.
        await expect(
            page.getByRole("heading", { name: "File name" }),
        ).toContainText("file1.txt");
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 3: Connected" }),
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
        await page.getByRole("button", { name: "Close agent1_src 2" }).click();
        await secondSocketClosed;
        // Closing an inactive tab leaves the active tab and sibling sockets alive.
        await expect(
            page.getByRole("tab", { name: "agent1_src 3" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
            page.getByRole("tab", { name: "agent1_src 2" }),
        ).toHaveCount(0);

        const thirdSocket = terminalSockets[2];
        if (!thirdSocket) {
            throw new Error("third terminal socket was not created");
        }
        const thirdSocketClosed = thirdSocket.waitForEvent("close");
        await page.getByRole("button", { name: "Close agent1_src 3" }).click();
        await thirdSocketClosed;
        // Closing the active rightmost tab selects its left neighbor.
        await expect(
            page.getByRole("tab", { name: "agent1_src 1" }),
        ).toHaveAttribute("aria-selected", "true");

        const firstSocket = terminalSockets[0];
        if (!firstSocket) {
            throw new Error("first terminal socket was not created");
        }
        const firstSocketClosed = firstSocket.waitForEvent("close");
        await page.getByRole("button", { name: "Close agent1_src 1" }).click();
        await firstSocketClosed;
        // Closing the final tab restores the initial zero-terminal state.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(0);

        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 4: Connected" }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 5: Connected" }),
        ).toBeVisible();
        const fourthSocket = terminalSockets[3];
        const fifthSocket = terminalSockets[4];
        if (!fourthSocket || !fifthSocket) {
            throw new Error("replacement terminal sockets were not created");
        }
        await page
            .getByRole("tab", { name: "agent2_custom, connected" })
            .click();
        // Agent navigation retains tabs and their live shell connections.
        expect(terminalSockets).toHaveLength(5);
        await expect(
            page.getByRole("status", { name: "agent1_src 5: Connected" }),
        ).toBeVisible();

        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent2_custom 1: Connected" }),
        ).toBeVisible();
        // Each agent starts its own terminal numbering at one.
        expect(terminalSockets).toHaveLength(6);

        // Transfers live in the burger menu so agent tabs remain dedicated to agents.
        await page.getByRole("button", { name: "Open menu" }).click();
        await page
            .getByRole("dialog", { name: "Menu" })
            .getByRole("link", { name: "Transfers" })
            .click();
        // Non-agent routes retain all terminals but cannot infer a target for the direct action.
        await expect(
            page.getByRole("tab", { name: "agent2_custom 1" }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "New terminal", exact: true }),
        ).toHaveCount(0);
        await page
            .getByRole("button", { name: "Choose agent for new terminal" })
            .click();
        await page
            .getByRole("dialog", { name: "New terminal" })
            .getByRole("button", { name: ctx.agentName })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 6: Connected" }),
        ).toBeVisible();
        // Picker-created terminals continue the selected agent's local sequence.
        expect(terminalSockets).toHaveLength(7);
    });

    test("shows connection state and restart on the owning tab", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 2: Connected" }),
        ).toBeVisible();

        await page.getByRole("tab", { name: "agent1_src 1" }).click();
        const firstTerminalInput = page
            .getByLabel(`agent1_src 1 for ${ctx.agentName}`)
            .locator("textarea");
        await firstTerminalInput.pressSequentially("exit");
        await firstTerminalInput.press("Enter");

        await expect(
            page.getByRole("status", { name: "agent1_src 1: Disconnected" }),
        ).toBeVisible();
        await expect(
            page.getByRole("status", { name: "agent1_src 2: Connected" }),
        ).toBeVisible();
        // Recovery belongs to the failed tab instead of appearing as a shared panel action.
        await expect(
            page.getByRole("button", { name: "Restart agent1_src 1" }),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Restart agent1_src 2" }),
        ).toHaveCount(0);
    });

    test("opens or focuses the current agent terminal with t", async ({
        page,
    }) => {
        const terminalSockets: PlaywrightWebSocket[] = [];
        page.on("websocket", (socket) => {
            if (socket.url().includes("/terminal/ws")) {
                terminalSockets.push(socket);
            }
        });

        await page.goto(ctx.agentBrowserUrl);
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .hover();
        // The plus action advertises the equivalent keyboard shortcut.
        await expect(page.getByRole("tooltip")).toHaveText(
            `New terminal in ${ctx.agentName} (t)`,
        );
        await page.mouse.move(0, 0);

        await page.keyboard.press("t");
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        await expect(
            page.getByRole("tab", { name: "agent1_src 1" }),
        ).toHaveAttribute("aria-selected", "true");
        const firstTerminal = page.getByRole("textbox", {
            name: `agent1_src 1 for ${ctx.agentName}`,
        });
        // The shortcut must land in the shell so the user can type immediately.
        await expect(firstTerminal).toBeFocused();

        await page.keyboard.press("Escape");
        await page.keyboard.press("t");
        // A second press reuses the live tab instead of creating another shell.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(1);
        await expect(firstTerminal).toBeFocused();

        await page
            .getByRole("button", { name: "Minimize Terminal" })
            .press("Enter");
        await page.keyboard.press("t");
        // A collapsed live session is restored instead of opening a duplicate.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(1);
        await expect(firstTerminal).toBeFocused();

        await page
            .getByRole("tab", { name: "agent2_custom, connected" })
            .click();
        await page.keyboard.press("Escape");
        await page.keyboard.press("t");
        await expect(
            page.getByRole("status", { name: "agent2_custom 1: Connected" }),
        ).toBeVisible();
        // A different agent still needs its own first terminal.
        await expect(
            page.getByRole("tab", { name: "agent1_src 1" }),
        ).toBeVisible();

        await page.getByRole("tab", { name: "agent1_src, connected" }).click();
        await page.keyboard.press("Escape");
        await page.keyboard.press("t");
        // Returning to an agent focuses its existing live terminal.
        await expect(
            page.getByRole("tab", { name: "agent1_src 1" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(1);
        await expect(firstTerminal).toBeFocused();

        await page.keyboard.press("Escape");
        await page
            .getByRole("link", { name: ctx.testDirName, exact: true })
            .click();
        // The file listing proves the directory loader has committed before cwd is captured.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("t");
        await expect(
            page.getByRole("status", { name: "agent1_src 2: Connected" }),
        ).toBeVisible();
        // A different browse directory needs its own shell instead of refocusing the old cwd.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(2);
        expect(terminalSockets).toHaveLength(3);
        expect(
            new URL(terminalSockets[2]?.url() ?? "").searchParams.get("cwd"),
        ).toBe(ctx.testDirPath);

        await page.keyboard.press("Escape");
        await page.keyboard.press("t");
        // A second press in the same directory still reuses that directory's live tab.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(2);
        await expect(
            page.getByRole("tab", { name: "agent1_src 2" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
            page.getByRole("textbox", {
                name: `agent1_src 2 for ${ctx.agentName}`,
            }),
        ).toBeFocused();
    });

    test("does not invoke single-key shortcuts while the terminal is focused", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        const filterInput = page.getByRole("searchbox", {
            name: "Filter files",
        });
        await filterInput.focus();
        await page.keyboard.type("t");
        // Typing the shortcut key into an input must enter text instead of opening a terminal.
        await expect(filterInput).toHaveValue("t");
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(0);

        await page.keyboard.press("Escape");
        await filterInput.fill("");
        await page.keyboard.press("Escape");
        await page.keyboard.press("t");
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();

        const terminalInput = page.getByRole("textbox", {
            name: `agent1_src 1 for ${ctx.agentName}`,
        });
        await expect(terminalInput).toBeFocused();
        await page.keyboard.type("tfdj");
        // Shell input must not create tabs or trigger file-browser character shortcuts.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(1);
        await expect(terminalInput).toBeFocused();
        await expect(filterInput).not.toBeFocused();
        await expect(
            page.getByRole("dialog", { name: "Create directory" }),
        ).toHaveCount(0);
        await expect(page).toHaveURL(directoryUrl);

        await page.keyboard.press("Backspace");
        await page.keyboard.press("Backspace");
        await page.keyboard.press("Backspace");
        await page.keyboard.press("Backspace");
        // Backspace edits the shell instead of leaving the current directory.
        await expect(page).toHaveURL(directoryUrl);
        await expect(terminalInput).toBeFocused();
    });
});
