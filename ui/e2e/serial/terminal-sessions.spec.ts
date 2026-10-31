// Serial: terminal sessions outlive pages and every page restores them as tabs, so another
// spec's pages would show (and could take over) the shells these tests open.
import { expect, test, type Page } from "@playwright/test";
import {
    deleteAllTerminalSessions,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "../helpers";

/**
 * A command that prints `__<word><pid>__` without that text appearing in the echoed
 * command, so the marker is only on screen once the shell ran it.
 */
function printPid(word: string): string {
    return `printf '\\137\\137${word}%s\\137\\137\\n' $$`;
}

test.describe.serial("Persistent terminal sessions", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("terminal-sessions");
        await deleteAllTerminalSessions();
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.afterEach(async () => {
        // Sessions outlive the page; the next test must not restore this test's shells.
        await deleteAllTerminalSessions();
    });

    /** The rendered terminal of a tab, whose text is the screen the user sees. */
    function terminalScreen(page: Page, title: string) {
        return page
            .getByLabel(`${title} for ${ctx.agentName}`)
            .filter({ has: page.locator("textarea") });
    }

    /** Types a command into a tab's shell. */
    async function runInTerminal(page: Page, title: string, command: string) {
        const input = terminalScreen(page, title).locator("textarea");
        await input.focus();
        await input.pressSequentially(command);
        await input.press("Enter");
    }

    /** Reads the shell pid a tab printed with `printPid(word)`. */
    async function printedPid(
        page: Page,
        title: string,
        word: string,
    ): Promise<string> {
        const screen = terminalScreen(page, title);
        const marker = new RegExp(`__${word}(\\d+)__`);
        await expect(screen).toContainText(marker);

        return (await screen.innerText()).match(marker)?.[1] ?? "";
    }

    test("restores a terminal with its screen and shell after a reload", async ({
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
        // Octal escapes print the marker without it appearing in the echoed command.
        await runInTerminal(
            page,
            "agent1_src 1",
            `${printPid("BEFORE")}; printf '\\162\\145\\154\\157\\141\\144\\055\\155\\141\\162\\153\\n'`,
        );
        await expect(terminalScreen(page, "agent1_src 1")).toContainText(
            "reload-mark",
        );
        const pid = await printedPid(page, "agent1_src 1", "BEFORE");

        await page.reload();
        await page.getByRole("tab", { name: "Terminal" }).click();
        // The tab comes back by itself and attaches to the same server session.
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        // The server replays the screen, so the output from before the reload is visible.
        await expect(terminalScreen(page, "agent1_src 1")).toContainText(
            "reload-mark",
        );
        await runInTerminal(page, "agent1_src 1", printPid("AFTER"));
        // It is the same shell process, not a new one.
        expect(await printedPid(page, "agent1_src 1", "AFTER")).toBe(pid);
    });

    test("hands a terminal between windows only when asked", async ({
        page,
        context,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page.getByRole("tab", { name: "Terminal" }).click();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();

        const other = await context.newPage();
        await other.goto(ctx.agentBrowserUrl);
        await other.getByRole("tab", { name: "Terminal" }).click();
        // Showing the restored tab in the second window attaches it there.
        await expect(
            other.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        // The first window keeps the last screen but tells the user where the shell went.
        await expect(
            page.getByRole("status", {
                name: "agent1_src 1: Open in another window",
            }),
        ).toBeVisible();

        await runInTerminal(other, "agent1_src 1", printPid("OTHER"));
        await printedPid(other, "agent1_src 1", "OTHER");
        // After a full round trip in the second window, the first has not taken the
        // session back by itself.
        await expect(
            page.getByRole("status", {
                name: "agent1_src 1: Open in another window",
            }),
        ).toBeVisible();
        await expect(
            other.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();

        await page.getByRole("button", { name: "Take over" }).click();
        // Taking over brings the session back and lets the other window know.
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        await expect(
            other.getByRole("status", {
                name: "agent1_src 1: Open in another window",
            }),
        ).toBeVisible();
        await other.close();
    });

    test("shows the last screen and exit status of an exited terminal after a reload", async ({
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
        await runInTerminal(
            page,
            "agent1_src 1",
            "printf '\\145\\170\\151\\164\\055\\155\\141\\162\\153\\n'; exit 4",
        );
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Disconnected" }),
        ).toBeVisible();

        await page.reload();
        await page.getByRole("tab", { name: "Terminal" }).click();
        // The exited shell's tab is restored with why it ended.
        await expect(page.getByRole("alert")).toContainText(
            "Shell exited with code 4",
        );
        // And with the screen it left behind.
        await expect(terminalScreen(page, "agent1_src 1")).toContainText(
            "exit-mark",
        );
        await expect(
            page.getByRole("button", { name: "Restart agent1_src 1" }),
        ).toBeVisible();
    });

    test("closing a terminal removes its tab from other windows", async ({
        page,
        context,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        await page.getByRole("tab", { name: "Terminal" }).click();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();

        const other = await context.newPage();
        await other.goto(ctx.agentBrowserUrl);
        await other.getByRole("tab", { name: "Terminal" }).click();
        await expect(
            other.getByRole("tab", { name: "agent1_src 1" }),
        ).toBeVisible();

        await other.getByRole("button", { name: "Close agent1_src 1" }).click();
        // The server announces the closed session, so the first window drops the tab too.
        await expect(
            page.getByRole("tab", { name: /^agent1_src / }),
        ).toHaveCount(0);
        await other.close();
    });
});
