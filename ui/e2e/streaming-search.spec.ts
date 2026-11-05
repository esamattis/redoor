import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
} from "./helpers";

/**
 * Builds a maze of folders whose paths double with every level, without a cycle, so a search
 * of it keeps finding matches until its deadline. Every level holds `maze-target.txt`.
 */
async function symlinkMaze(parent: string): Promise<string> {
    const maze = path.join(parent, "maze");
    const levels = 40;

    for (let level = 0; level <= levels; level++) {
        const directory = path.join(maze, `level-${level}`);

        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, "maze-target.txt"), "");

        if (level < levels) {
            const next = path.join(maze, `level-${level + 1}`);

            await fs.symlink(next, path.join(directory, "a"));
            await fs.symlink(next, path.join(directory, "b"));
        }
    }

    return path.join(maze, "level-0");
}

test.describe("Streaming search", () => {
    let testDirPath = "";

    test.afterEach(async () => {
        if (testDirPath === "") {
            return;
        }

        await teardownTestDir(testDirPath);
        testDirPath = "";
    });

    test("shows path results while the search is still running", async ({
        page,
    }) => {
        const ctx = await setupTestDir("streaming-search");
        testDirPath = ctx.testDirPath;
        const root = await symlinkMaze(ctx.testDirPath);

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(root)}?q=mazetarget&timeout=60`,
        );

        const dialog = page.getByRole("dialog", { name: "Search device" });

        // The maze cannot be walked within the minute, so any result shown came from a
        // search that has not finished.
        await expect(
            dialog
                .getByRole("link", { name: /^Open path .*maze-target\.txt$/ })
                .first(),
        ).toBeVisible();
        // The status still says the search runs, and how much it found so far.
        await expect(
            dialog.getByRole("status").filter({ hasText: "Searching…" }),
        ).toContainText(/\d+ found/);

        // Closing the dialog abandons the search, which stops it on the device.
        await dialog.getByRole("button", { name: "Close search" }).click();
        await expect(dialog).toBeHidden();
    });
});
