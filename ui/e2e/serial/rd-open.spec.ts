// Serial: `rd-open` is broadcast to every browser window, so it would navigate the pages of
// specs running in parallel, and its terminal sessions outlive pages, so another spec's
// pages would restore them as tabs.
import path from "node:path";
import { expect, test, type Page } from "../fixtures";
import {
    deleteAllTerminalSessions,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "../helpers";

test.describe.serial("rd-open", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("rd-open");
        await deleteAllTerminalSessions();
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.afterEach(async () => {
        // Sessions outlive the page; the next test must not restore this test's shells.
        await deleteAllTerminalSessions();
    });

    /** Opens a new terminal on the test device and returns its input, ready for commands. */
    async function openTerminal(page: Page) {
        await page.getByRole("tab", { name: "Terminal" }).click();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();

        return page
            .getByLabel(`agent1_src 1 for ${ctx.agentName}`)
            .locator("textarea");
    }

    test("opens files and directories from the terminal in the focused window", async ({
        page,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        const terminalInput = await openTerminal(page);

        await terminalInput.pressSequentially(
            `cd '${ctx.testDirPath}' && rd-open file1.txt`,
        );
        await terminalInput.press("Enter");
        // The focused window opens the file in its editor at once.
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toContainText("content1");
        // The terminal stays open in the drawer, so the next command can follow.
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();

        await terminalInput.pressSequentially("rd-open subdir1");
        await terminalInput.press("Enter");
        // A directory opens in the file browser.
        await expect(
            page.getByRole("link", { name: "nested1.txt", exact: true }),
        ).toBeVisible();
        expect(decodeURIComponent(new URL(page.url()).pathname)).toBe(
            `/agents/${ctx.agentName}/browser${path.join(ctx.testDirPath, "subdir1")}`,
        );
    });

    test("offers to open the path in windows without focus", async ({
        page,
        context,
    }) => {
        await page.goto(ctx.agentBrowserUrl);
        const terminalInput = await openTerminal(page);
        const other = await context.newPage();
        await other.goto(ctx.agentBrowserUrl);
        await expect(
            other.getByRole("link", { name: ctx.testDirName, exact: true }),
        ).toBeVisible();
        // Headless pages all report focus, so this one plays the window in the background.
        await other.evaluate(() => {
            document.hasFocus = () => false;
        });

        await terminalInput.pressSequentially(
            `rd-open '${path.join(ctx.testDirPath, "file2.txt")}'`,
        );
        await terminalInput.press("Enter");

        const offer = other
            .getByRole("status")
            .filter({ hasText: "file2.txt" });

        // The background window asks first instead of leaving what is on screen.
        await expect(offer).toContainText(
            `Open ${path.join(ctx.testDirPath, "file2.txt")} on ${ctx.agentName}?`,
        );
        await expect(
            other.getByLabel("File editor", { exact: true }),
        ).toHaveCount(0);

        await offer.getByRole("button", { name: "Open", exact: true }).click();
        // Accepting the offer opens the file like the focused window did.
        await expect(
            other.getByLabel("File editor", { exact: true }),
        ).toContainText("content2");
        await expect(offer).toHaveCount(0);
    });
});
