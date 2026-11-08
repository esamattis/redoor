// Parallel: these tests only write the editor buffers of their own uniquely named files. The
// edits also add the files to the shared open files list, which no parallel spec asserts on.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, signedInStorageState, test } from "./fixtures";

import { ApiClient } from "#ui/api-client";
import { parseStoredBuffer } from "#ui/editor/stored-buffer";
import {
    API_BASE_URL,
    WEB_BASE_URL,
    encodeFilesystemPath,
    simulateTabRefocus,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

test.describe.serial("Unsaved editor buffers", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("editor-buffers");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    /** Reads the document text the server stores for the file's unsaved buffer. */
    async function storedDocument(filePath: string) {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");

        const stored = parseStoredBuffer(
            await api.getEditorBuffer(`${ctx.agentId}:${filePath}`),
        );

        return stored === null ? null : String(stored.data.state.doc);
    }

    /** Writes a tall file, so restoring the caret line is observable. */
    async function writeTallFile(name: string, prefix: string) {
        const filePath = path.join(ctx.testDirPath, name);

        await fs.writeFile(
            filePath,
            Array.from(
                { length: 300 },
                (_, index) => `${prefix} line ${index + 1}`,
            ).join("\n"),
        );

        return filePath;
    }

    test("keeps unsaved edits with their undo history across a reload and on another computer", async ({
        page,
        browser,
        playwright,
    }) => {
        const filePath = await writeTallFile(
            "buffer-survives-reload.txt",
            "gamma",
        );

        const fileUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`;
        const editor = page.getByLabel("File editor", { exact: true });

        await page.goto(fileUrl);
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" unsaved");
        // The debounced write reaches the server before the page goes away.
        await expect
            .poll(() => storedDocument(filePath))
            .toContain("gamma line 300 unsaved");

        await page.reload();
        // The unsaved text survives the reload.
        await expect(editor).toContainText("gamma line 300 unsaved");
        // It is still unsaved, so it can be saved or undone.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();
        // The caret came back on the edited line.
        await expect(page.getByLabel("Editor caret line")).toHaveText("300");

        // Another computer signs in on its own, as a real one would.
        const other = await browser.newContext({
            storageState: await signedInStorageState(playwright.request),
        });

        const otherPage = await other.newPage();
        await otherPage.goto(fileUrl);
        // Another computer continues with the same unsaved buffer.
        await expect(
            otherPage.getByLabel("File editor", { exact: true }),
        ).toContainText("gamma line 300 unsaved");
        // The caret follows, so the user picks up exactly where they left off.
        await expect(otherPage.getByLabel("Editor caret line")).toHaveText(
            "300",
        );
        await other.close();

        await editor.focus();
        await page.keyboard.press("ControlOrMeta+z");
        // The undo history survived the reload too.
        await expect(editor).not.toContainText("unsaved");
        // Undoing to the device text leaves nothing to save.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeDisabled();
        // The device file was never written.
        expect(await fs.readFile(filePath, "utf8")).not.toContain("unsaved");
    });

    test("dismisses the device change warning when the user keeps their edits", async ({
        page,
    }) => {
        const filePath = path.join(
            ctx.testDirPath,
            "buffer-kept-over-device-change.txt",
        );

        await fs.writeFile(filePath, "device original");
        const fileUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`;
        const editor = page.getByLabel("File editor", { exact: true });

        const banner = page.getByRole("alert", {
            name: "File changed on device",
        });

        await page.goto(fileUrl);
        await expect(editor).toHaveText("device original");
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" browser");
        // The edit's own write lands first, so the write awaited below is the kept decision.
        await expect
            .poll(() => storedDocument(filePath))
            .toBe("device original browser");

        await fs.writeFile(filePath, "device rewrote this");
        await simulateTabRefocus(page);
        await expect(banner).toBeVisible();

        const keptPersisted = page.waitForResponse(
            (response) =>
                response.request().method() === "PUT" &&
                response.url().includes("/api/v1/user/editor-buffers/"),
        );

        await banner.getByRole("button", { name: "Keep my changes" }).click();
        // Keeping dismisses the warning while the browser edits stay unsaved.
        await expect(banner).toBeHidden();
        await expect(editor).toHaveText("device original browser");
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeEnabled();

        // Reloading before the write lands would read the old base and warn again.
        await keptPersisted;
        await page.reload();
        // The decision is stored with the buffer, so a reload does not bring the warning back.
        await expect(editor).toHaveText("device original browser");
        await expect(banner).toBeHidden();
    });

    test("keeps unsaved edits over a device change until the user discards them", async ({
        page,
    }) => {
        const filePath = path.join(
            ctx.testDirPath,
            "buffer-discarded-for-device-change.txt",
        );

        await fs.writeFile(filePath, "device original");
        const fileUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`;
        const editor = page.getByLabel("File editor", { exact: true });

        const banner = page.getByRole("alert", {
            name: "File changed on device",
        });

        await page.goto(fileUrl);
        await expect(editor).toHaveText("device original");
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(" browser");
        await expect
            .poll(() => storedDocument(filePath))
            .toBe("device original browser");

        await fs.writeFile(filePath, "device rewrote this");
        await simulateTabRefocus(page);
        // The device change is reported while the browser edits stay on screen.
        await expect(banner).toBeVisible();
        await expect(editor).toHaveText("device original browser");

        await page.reload();
        // After a reload the stored buffer still wins and the warning comes back.
        await expect(editor).toHaveText("device original browser");
        await expect(banner).toBeVisible();

        await banner
            .getByRole("button", { name: "Discard my changes" })
            .click();
        // Discarding loads the device version and leaves nothing unsaved.
        await expect(editor).toHaveText("device rewrote this");
        await expect(banner).toBeHidden();
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toBeDisabled();
        // The discarded buffer is written back, so another reload shows the device text.
        await expect
            .poll(() => storedDocument(filePath))
            .toBe("device rewrote this");
    });
});
