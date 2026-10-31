// Serial: switches the shared theme to dark and resets every user setting after each test,
// and its terminal sessions outlive pages, so another spec's pages would restore them as tabs.
import {
    expect,
    test,
    type WebSocket as PlaywrightWebSocket,
} from "@playwright/test";
import { z } from "zod";
import { ApiClient } from "#ui/api-client";
import { dragReorderRow } from "../reorder";
import {
    API_BASE_URL,
    deleteAllTerminalSessions,
    expectTerminalFocused,
    isTerminalSocket,
    minimizeBottomDrawer,
    setupTestDir,
    teardownTestDir,
    terminalSocketCwd,
    WEB_BASE_URL,
    type TestContext,
} from "../helpers";

const terminalFrameSchema = z.union([
    z.string(),
    z.instanceof(Buffer).transform((payload) => payload.toString("utf8")),
]);

const terminalResizeFrameSchema = z.object({
    type: z.literal("resize"),
    size: z.object({ rows: z.number(), cols: z.number() }),
});

test.describe.serial("Terminal panel lifecycle", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("terminal");
        await deleteAllTerminalSessions();
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.afterEach(async () => {
        // Sessions outlive the page; the next test must not restore this test's shells.
        await deleteAllTerminalSessions();
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

    test("opens the editor terminal from matching shortcuts", async ({
        page,
    }) => {
        const terminalSockets: PlaywrightWebSocket[] = [];
        page.on("websocket", (socket) => {
            if (isTerminalSocket(socket.url())) {
                terminalSockets.push(socket);
            }
        });
        await page.goto(ctx.agentBrowserUrl);
        await page
            .getByRole("link", { name: ctx.testDirName, exact: true })
            .click();
        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();
        const editor = page.getByLabel("File editor", { exact: true });
        const terminal = page.getByLabel(`agent1_src 1 for ${ctx.agentName}`);

        await editor.press("Alt+t");
        // Option/Alt+t creates a ready shell from the editor and focuses it for immediate typing.
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        await expectTerminalFocused(terminal);
        // A file editor opens its terminal in the parent directory.
        expect(await terminalSocketCwd(terminalSockets[0]?.url() ?? "")).toBe(
            ctx.testDirPath,
        );
        await page.keyboard.press("Alt+e");
        const originalText = await editor.innerText();
        await editor.press("t");
        // Plain t remains editor input and cannot create another shell.
        await expect(editor).not.toHaveText(originalText);
        expect(terminalSockets).toHaveLength(1);
        await page
            .getByRole("button", { name: "Minimize bottom drawer" })
            .click();
        await expect(
            page.getByRole("button", { name: "Expand bottom drawer" }),
        ).toBeVisible();
        await editor.press("Alt+t");
        // Option/Alt+t reveals the folded drawer and returns to the same shell instead of a new one.
        await expectTerminalFocused(terminal);
        await page.keyboard.press("Alt+e");
        await page
            .getByRole("button", { name: "Expand editor to full window" })
            .focus();
        await page.keyboard.press("t");
        // Outside text entry, the single-key shortcut invokes the same reuse action.
        await expectTerminalFocused(terminal);
        expect(terminalSockets).toHaveLength(1);
    });

    test("initializes a shell and executes a command", async ({ page }) => {
        let terminalOutput = "";
        page.on("websocket", (socket) => {
            if (!isTerminalSocket(socket.url())) {
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

    test("types Finnish macOS Option characters without terminal escape prefixes", async ({
        page,
    }) => {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "platform", {
                get: () => "MacIntel",
            });
        });
        const inputFrames: string[] = [];
        page.on("websocket", (socket) => {
            if (isTerminalSocket(socket.url())) {
                socket.on("framesent", (event) => {
                    inputFrames.push(terminalFrameSchema.parse(event.payload));
                });
            }
        });
        await page.goto(ctx.agentBrowserUrl);
        await page.getByRole("tab", { name: "Terminal" }).click();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        // Wait for PTY readiness so the character cannot be discarded during setup.
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();

        const terminalInput = page
            .getByLabel(`agent1_src 1 for ${ctx.agentName}`)
            .locator("textarea");

        await terminalInput.focus();
        const cdp = await page.context().newCDPSession(page);

        // Chromium on Linux needs explicit layout-resolved text to emulate Finnish Option+7.
        await cdp.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "|",
            code: "Digit7",
            text: "|",
            modifiers: 1,
        });
        await cdp.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "|",
            code: "Digit7",
            modifiers: 1,
        });
        // The PTY must receive the literal pipe once, with no Escape prefix.
        await expect
            .poll(() => inputFrames.filter((frame) => !frame.startsWith("{")))
            .toEqual(["|"]);
        await terminalInput.press("Alt+ArrowLeft");
        // Non-text Alt combinations must still reach terminal applications as navigation.
        await expect.poll(() => inputFrames.at(-1)).toBe("\x1b[1;3D");
    });

    test("stays scrolled to the prompt when typing macOS Option characters", async ({
        page,
    }) => {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "platform", {
                get: () => "MacIntel",
            });
        });
        let terminalOutput = "";
        const inputFrames: string[] = [];
        page.on("websocket", (socket) => {
            if (!isTerminalSocket(socket.url())) {
                return;
            }

            socket.on("framereceived", (event) => {
                terminalOutput += terminalFrameSchema.parse(event.payload);
            });
            socket.on("framesent", (event) => {
                inputFrames.push(terminalFrameSchema.parse(event.payload));
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

        const terminalHost = page
            .getByLabel(`agent1_src 1 for ${ctx.agentName}`)
            .filter({ has: page.locator("textarea") });

        await terminalHost.locator("textarea").focus();
        // Enough output to push the prompt far below where the input was first focused.
        await page.keyboard.type("seq 1 300; echo scroll-''done");
        await page.keyboard.press("Enter");
        await expect.poll(() => terminalOutput).toContain("scroll-done");

        /** Measures how far the shell viewport is from the live prompt at the bottom. */
        const distanceFromBottom = () =>
            terminalHost.evaluate(
                (host) =>
                    host.scrollHeight - host.scrollTop - host.clientHeight,
            );

        // The output must leave the viewport on the prompt before the key is typed.
        await expect.poll(distanceFromBottom).toBeLessThan(5);

        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "|",
            code: "Digit7",
            text: "|",
            modifiers: 1,
        });
        await cdp.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "|",
            code: "Digit7",
            modifiers: 1,
        });
        // The pipe must still reach the PTY as typed text.
        await expect.poll(() => inputFrames.at(-1)).toBe("|");
        // Let the browser finish any caret scroll-into-view from the native text insertion.
        await terminalHost.evaluate(
            () =>
                new Promise<void>((resolve) =>
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => resolve()),
                    ),
                ),
        );
        // Typing must not jump the viewport back into scrollback away from the prompt.
        expect(await distanceFromBottom()).toBeLessThan(5);
    });

    test("expands the terminal to the full window without replacing its session", async ({
        page,
    }) => {
        const terminalSockets: PlaywrightWebSocket[] = [];
        page.on("websocket", (socket) => {
            if (isTerminalSocket(socket.url())) {
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
        const terminalSizes: Array<{ rows: number; cols: number }> = [];
        page.on("websocket", (socket) => {
            if (isTerminalSocket(socket.url())) {
                terminalSockets.push(socket);
                socket.on("framesent", (event) => {
                    const frame = terminalFrameSchema.parse(event.payload);

                    try {
                        const message = terminalResizeFrameSchema.safeParse(
                            JSON.parse(frame),
                        );

                        if (message.success) {
                            terminalSizes.push(message.data.size);
                        }
                    } catch {
                        // Binary shell input is intentionally not a JSON control frame.
                    }
                });
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
        // An agent route must begin without allocating a terminal socket or PTY.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(0);
        // Rendering the empty tab strip must not eagerly open a terminal socket.
        expect(terminalSockets).toHaveLength(0);

        await page
            .getByRole("button", { name: "Choose device for new terminal" })
            .click();
        // The picker must escape the collapsed panel's clipping boundary.
        await expect(
            page.getByRole("dialog", { name: "New terminal" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Close device picker" }).click();

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
        expect(await terminalSocketCwd(terminalSockets[0]?.url() ?? "")).toBe(
            agentDetails.cwd,
        );
        // The caret style belongs to the terminal host, not its equally labeled input textarea.
        await expect(
            page
                .getByLabel(`agent1_src 1 for ${ctx.agentName}`)
                .filter({ has: page.locator("textarea") }),
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
        await expect.poll(() => terminalSizes.length).toBeGreaterThan(0);
        // Hidden drawer measurements must never collapse the remote PTY to one cell.
        expect(terminalSizes).not.toContainEqual({ rows: 1, cols: 1 });

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
        expect(await terminalSocketCwd(terminalSockets[1]?.url() ?? "")).toBe(
            ctx.testDirPath,
        );

        await page.getByRole("tab", { name: "agent1_src 1" }).click();
        await expect(
            page.getByRole("tab", { name: "agent1_src 1" }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(
            page
                .getByLabel(`agent1_src 1 for ${ctx.agentName}`)
                .filter({ has: page.locator("textarea") }),
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
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toBeVisible();
        await page.getByRole("tab", { name: "Terminal" }).click();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 3: Connected" }),
        ).toBeVisible();
        // An open file contributes its parent directory, not the file path.
        expect(terminalSockets).toHaveLength(3);
        expect(await terminalSocketCwd(terminalSockets[2]?.url() ?? "")).toBe(
            ctx.testDirPath,
        );

        const secondSocket = terminalSockets[1];

        if (!secondSocket) {
            throw new Error("second terminal socket was not created");
        }

        const secondSocketClosed = secondSocket.waitForEvent("close");

        const terminalTabs = page.getByRole("tablist", {
            name: "Terminal tabs",
        });

        await dragReorderRow(
            page,
            page.locator(
                '[data-sortable-item][aria-label="Terminal tab agent1_src 3"]',
            ),
            terminalTabs.getByRole("tab", { name: "agent1_src 1" }),
        );
        // Reordering changes only the strip order and retains all three live shell sessions.
        await expect
            .poll(() =>
                terminalTabs
                    .getByRole("tab")
                    .evaluateAll((tabs) =>
                        tabs.map((tab) => tab.getAttribute("aria-label")),
                    ),
            )
            .toEqual(["agent1_src 3", "agent1_src 1", "agent1_src 2"]);
        expect(terminalSockets).toHaveLength(3);
        await page
            .getByRole("tab", { name: "agent1_src 2" })
            .click({ button: "middle" });
        // Middle-click must leave the inactive terminal and the active selection intact.
        await expect(
            page.getByRole("tab", { name: "agent1_src 2" }),
        ).toBeVisible();
        await expect(
            page.getByRole("tab", { name: "agent1_src 3" }),
        ).toHaveAttribute("aria-selected", "true");
        expect(page.context().pages()).toHaveLength(1);
        await page.getByRole("button", { name: "Close agent1_src 2" }).click();
        await secondSocketClosed;
        // The explicit close button must still end the inactive terminal session.
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
        // Closing the active reordered tab selects its nearest surviving neighbor.
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
            .getByRole("button", { name: "Choose device for new terminal" })
            .hover();
        // Application routes advertise that the shortcut opens the required agent choice.
        await expect(
            page.getByRole("tooltip", {
                name: "Choose device for new terminal (t)",
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
            if (isTerminalSocket(socket.url())) {
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
        await expectTerminalFocused(firstTerminal);

        await page.getByRole("tab", { name: "agent1_src 1" }).click();
        await page.keyboard.press("t");
        // A second press reuses the live tab instead of creating another shell.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(1);
        await expectTerminalFocused(firstTerminal);

        await page
            .getByRole("button", { name: "Minimize bottom drawer" })
            .press("Enter");
        // A fully closed drawer hides the shell; focusing it during expansion must still succeed.
        await expect(
            firstTerminal.filter({ has: page.locator("textarea") }),
        ).toBeHidden();
        await page.keyboard.press("t");
        // A collapsed live session is restored instead of opening a duplicate.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(1);
        await expectTerminalFocused(firstTerminal);

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
        await expectTerminalFocused(firstTerminal);

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
        expect(await terminalSocketCwd(terminalSockets[2]?.url() ?? "")).toBe(
            ctx.testDirPath,
        );

        await page.getByRole("tab", { name: "agent1_src 2" }).click();
        await page.keyboard.press("t");
        // A second press in the same directory still reuses that directory's live tab.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(2);
        await expect(
            page.getByRole("tab", { name: "agent1_src 2" }),
        ).toHaveAttribute("aria-selected", "true");
        await expectTerminalFocused(
            page.getByRole("textbox", {
                name: `agent1_src 2 for ${ctx.agentName}`,
            }),
        );
    });

    test("does not invoke single-key shortcuts while the terminal is focused", async ({
        page,
    }) => {
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`;
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

        await expectTerminalFocused(terminalInput);
        // A focused shell must show a blue frame so keyboard ownership is visible.
        await expect(terminalPanel).toHaveCSS(
            "border-color",
            "oklch(0.623 0.214 259.815)",
        );
        await page.keyboard.press("Escape");
        // Escape must stay in the shell so control sequences remain available.
        await expectTerminalFocused(terminalInput);
        await page.keyboard.type("tfdj");
        // Shell input must not create tabs or trigger file-browser character shortcuts.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(1);
        await expectTerminalFocused(terminalInput);
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
        await expectTerminalFocused(terminalInput);
    });

    test("keeps keyboard focus in the terminal after selecting text with the mouse", async ({
        page,
        context,
    }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: WEB_BASE_URL,
        });
        let terminalOutput = "";
        page.on("websocket", (socket) => {
            if (!isTerminalSocket(socket.url())) {
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

        const terminalInput = page.getByRole("textbox", {
            name: `agent1_src 1 for ${ctx.agentName}`,
        });

        const terminalHost = terminalInput.filter({
            has: page.locator("textarea"),
        });

        const terminalPanel = page.getByRole("tabpanel", {
            name: "agent1_src 1",
        });

        await terminalHost.locator("textarea").focus();
        // Octal escapes print the marker without putting it in the echoed command.
        await page.keyboard.type(
            "printf '\\163\\145\\154\\145\\143\\164\\055\\155\\145\\n\\033[?1000h\\033[?1006h'",
        );
        await page.keyboard.press("Enter");
        await expect.poll(() => terminalOutput).toContain("select-me");

        /**
         * Drags across the printed marker the way a user selects text to copy. The shell keeps
         * drawing its prompt after the marker arrives, and a slow or multi-line prompt scrolls
         * the marker row away between measuring it and pressing the mouse, so the whole drag is
         * retried from a fresh measurement until the screen has settled under it.
         */
        const selectMarker = async () => {
            await expect(async () => {
                const box = await terminalHost
                    .getByText("select-me", { exact: true })
                    .first()
                    .boundingBox();

                if (!box) {
                    throw new Error("selected terminal row is not rendered");
                }

                await page.mouse.move(box.x + 1, box.y + box.height / 2);
                await page.keyboard.down("Shift");
                await page.mouse.down();
                await page.mouse.move(
                    box.x + box.width - 1,
                    box.y + box.height / 2,
                    { steps: 5 },
                );
                await page.mouse.up();
                await page.keyboard.up("Shift");
                // The drag must produce a real native selection for the browser's Copy action.
                expect(
                    await page.evaluate(() =>
                        window.getSelection()?.toString(),
                    ),
                ).toContain("select");
            }).toPass({ timeout: 15_000 });
            // Selecting releases wterm's input, but focus must stay on the terminal host.
            await expectTerminalFocused(terminalInput);
        };

        await selectMarker();

        const selectedText = await page.evaluate(() =>
            window.getSelection()?.toString(),
        );

        await page.keyboard.press("Control+Shift+C");
        // Copy must work after Shift-drag releases input focus to the terminal host.
        await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe(selectedText?.trimEnd());
        await terminalHost.click({ button: "right", modifiers: ["Shift"] });
        // Shift-right-click must leave the native copy menu available.
        await expect(
            page.getByRole("dialog", { name: "Terminal actions" }),
        ).toHaveCount(0);
        // The blue frame must remain while the terminal still owns the keyboard.
        await expect(terminalPanel).toHaveCSS(
            "border-color",
            "oklch(0.623 0.214 259.815)",
        );

        await page.evaluate(() => {
            const data = new DataTransfer();
            data.setData(
                "text/plain",
                "printf '\\163\\145\\154\\145\\143\\164\\055\\160\\141\\163\\164\\145\\n'",
            );
            document.activeElement?.dispatchEvent(
                new ClipboardEvent("paste", {
                    bubbles: true,
                    cancelable: true,
                    clipboardData: data,
                }),
            );
        });
        // A paste while the selection is held must not become a file import.
        await expect(
            page.getByRole("dialog", { name: "Save pasted text" }),
        ).toHaveCount(0);
        await page.keyboard.press("Enter");
        // The pasted command must reach the shell, and Enter must follow it into the PTY.
        await expect.poll(() => terminalOutput).toContain("select-paste");

        await selectMarker();
        await page.keyboard.type("echo typed-after-select");
        await page.keyboard.press("Enter");
        // The first key typed over a selection must reach the shell, not be swallowed by the host.
        await expect
            .poll(() => terminalOutput)
            .toContain("echo typed-after-select");
    });

    test("follows the app light theme without dropping the shell", async ({
        page,
    }) => {
        const terminalSockets: PlaywrightWebSocket[] = [];
        page.on("websocket", (socket) => {
            if (isTerminalSocket(socket.url())) {
                terminalSockets.push(socket);
            }
        });
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
        // Dark mode must keep the terminal frame on the app canvas color.
        await expect(surface).toHaveAttribute("data-terminal-theme", "dark");
        await expect(surface).toHaveCSS("background-color", "rgb(11, 13, 18)");

        await page.getByRole("button", { name: "Color theme: Dark" }).click();
        // A live theme toggle must restyle the open terminal instead of leaving a dark hole.
        await expect(surface).toHaveAttribute("data-terminal-theme", "light");
        await expect(surface).toHaveCSS(
            "background-color",
            "rgb(248, 250, 252)",
        );
        // CSS variable updates must keep the existing renderer and PTY socket.
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        expect(terminalSockets).toHaveLength(1);
    });
});
