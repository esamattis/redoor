import { expect, test, type Page } from "./fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import {
    confirmUpload,
    encodeFilesystemPath,
    setupTestDir,
    simulateTabRefocus,
    teardownTestDir,
    type TestContext,
    uploadDialog,
    WEB_BASE_URL,
} from "./helpers";

/** Pastes text into the page the way the browser does when nothing editable is focused. */
async function pasteText(page: Page, text: string): Promise<void> {
    await page.evaluate((value) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", value);
        window.dispatchEvent(
            new ClipboardEvent("paste", { bubbles: true, clipboardData }),
        );
    }, text);
}

/** Drops one file on the page; synthetic drops expose plain files without entries. */
async function dropFile(
    page: Page,
    name: string,
    content: string,
): Promise<void> {
    await page.evaluate(
        (file) => {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(new File([file.content], file.name));
            window.dispatchEvent(
                new DragEvent("drop", {
                    bubbles: true,
                    cancelable: true,
                    dataTransfer,
                }),
            );
        },
        { name, content },
    );
}

/** Reads a file the background upload queue may not have written yet. */
async function readWhenPresent(filePath: string): Promise<string | null> {
    return fs.readFile(filePath, "utf8").catch(() => null);
}

test.describe("Upload dialog", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("upload-dialog");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("collects pastes, drops and picks into one upload", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "collect");
        await fs.mkdir(directoryPath);
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(directoryPath)}`,
        );
        await expect(
            page.getByRole("button", { name: "Paste files or text" }),
        ).toBeVisible();

        await pasteText(page, "first paste");

        const dialog = uploadDialog(page);
        const items = dialog.getByRole("list", { name: "Items to upload" });
        // A paste opens the dialog instead of uploading straight away.
        await expect(items.getByRole("listitem")).toHaveCount(1);

        // Pasting again while the dialog is open adds to the same upload.
        await pasteText(page, "second paste");
        await expect(items.getByRole("listitem")).toHaveCount(2);

        const nameFields = items.getByRole("textbox", {
            name: "Name for pasted-text.txt",
        });

        // Both pastes have the same made-up name, so the later one gets a free variant.
        await expect(nameFields.nth(0)).toHaveValue("pasted-text.txt");
        await expect(nameFields.nth(1)).toHaveValue("pasted-text_2.txt");

        await dropFile(page, "dropped.txt", "dropped content");
        // A drop on the open dialog joins the upload too.
        await expect(
            items.getByRole("textbox", { name: "Name for dropped.txt" }),
        ).toHaveValue("dropped.txt");

        await dialog.getByLabel("Add files to upload").setInputFiles({
            name: "picked.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("picked content"),
        });
        // The dialog's own picker adds rows, which is how phones add more without dropping.
        await expect(items.getByRole("listitem")).toHaveCount(4);

        await items
            .getByRole("button", { name: "Remove pasted-text.txt from upload" })
            .first()
            .click();
        await expect(items.getByRole("listitem")).toHaveCount(3);
        // Removing the first paste frees its name for the second one.
        await expect(nameFields).toHaveValue("pasted-text.txt");

        await nameFields.fill("second.txt");
        await confirmUpload(page, 3);

        // Every remaining item lands under its chosen name.
        await expect
            .poll(() => readWhenPresent(path.join(directoryPath, "second.txt")))
            .toBe("second paste");
        await expect
            .poll(() =>
                readWhenPresent(path.join(directoryPath, "dropped.txt")),
            )
            .toBe("dropped content");
        await expect
            .poll(() => readWhenPresent(path.join(directoryPath, "picked.txt")))
            .toBe("picked content");
        // The removed paste is not uploaded under its suggested name.
        expect(
            await readWhenPresent(path.join(directoryPath, "pasted-text.txt")),
        ).toBeNull();
    });

    test("resolves every existing item with one choice", async ({ page }) => {
        const directoryPath = path.join(ctx.testDirPath, "bulk");
        await fs.mkdir(directoryPath);
        await fs.writeFile(path.join(directoryPath, "a.txt"), "old a");
        await fs.writeFile(path.join(directoryPath, "b.txt"), "old b");
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(directoryPath)}`,
        );

        await page.getByLabel("Choose files to upload").setInputFiles([
            {
                name: "a.txt",
                mimeType: "text/plain",
                buffer: Buffer.from("new a"),
            },
            {
                name: "b.txt",
                mimeType: "text/plain",
                buffer: Buffer.from("new b"),
            },
        ]);

        const dialog = uploadDialog(page);

        await dialog
            .getByRole("combobox", { name: "For every existing item" })
            .selectOption("override");
        // One choice sets every conflicting item, so many conflicts need one decision.
        await expect(
            dialog.getByRole("combobox", { name: "If a.txt exists" }),
        ).toHaveValue("override");
        await expect(
            dialog.getByRole("combobox", { name: "If b.txt exists" }),
        ).toHaveValue("override");

        await dialog
            .getByRole("combobox", { name: "If b.txt exists" })
            .selectOption("rename");
        // Changing one item afterwards leaves the bulk choice undecided instead of wrong.
        await expect(
            dialog.getByRole("combobox", { name: "For every existing item" }),
        ).toHaveValue("");

        await confirmUpload(page, 2);

        // The replaced file gets the upload, while the renamed one keeps the existing file.
        await expect
            .poll(() => readWhenPresent(path.join(directoryPath, "a.txt")))
            .toBe("new a");
        await expect
            .poll(() => readWhenPresent(path.join(directoryPath, "b_2.txt")))
            .toBe("new b");
        expect(await readWhenPresent(path.join(directoryPath, "b.txt"))).toBe(
            "old b",
        );
    });

    test("adds a pasted image while a name has focus and stays confirmable during refreshes", async ({
        page,
    }) => {
        const directoryPath = path.join(ctx.testDirPath, "focused");
        await fs.mkdir(directoryPath);
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(directoryPath)}`,
        );
        await expect(
            page.getByRole("button", { name: "Paste files or text" }),
        ).toBeVisible();

        await pasteText(page, "first paste");

        const dialog = uploadDialog(page);

        const nameField = dialog.getByRole("textbox", {
            name: "Name for pasted-text.txt",
        });

        // The paste focuses its name so it can be typed over straight away.
        await expect(nameField).toBeFocused();

        await page.evaluate(() => {
            const clipboardData = new DataTransfer();
            clipboardData.items.add(
                new File(["image bytes"], "screenshot.png", {
                    type: "image/png",
                }),
            );
            document.activeElement?.dispatchEvent(
                new ClipboardEvent("paste", {
                    bubbles: true,
                    cancelable: true,
                    clipboardData,
                }),
            );
        });
        // A file cannot go into the focused name field, so it joins the upload instead.
        await expect(
            dialog.getByRole("textbox", { name: "Name for screenshot.png" }),
        ).toBeVisible();

        const uploadButton = dialog.getByRole("button", {
            name: "Upload 2 items",
            exact: true,
        });

        await expect(uploadButton).toBeEnabled();

        let releaseListing = () => {};

        const listingHeld = new Promise<void>((resolve) => {
            releaseListing = resolve;
        });

        await page.route("**/ls/**", async (route) => {
            await listingHeld;
            await route.continue();
        });

        const refresh = page.waitForRequest((request) =>
            request.url().includes("/ls/"),
        );

        await simulateTabRefocus(page);
        await refresh;
        // A background refresh, which changes on the device trigger at any time, must not
        // switch the button off under the user's click.
        await expect(uploadButton).toBeEnabled();

        releaseListing();
        await page.unrouteAll({ behavior: "wait" });
        await confirmUpload(page, 2);

        // Both the pasted text and the image are uploaded.
        await expect
            .poll(() =>
                readWhenPresent(path.join(directoryPath, "screenshot.png")),
            )
            .toBe("image bytes");
        await expect
            .poll(() =>
                readWhenPresent(path.join(directoryPath, "pasted-text.txt")),
            )
            .toBe("first paste");
    });
});
