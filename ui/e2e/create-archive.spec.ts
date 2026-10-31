import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { $ } from "zx";
import {
    deleteIsolatedTerminalSessions,
    isolateTerminalSessions,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

/**
 * Lists archive members with the tool matching the extension, so assertions check what was
 * stored and prove the archive is valid for its format. The leading "./" that tar adds is
 * dropped so every format reports the same names.
 */
async function listArchiveEntries(archivePath: string): Promise<string[]> {
    const result = archivePath.endsWith(".zip")
        ? await $`unzip -Z1 ${archivePath}`
        : archivePath.endsWith(".tar.zst")
          ? await $`tar --zstd -tf ${archivePath}`
          : archivePath.endsWith(".tar.xz")
            ? await $`tar -tJf ${archivePath}`
            : await $`tar -tzf ${archivePath}`;

    return result.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.replace(/^\.\//, ""))
        .sort();
}

/** Resolves once the archive exists, since the terminal writes it asynchronously. */
async function waitForFile(filePath: string): Promise<void> {
    await expect
        .poll(() =>
            fs
                .stat(filePath)
                .then(() => true)
                .catch(() => false),
        )
        .toBe(true);
}

test.describe.serial("Create archive", () => {
    let ctx: TestContext;
    let directoryUrl: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("create-archive");
        directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`;
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

    test("archives one row from its action menu", async ({ page }) => {
        await page.goto(directoryUrl);
        await page
            .getByRole("button", {
                name: "Actions for file file1.txt",
                exact: true,
            })
            .click();
        await page.getByRole("button", { name: "Create archive" }).click();

        const dialog = page.getByRole("dialog", { name: "Create archive" });

        // A single item suggests its own name so the archive is easy to recognize.
        await expect(
            dialog.getByRole("textbox", { name: "Archive name" }),
        ).toHaveValue("file1.txt");
        // zstd is listed first and is the default format.
        await expect(
            dialog.getByRole("radio", { name: /\.tar\.zst/ }),
        ).toBeChecked();
        // Every offered format is explained in the dialog.
        await expect(dialog.getByRole("radio")).toHaveCount(4);

        await dialog.getByRole("radio", { name: /\.tar\.gz/ }).check();
        // The resulting file name follows the selected format.
        await expect(dialog).toContainText("Saved as file1.txt.tar.gz");
        await dialog
            .getByRole("button", { name: "Create archive", exact: true })
            .click();

        const archivePath = path.join(ctx.testDirPath, "file1.txt.tar.gz");
        await waitForFile(archivePath);
        // The archive stores the file under its own name rather than its absolute path.
        await expect
            .poll(() => listArchiveEntries(archivePath))
            .toEqual(["file1.txt"]);
        // The listing refreshes after the terminal command so the new archive is visible.
        await expect(
            page.getByRole("link", { name: "file1.txt.tar.gz", exact: true }),
        ).toBeVisible();
    });

    for (const extension of [".tar.zst", ".tar.xz", ".tar.gz", ".zip"]) {
        test(`archives a directory recursively as ${extension}`, async ({
            page,
        }) => {
            await page.goto(directoryUrl);
            await page
                .getByRole("button", { name: "Actions for directory subdir2" })
                .click();
            await page.getByRole("button", { name: "Create archive" }).click();

            const dialog = page.getByRole("dialog", { name: "Create archive" });
            await dialog.getByRole("radio", { name: extension }).check();
            await dialog
                .getByRole("button", { name: "Create archive", exact: true })
                .click();

            const archivePath = path.join(
                ctx.testDirPath,
                `subdir2${extension}`,
            );

            await waitForFile(archivePath);
            // Each format's own tool must read the archive and find the nested tree inside it.
            await expect
                .poll(() => listArchiveEntries(archivePath).catch(() => []))
                .toEqual([
                    "subdir2/",
                    "subdir2/deep/",
                    "subdir2/deep/nested3.txt",
                ]);
        });
    }

    test("extracts a created .tar.zst archive again", async ({ page }) => {
        await page.goto(directoryUrl);
        await page
            .getByRole("button", { name: "Actions for file subdir2.tar.zst" })
            .click();
        // Archives this feature creates must also be offered for extraction.
        await page.getByRole("button", { name: "Unarchive" }).click();

        const dialog = page.getByRole("dialog", { name: "Unarchive" });
        await dialog.getByRole("radio", { name: /Custom directory/ }).check();
        await dialog
            .getByRole("textbox", { name: "Target directory name" })
            .fill("zst-roundtrip");
        await dialog
            .getByRole("button", { name: "Unarchive", exact: true })
            .click();

        // The round trip must restore the nested file with its original contents.
        await expect
            .poll(() =>
                fs
                    .readFile(
                        path.join(
                            ctx.testDirPath,
                            "zst-roundtrip",
                            "subdir2",
                            "deep",
                            "nested3.txt",
                        ),
                        "utf8",
                    )
                    .catch(() => ""),
            )
            .toBe("nested3");
    });

    test("zips selected items from several directories", async ({ page }) => {
        await page.goto(`${directoryUrl}/subdir1`);
        await page
            .getByRole("checkbox", { name: "Select file nested2.txt" })
            .click();
        await page.goto(directoryUrl);
        await page
            .getByRole("checkbox", { name: "Select directory subdir3" })
            .click();
        await page
            .getByRole("button", { name: "Create archive of selected items" })
            .click();

        const dialog = page.getByRole("dialog", { name: "Create archive" });
        await dialog
            .getByRole("textbox", { name: "Archive name" })
            .fill("mixed");
        await dialog.getByRole("radio", { name: /\.zip/ }).check();
        await dialog
            .getByRole("button", { name: "Create archive", exact: true })
            .click();

        const archivePath = path.join(ctx.testDirPath, "mixed.zip");
        await waitForFile(archivePath);
        // zip has no -C, so changing into each parent must still store items side by side.
        await expect
            .poll(() => listArchiveEntries(archivePath).catch(() => []))
            .toEqual(["nested2.txt", "subdir3/"]);
    });

    test("archives selected items into the viewed directory", async ({
        page,
    }) => {
        await page.goto(`${directoryUrl}/subdir1`);
        await page
            .getByRole("checkbox", { name: "Select file nested1.txt" })
            .click();
        await page.goto(directoryUrl);
        await page
            .getByRole("checkbox", {
                name: "Select file file2.txt",
                exact: true,
            })
            .click();

        // Delete is icon-only now but keeps its accessible name.
        await expect(
            page.getByRole("button", { name: "Delete selected items" }),
        ).toBeVisible();

        await page
            .getByRole("button", { name: "Create archive of selected items" })
            .click();

        const dialog = page.getByRole("dialog", { name: "Create archive" });

        // Several items have no shared name, so a generic one is suggested.
        await expect(
            dialog.getByRole("textbox", { name: "Archive name" }),
        ).toHaveValue("archive");
        await dialog.getByRole("radio", { name: /\.tar\.gz/ }).check();
        await dialog
            .getByRole("button", { name: "Create archive", exact: true })
            .click();

        const archivePath = path.join(ctx.testDirPath, "archive.tar.gz");
        await waitForFile(archivePath);
        // Items from different directories are stored side by side under their own names.
        await expect
            .poll(() => listArchiveEntries(archivePath))
            .toEqual(["file2.txt", "nested1.txt"]);
        await expect(
            page.getByRole("link", { name: "archive.tar.gz", exact: true }),
        ).toBeVisible();

        await page
            .getByRole("button", { name: "Create archive of selected items" })
            .click();
        await dialog.getByRole("radio", { name: /\.tar\.gz/ }).check();
        await dialog
            .getByRole("button", { name: "Create archive", exact: true })
            .click();
        // An existing entry is refused because tar would overwrite it silently.
        await expect(dialog.getByRole("alert")).toHaveText(
            "archive.tar.gz already exists in this directory",
        );
    });

    test("disables archiving a selection from multiple devices", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agent2Name}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("checkbox", {
                name: "Select file file1.txt",
                exact: true,
            })
            .click();
        await page.goto(directoryUrl);
        await page
            .getByRole("checkbox", {
                name: "Select file file2.txt",
                exact: true,
            })
            .click();

        const archiveButton = page.getByRole("button", {
            name: "Create archive of selected items",
        });

        // One terminal cannot read files from two devices.
        await expect(archiveButton).toBeDisabled();
        await archiveButton.hover();
        // The tooltip explains why the action is unavailable.
        await expect(page.getByRole("tooltip")).toHaveText(
            "Archives cannot be created when items are selected from multiple devices",
        );
    });
});
