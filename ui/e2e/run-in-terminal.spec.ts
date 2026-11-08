import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";
import { z } from "zod";
import {
    deleteIsolatedTerminalSessions,
    deviceBrowserUrl,
    isolateTerminalSessions,
    isTerminalSocket,
    setupTestDir,
    teardownTestDir,
    terminalSocketCwd,
    type TestContext,
} from "./helpers";

/** Terminal input travels as binary frames and control messages as text; both read as text. */
const terminalFrameSchema = z.union([
    z.string(),
    z.instanceof(Buffer).transform((payload) => payload.toString("utf8")),
]);

test.describe.serial("Run in terminal", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("run-in-terminal");
        // The script records where it ran, which proves both the run and the directory.
        const script = path.join(ctx.testDirPath, "my script.sh");
        await fs.writeFile(script, "#!/bin/sh\npwd > ran-from.txt\n");
        await fs.chmod(script, 0o755);
        const plain = path.join(ctx.testDirPath, "plain.sh");
        await fs.writeFile(plain, "#!/bin/sh\necho plain\n");
        await fs.chmod(plain, 0o644);
        // Bytes that are not text open in the detail view instead of the editor.
        const binary = path.join(ctx.testDirPath, "tool.bin");
        await fs.writeFile(binary, Buffer.from([0, 1, 2, 3, 0, 255, 0]));
        await fs.chmod(binary, 0o755);
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

    /** Opens one file of the test directory in the browser. */
    function fileUrl(name: string) {
        return deviceBrowserUrl(
            ctx.agentName,
            path.join(ctx.testDirPath, name),
        );
    }

    test("runs an executable script in a new terminal in its directory", async ({
        page,
    }) => {
        const terminalUrls: string[] = [];
        const sentInput: string[] = [];
        page.on("websocket", (socket) => {
            if (!isTerminalSocket(socket.url())) return;
            terminalUrls.push(socket.url());
            socket.on("framesent", (event) => {
                sentInput.push(terminalFrameSchema.parse(event.payload));
            });
        });

        await page.goto(fileUrl("my script.sh"));
        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toContainText("pwd > ran-from.txt");

        const runButton = page.getByRole("button", { name: "Run in terminal" });
        // An executable script offers running it from the editor toolbar.
        await expect(runButton).toBeEnabled();
        await runButton.click();

        await expect(
            page.getByRole("status", { name: `${ctx.agentName} 1: Connected` }),
        ).toBeVisible();
        // The script writes its working directory, so the file proves it ran there.
        await expect
            .poll(async () =>
                fs
                    .readFile(
                        path.join(ctx.testDirPath, "ran-from.txt"),
                        "utf8",
                    )
                    .catch(() => ""),
            )
            .toBe(`${ctx.testDirPath}\n`);
        // The terminal opens in the file's directory, so the relative command finds the file.
        expect(await terminalSocketCwd(terminalUrls[0] ?? "")).toBe(
            ctx.testDirPath,
        );
        // The name is quoted, so the space does not split it into two words.
        expect(sentInput.join("")).toContain("./'my script.sh'\r");
    });

    test("does not run a script with unsaved edits", async ({ page }) => {
        await page.goto(fileUrl("my script.sh"));
        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toContainText("pwd > ran-from.txt");
        await editor.click();
        await page.keyboard.type("# unsaved");

        // The terminal would run the device's copy, which lacks the edits, so running waits for a save.
        await expect(
            page.getByRole("button", { name: "Run in terminal" }),
        ).toBeDisabled();
    });

    test("offers running only files the user may execute", async ({ page }) => {
        await page.goto(fileUrl("plain.sh"));
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toContainText("echo plain");
        // Without an execute bit the shell would refuse, so the action is not offered.
        await expect(
            page.getByRole("button", { name: "Run in terminal" }),
        ).toHaveCount(0);

        await page.goto(fileUrl("tool.bin"));
        // Binaries open in the detail view, which offers running them too.
        await expect(
            page.getByRole("button", { name: "Run in terminal" }),
        ).toBeVisible();

        await page.goto(`${fileUrl("my script.sh")}?view=details`);
        await expect(
            page.getByRole("heading", { name: "Shareable links" }),
        ).toBeVisible();
        // A script's Details tab cannot see unsaved editor edits, so only the editor offers running it.
        await expect(
            page.getByRole("button", { name: "Run in terminal" }),
        ).toHaveCount(0);
    });
});
