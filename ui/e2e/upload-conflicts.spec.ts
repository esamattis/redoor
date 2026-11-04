import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
    confirmUpload,
    uploadDialog,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

/** Reads a file the background upload queue may not have written yet. */
async function readWhenPresent(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, "utf8");
    } catch {
        return null;
    }
}

/** Reports whether an entry exists, so polling can wait for a removal. */
async function exists(entryPath: string): Promise<boolean> {
    try {
        await fs.lstat(entryPath);

        return true;
    } catch {
        return false;
    }
}

/** Exercises the macOS trash UI contract without leaving test fixtures in native Trash. */
async function interceptMacosTrashMove(
    page: Page,
    sourcePath: string,
): Promise<void> {
    if (process.platform !== "darwin") {
        return;
    }

    await page.route("**/raw/**?trash=true", async (route) => {
        await fs.rm(sourcePath, { force: true, recursive: true });
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ path: sourcePath }),
        });
    });
}

test.describe.serial("Upload conflicts", () => {
    let ctx: TestContext;
    // Local sources live until the end, because the browser reads picked files lazily.
    let sourceRoot: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("upload-conflicts");
        sourceRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "redoor-upload-conflict-"),
        );
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
        await fs.rm(sourceRoot, { force: true, recursive: true });
    });

    /** Creates a fresh destination holding one existing file and opens it. */
    async function openDestinationWithFile(
        page: Page,
        directoryName: string,
    ): Promise<string> {
        const directoryPath = path.join(ctx.testDirPath, directoryName);
        await fs.mkdir(directoryPath);
        await fs.writeFile(path.join(directoryPath, "notes.txt"), "existing");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(directoryPath)}`,
        );

        return directoryPath;
    }

    /**
     * Creates a destination with a `photos` directory and a local `photos` directory that
     * shares one file with it, then picks the local one for upload.
     */
    async function uploadConflictingDirectory(
        page: Page,
        directoryName: string,
    ): Promise<string> {
        const directoryPath = path.join(ctx.testDirPath, directoryName);
        const existingPhotos = path.join(directoryPath, "photos");
        await fs.mkdir(existingPhotos, { recursive: true });
        await fs.writeFile(path.join(existingPhotos, "a.txt"), "old a");
        await fs.writeFile(path.join(existingPhotos, "keep.txt"), "kept");

        const sourcePhotos = path.join(sourceRoot, directoryName, "photos");
        await fs.mkdir(sourcePhotos, { recursive: true });
        await fs.writeFile(path.join(sourcePhotos, "a.txt"), "new a");
        await fs.writeFile(path.join(sourcePhotos, "b.txt"), "new b");

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(directoryPath)}`,
        );
        await page
            .getByLabel("Choose directory to upload")
            .setInputFiles(sourcePhotos);

        return directoryPath;
    }

    test("should upload an existing file under a new name", async ({
        page,
    }) => {
        const directoryPath = await openDestinationWithFile(
            page,
            "rename-file",
        );

        await page.getByLabel("Choose files to upload").setInputFiles({
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("uploaded"),
        });

        const dialog = uploadDialog(page);

        const resolution = dialog.getByRole("combobox", {
            name: "If notes.txt exists",
        });

        const newName = dialog.getByRole("textbox", {
            name: "Name for notes.txt",
        });

        // An upload must stop and ask before it would write over an existing file.
        await expect(resolution).toBeVisible();
        // Renaming keeps the existing file, so it is the safe default like for Copy and Move.
        await expect(resolution).toHaveValue("rename");
        // Rename starts from a free name, so confirming right away cannot fail.
        await expect(newName).toHaveValue("notes_2.txt");
        // A file has nothing to merge into, so Merge would only duplicate Replace.
        await expect(
            resolution.getByRole("option", {
                name: "Merge directories and replace files",
            }),
        ).toHaveCount(0);

        await newName.fill("notes-uploaded.txt");
        await confirmUpload(page, 1);

        // The upload lands under the chosen name.
        await expect
            .poll(() =>
                readWhenPresent(path.join(directoryPath, "notes-uploaded.txt")),
            )
            .toBe("uploaded");
        // Rename must leave the existing file untouched.
        await expect(
            fs.readFile(path.join(directoryPath, "notes.txt"), "utf8"),
        ).resolves.toBe("existing");
    });

    test("should replace an existing file when chosen", async ({ page }) => {
        const directoryPath = await openDestinationWithFile(
            page,
            "replace-file",
        );

        await page.getByLabel("Choose files to upload").setInputFiles({
            name: "notes.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("uploaded"),
        });

        await uploadDialog(page)
            .getByRole("combobox", { name: "If notes.txt exists" })
            .selectOption("override");

        const uploadRequest = page.waitForRequest(
            (request) =>
                request.method() === "PUT" && request.url().includes("/raw/"),
        );

        await confirmUpload(page, 1);

        // The server no longer replaces by default, so the choice must be sent explicitly.
        expect(
            new URL((await uploadRequest).url()).searchParams.get(
                "on_existing",
            ),
        ).toBe("override");
        // Replace writes the upload over the existing file.
        await expect
            .poll(() => readWhenPresent(path.join(directoryPath, "notes.txt")))
            .toBe("uploaded");
    });

    test("should merge an uploaded directory into an existing one", async ({
        page,
    }) => {
        const directoryPath = await uploadConflictingDirectory(
            page,
            "merge-directory",
        );

        // Merge is offered because a directory lands on a directory.
        await uploadDialog(page)
            .getByRole("combobox", { name: "If photos exists" })
            .selectOption("merge");
        await confirmUpload(page, 1);

        const photos = path.join(directoryPath, "photos");

        // Merge must replace files present on both sides.
        await expect
            .poll(() => readWhenPresent(path.join(photos, "a.txt")))
            .toBe("new a");
        // Merge must add files only the upload has.
        await expect
            .poll(() => readWhenPresent(path.join(photos, "b.txt")))
            .toBe("new b");
        // Merge must keep files only the destination has.
        await expect(
            fs.readFile(path.join(photos, "keep.txt"), "utf8"),
        ).resolves.toBe("kept");
    });

    test("should replace an existing directory with the uploaded one", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "replace-directory");
        const photos = path.join(directoryPath, "photos");
        await interceptMacosTrashMove(page, photos);
        await uploadConflictingDirectory(page, "replace-directory");

        await uploadDialog(page)
            .getByRole("combobox", { name: "If photos exists" })
            .selectOption("override");
        await confirmUpload(page, 1);

        await expect
            .poll(() => readWhenPresent(path.join(photos, "b.txt")))
            .toBe("new b");
        // Replace must leave only the uploaded tree, unlike Merge.
        await expect
            .poll(() => exists(path.join(photos, "keep.txt")))
            .toBe(false);
        // Queue workers finish independently, so b.txt does not imply a.txt is written yet.
        await expect
            .poll(() => readWhenPresent(path.join(photos, "a.txt")))
            .toBe("new a");
    });
});
