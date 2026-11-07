// Serial: reads and writes the system clipboard, which is shared across browser contexts.
import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
    deleteAllTerminalSessions,
    isTerminalSocket,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "../helpers";

const terminalFrameSchema = z.union([
    z.string(),
    z.instanceof(Buffer).transform((payload) => payload.toString("utf8")),
]);

test.describe("Terminal clipboard", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("terminal-clipboard");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.afterEach(async () => {
        // Sessions outlive the page; the next test must not restore this test's shells.
        await deleteAllTerminalSessions();
    });

    test("copies and pastes from the terminal context menu", async ({
        page,
        context,
    }) => {
        let terminalOutput = "";
        page.on("websocket", (socket) => {
            if (!isTerminalSocket(socket.url())) {
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

        const terminalHost = page
            .getByLabel(`agent1_src 1 for ${ctx.agentName}`)
            .filter({ has: page.locator("textarea") });

        const terminalInput = terminalHost.locator("textarea");
        await terminalHost.click({ button: "right" });
        const actions = page.getByRole("dialog", { name: "Terminal actions" });
        // A terminal right-click must replace the browser context menu.
        await expect(actions).toBeVisible();
        // Copy stays unavailable until the terminal has a scoped DOM selection.
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

        await terminalHost.evaluate((host) => {
            const selection = window.getSelection();

            if (!selection) {
                throw new Error("browser selection is unavailable");
            }

            const range = document.createRange();
            range.selectNodeContents(host);
            selection.removeAllRanges();
            selection.addRange(range);
        });
        await terminalHost.dispatchEvent("contextmenu", {
            clientX: 12,
            clientY: 12,
        });
        await expect(actions).toBeVisible();
        const copyButton = actions.getByRole("button", { name: "Copy" });
        // Native DOM selection inside the host must be available to the copy action.
        await expect(copyButton).toBeEnabled();
        await copyButton.hover();
        // Copy guidance makes the terminal's platform shortcuts discoverable.
        await expect(page.getByRole("tooltip")).toContainText("Ctrl+Shift+C");
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
        await terminalHost.click({
            button: "right",
            position: { x: 12, y: 12 },
        });
        await actions.getByRole("button", { name: "Paste" }).click();
        // The async clipboard read closes the menu only after text reaches wterm input.
        await expect(actions).toHaveCount(0);
        await terminalInput.press("Enter");
        // Paste must reach the PTY as input rather than staying in the browser.
        await expect.poll(() => terminalOutput).toContain("paste-ok");

        const applicationText = "Claude copy: ä ✓";
        const encoded = Buffer.from(applicationText).toString("base64");
        await terminalInput.pressSequentially(
            `printf '\\033]52;c;${encoded}\\007'`,
        );
        await terminalInput.press("Enter");
        // Claude Code sends OSC 52, which must reach the real clipboard with UTF-8 intact.
        await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe(applicationText);

        await page.evaluate(() => {
            const writeText = navigator.clipboard.writeText.bind(
                navigator.clipboard,
            );

            navigator.clipboard.writeText = async () => {
                navigator.clipboard.writeText = writeText;
                throw new DOMException(
                    "A user gesture is required",
                    "NotAllowedError",
                );
            };
        });
        await terminalInput.pressSequentially(
            `printf '\\033]52;c;${Buffer.from("retry copy").toString("base64")}\\007'`,
        );
        await terminalInput.press("Enter");
        await page.getByRole("button", { name: "Copy requested text" }).click();
        // A denied automatic write remains available to copy from a browser user gesture.
        await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe("retry copy");
    });

    test("searches selected terminal text from the browsed directory", async ({
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

        const terminalHost = page
            .getByLabel(`agent1_src 1 for ${ctx.agentName}`)
            .filter({ has: page.locator("textarea") });

        const terminalInput = terminalHost.locator("textarea");
        await terminalInput.focus();
        // Octal escapes print the marker without putting it in the echoed command.
        await terminalInput.pressSequentially(
            "printf '\\164\\145\\162\\155\\055\\163\\145\\141\\162\\143\\150\\n'",
        );
        await terminalInput.press("Enter");

        // Selects only the printed marker, since a search query must be a single line.
        await expect(async () => {
            await terminalHost.evaluate((host, marker) => {
                const walker = document.createTreeWalker(
                    host,
                    NodeFilter.SHOW_TEXT,
                );

                for (
                    let node = walker.nextNode();
                    node !== null;
                    node = walker.nextNode()
                ) {
                    const start = node.textContent?.indexOf(marker) ?? -1;

                    if (start === -1) {
                        continue;
                    }

                    const range = document.createRange();
                    range.setStart(node, start);
                    range.setEnd(node, start + marker.length);
                    const selection = window.getSelection();

                    if (!selection) {
                        throw new Error("browser selection is unavailable");
                    }

                    selection.removeAllRanges();
                    selection.addRange(range);

                    return;
                }

                throw new Error("the marker is not rendered yet");
            }, "term-search");
        }).toPass();

        await terminalHost.dispatchEvent("contextmenu", {
            clientX: 12,
            clientY: 12,
        });

        const actions = page.getByRole("dialog", { name: "Terminal actions" });

        const searchItem = actions.getByRole("button", {
            name: "Search in files",
            exact: true,
        });

        // A single-line selection on the terminal's own device can be searched.
        await expect(searchItem).toBeEnabled();
        await searchItem.click();

        // The page's search dialog opens with the selection as a content search.
        await expect(
            page
                .getByRole("dialog", { name: "Search device" })
                .getByRole("searchbox", { name: "Search file contents" }),
        ).toHaveValue("term-search");
        await expect(page).toHaveURL(/[?&]mode=content/);
        // The search starts from the browsed directory, not a Git root.
        await expect(page).not.toHaveURL(/[?&]gitroot=/);
    });
});
