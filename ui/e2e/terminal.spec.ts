import {
    expect,
    test,
    type WebSocket as PlaywrightWebSocket,
} from "@playwright/test";
import { z } from "zod";
import { ApiClient } from "#ui/api-client";
import {
    API_BASE_URL,
    minimizeBottomDrawer,
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

    test.afterEach(async () => {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // Later browser tests assume the default system theme.
        await api.updateUserState({
            state: {
                showHiddenFiles: true,
                theme: "system",
                bookmarks: [],
                vimMode: false,
                wrapEditorLines: false,
                recursiveSearchTimeoutSeconds: 5,
                recursiveSearchIncludeHidden: false,
                recursiveSearchRespectGitignore: true,
            },
        });
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
        await page.getByRole("tab", { name: "Terminal" }).click();
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

    test("expands the terminal to the full window without replacing its session", async ({
        page,
    }) => {
        const terminalSockets: PlaywrightWebSocket[] = [];
        page.on("websocket", (socket) => {
            if (socket.url().includes("/terminal/ws")) {
                terminalSockets.push(socket);
            }
        });

        await page.goto(ctx.agentBrowserUrl);
        await page.getByRole("tab", { name: "Terminal" }).click();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();

        const terminalPanel = page.getByRole("region", {
            name: "Terminal panel",
        });
        const expandButton = page.getByRole("button", {
            name: "Expand terminal to full window",
        });
        await expect(expandButton).toHaveAttribute("aria-pressed", "false");
        await expandButton.click();

        const panelBox = await terminalPanel.boundingBox();
        const viewport = page.viewportSize();
        expect(panelBox).not.toBeNull();
        expect(viewport).not.toBeNull();
        if (panelBox === null || viewport === null) {
            throw new Error("expected expanded terminal measurements");
        }
        // The terminal panel, including its tabs and controls, fills the browser window.
        expect(panelBox.x).toBe(0);
        expect(panelBox.y).toBe(0);
        expect(panelBox.width).toBe(viewport.width);
        expect(panelBox.height).toBe(viewport.height);
        await expect(
            terminalPanel.getByRole("button", {
                name: "Restore terminal size",
            }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(
            terminalPanel.getByRole("tab", { name: "agent1_src 1" }),
        ).toBeVisible();
        // Full-window expansion must retain the connected PTY rather than remounting it.
        expect(terminalSockets).toHaveLength(1);

        await terminalPanel
            .getByRole("button", { name: "Restore terminal size" })
            .click();
        await expect(
            page.getByRole("button", {
                name: "Expand terminal to full window",
            }),
        ).toHaveAttribute("aria-pressed", "false");
        // Restoring also retains the same live terminal session.
        expect(terminalSockets).toHaveLength(1);
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
        await page.getByRole("tab", { name: "Terminal" }).click();
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
            .getByRole("button", { name: "Minimize bottom drawer" })
            .press("Enter");
        await page
            .getByRole("button", { name: "Expand bottom drawer" })
            .press("Enter");
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        // Minimize and re-expand retain the existing terminal session.
        expect(terminalSockets).toHaveLength(1);

        await minimizeBottomDrawer(page);
        await page
            .getByRole("link", { name: ctx.testDirName, exact: true })
            .click();
        // The file listing proves the directory loader has committed before cwd is captured.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
        await page.getByRole("tab", { name: "Terminal" }).click();
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

        await minimizeBottomDrawer(page);
        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        // The editor proves the file loader has committed before cwd is captured.
        await expect(page.getByLabel("File editor")).toBeVisible();
        await page.getByRole("tab", { name: "Terminal" }).click();
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
            .getByRole("link", { name: "agent2_custom, connected" })
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

        // Transfers remain separate from agent tabs in the application sidebar.
        await page
            .getByRole("navigation", { name: "Application" })
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
            .hover();
        // Application routes advertise that the shortcut opens the required agent choice.
        await expect(
            page.getByRole("tooltip", {
                name: "Choose agent for new terminal (t)",
            }),
        ).toBeVisible();
        await page.mouse.move(0, 0);
        await page.keyboard.press("t");
        // The global shortcut must remain usable when no routed agent can be inferred.
        await expect(
            page.getByRole("dialog", { name: "New terminal" }),
        ).toBeVisible();
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
        await page.getByRole("tab", { name: "Terminal" }).click();
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
        await page.getByRole("tab", { name: "Terminal" }).click();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .hover();
        // The plus action advertises the equivalent keyboard shortcut.
        await expect(
            page.getByRole("tooltip", {
                name: `New terminal in ${ctx.agentName} (t, Alt+t)`,
            }),
        ).toBeVisible();
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

        await page.getByRole("tab", { name: "agent1_src 1" }).click();
        await page.keyboard.press("t");
        // A second press reuses the live tab instead of creating another shell.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(1);
        await expect(firstTerminal).toBeFocused();

        await page
            .getByRole("button", { name: "Minimize bottom drawer" })
            .press("Enter");
        await page.keyboard.press("t");
        // A collapsed live session is restored instead of opening a duplicate.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(1);
        await expect(firstTerminal).toBeFocused();

        await page
            .getByRole("link", { name: "agent2_custom, connected" })
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

        await page.getByRole("link", { name: "agent1_src, connected" }).click();
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

        await minimizeBottomDrawer(page);
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

        await page.getByRole("tab", { name: "agent1_src 2" }).click();
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
        const terminalPanel = page.getByRole("tabpanel", {
            name: "agent1_src 1",
        });
        await expect(terminalInput).toBeFocused();
        // A focused shell must show a blue frame so keyboard ownership is visible.
        await expect(terminalPanel).toHaveCSS(
            "border-color",
            "oklch(0.623 0.214 259.815)",
        );
        await page.keyboard.press("Escape");
        // Escape must stay in the shell so control sequences remain available.
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

    test("copies and pastes from the terminal context menu", async ({
        page,
        context,
    }) => {
        let terminalOutput = "";
        page.on("websocket", (socket) => {
            if (!socket.url().includes("/terminal/ws")) {
                return;
            }
            socket.on("framereceived", (event) => {
                terminalOutput += terminalFrameSchema.parse(event.payload);
            });
        });

        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: WEB_BASE_URL,
        });
        await page.goto(ctx.agentBrowserUrl);
        await page.getByRole("tab", { name: "Terminal" }).click();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();

        const terminalHost = page.getByLabel(
            `agent1_src 1 for ${ctx.agentName}`,
        );
        const terminalInput = terminalHost.locator("textarea");
        const canvas = terminalHost.locator("canvas");
        await canvas.click({ button: "right" });
        const actions = page.getByRole("dialog", { name: "Terminal actions" });
        // A canvas right-click must replace the browser image menu.
        await expect(actions).toBeVisible();
        // Copy stays unavailable until Ghostty has a real selection.
        await expect(
            actions.getByRole("button", { name: "Copy" }),
        ).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(actions).toHaveCount(0);

        await terminalInput.focus();
        // Octal escapes print the marker without putting it in the echoed command.
        await terminalInput.pressSequentially(
            "printf '\\164\\145\\162\\155\\151\\156\\141\\154\\055\\143\\157\\160\\171\\n'",
        );
        await terminalInput.press("Enter");
        await expect.poll(() => terminalOutput).toContain("terminal-copy");

        const box = await canvas.boundingBox();
        if (box === null) {
            throw new Error("terminal canvas is not visible");
        }
        await page.mouse.move(box.x + 4, box.y + 4);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4);
        await page.mouse.up();

        await canvas.click({ button: "right", position: { x: 12, y: 12 } });
        await expect(actions).toBeVisible();
        const copyButton = actions.getByRole("button", { name: "Copy" });
        // Dragging across the canvas must create a copyable Ghostty selection.
        await expect(copyButton).toBeEnabled();
        await page.evaluate(() => navigator.clipboard.writeText(""));
        await copyButton.click();
        // The menu action must write the selected terminal text, not an image.
        await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toContain("terminal-copy");

        await page.evaluate(() =>
            navigator.clipboard.writeText(
                "printf '\\160\\141\\163\\164\\145\\055\\157\\153\\n'",
            ),
        );
        await canvas.click({ button: "right", position: { x: 12, y: 12 } });
        await actions.getByRole("button", { name: "Paste" }).click();
        // The async clipboard read closes the menu only after text reaches Ghostty.
        await expect(actions).toHaveCount(0);
        await terminalInput.press("Enter");
        // Paste must reach the PTY as input rather than staying in the browser.
        await expect.poll(() => terminalOutput).toContain("paste-ok");
    });

    test("follows the app light theme without dropping the shell", async ({
        page,
    }) => {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({
            state: {
                showHiddenFiles: true,
                theme: "dark",
                bookmarks: [],
                vimMode: false,
                wrapEditorLines: false,
                recursiveSearchTimeoutSeconds: 5,
                recursiveSearchIncludeHidden: false,
                recursiveSearchRespectGitignore: true,
            },
        });

        await page.goto(ctx.agentBrowserUrl);
        await page.getByRole("tab", { name: "Terminal" }).click();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();

        const surface = page.locator("[data-terminal-theme]");
        // Dark mode must keep the Ghostty frame on the app canvas color.
        await expect(surface).toHaveAttribute("data-terminal-theme", "dark");
        await expect(surface).toHaveCSS("background-color", "rgb(11, 13, 18)");

        await page.getByRole("button", { name: "Color theme: Dark" }).click();
        // A live theme toggle must restyle the open terminal instead of leaving a dark hole.
        await expect(surface).toHaveAttribute("data-terminal-theme", "light");
        await expect(surface).toHaveCSS(
            "background-color",
            "rgb(248, 250, 252)",
        );
        // Remounting Ghostty for WASM default colors must keep the existing PTY.
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
    });
});
