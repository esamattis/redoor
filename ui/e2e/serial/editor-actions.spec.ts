// Serial: rewrites the whole shared user settings document to drop its pins afterwards.
import { test, expect, type Page } from "../fixtures";
import fs from "node:fs/promises";
import { ApiClient } from "#ui/api-client";
import { userStateSchema } from "#ui/user-state";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    encodeFilesystemPath,
    WEB_BASE_URL,
    API_BASE_URL,
    type TestContext,
} from "../helpers";

/** Opens the overflow menu by its public name so renames stay covered. */
async function openEditorActions(page: Page) {
    await page.getByRole("button", { name: "Editor actions" }).click();

    return page.getByRole("dialog", { name: "Editor actions" });
}

test.describe.serial("Editor file actions", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("editor-actions");
    });

    test.afterAll(async () => {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        const state = userStateSchema.parse((await api.getUserState()).state);
        await api.updateUserState({
            state: {
                ...state,
                openFiles: state.openFiles.filter(
                    (file) => !file.path.startsWith(ctx.testDirPath + "/"),
                ),
            },
        });
        await teardownTestDir(ctx.testDirPath);
    });

    for (const permanently of [false, true]) {
        test(`should ${permanently ? "permanently delete" : "trash"} a dirty file from Editor actions`, async ({
            page,
        }) => {
            test.skip(
                !permanently &&
                    process.platform !== "linux" &&
                    process.platform !== "darwin",
                "Trash requires platform support",
            );

            const fileName = permanently
                ? "removable-delete.txt"
                : "removable-trash.txt";

            const filePath = path.join(ctx.testDirPath, fileName);
            await fs.writeFile(filePath, "original content");

            // macOS native Trash cannot use the isolated Linux test trash root.
            if (!permanently && process.platform === "darwin") {
                await page.route("**/raw/**?trash=true", async (route) => {
                    await fs.rm(filePath);
                    await route.fulfill({
                        status: 200,
                        contentType: "application/json",
                        body: JSON.stringify({ path: filePath }),
                    });
                });
            }

            await page.goto(
                `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
            );
            const editor = page.getByLabel("File editor", { exact: true });
            await expect(editor).toHaveText("original content");
            await editor.fill("unsaved content");
            const actions = await openEditorActions(page);
            await actions
                .getByRole("button", { name: "Delete file", exact: true })
                .click();

            const confirmation = page.getByRole("dialog", {
                name: "Delete this file?",
            });

            // Removing the file must explicitly explain that the dirty buffer will be lost.
            await expect(
                confirmation.getByText(
                    "Unsaved edits will be discarded if you remove this file.",
                ),
            ).toBeVisible();
            await confirmation
                .getByRole("button", { name: "Cancel", exact: true })
                .click();
            // Cancellation must preserve both the draft and the original file on disk.
            await expect(editor).toHaveText("unsaved content");
            expect(await fs.readFile(filePath, "utf8")).toBe(
                "original content",
            );
            await (
                await openEditorActions(page)
            )
                .getByRole("button", { name: "Delete file", exact: true })
                .click();

            const permanentCheckbox = confirmation.getByRole("checkbox", {
                name: "Delete permanently",
            });

            if (permanently && (await permanentCheckbox.isVisible())) {
                await permanentCheckbox.check();
            }

            const deletion = page.waitForRequest(
                (request) =>
                    request.method() === "DELETE" &&
                    new URL(request.url()).searchParams.get("trash") ===
                        String(!permanently),
            );

            await confirmation
                .getByRole("button", {
                    name: permanently ? "Delete file" : "Move to trash",
                    exact: true,
                })
                .click();
            await deletion;
            // Successful removal returns directly to the parent without any discard prompt.
            await expect(page).toHaveURL(
                `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(ctx.testDirPath)}`,
            );
            await expect(
                page.getByRole("dialog", { name: "Discard unsaved changes?" }),
            ).toBeHidden();
            // The missing source confirms the action removed the remote file, not just its editor.
            await expect
                .poll(() =>
                    fs.access(filePath).then(
                        () => true,
                        () => false,
                    ),
                )
                .toBe(false);
            await expect(
                page.getByRole("link", { name: fileName, exact: true }),
            ).toHaveCount(0);
        });
    }

    test("should preserve the editor draft when deletion fails", async ({
        page,
    }) => {
        const filePath = path.join(ctx.testDirPath, "removable-error.txt");
        await fs.writeFile(filePath, "original content");
        await page.route("**/raw/**?trash=*", async (route) => {
            await route.fulfill({
                status: 500,
                contentType: "application/json",
                body: JSON.stringify({ error: "Test editor delete failure" }),
            });
        });
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${encodeFilesystemPath(filePath)}`,
        );
        const editor = page.getByLabel("File editor", { exact: true });
        await expect(editor).toHaveText("original content");
        await editor.fill("unsaved content");
        await (
            await openEditorActions(page)
        )
            .getByRole("button", { name: "Delete file", exact: true })
            .click();

        const confirmation = page.getByRole("dialog", {
            name: "Delete this file?",
        });

        const permanentCheckbox = confirmation.getByRole("checkbox", {
            name: "Delete permanently",
        });

        if (await permanentCheckbox.isVisible()) {
            await permanentCheckbox.check();
        }

        await confirmation
            .getByRole("button", { name: "Delete file", exact: true })
            .click();
        // Filesystem errors must remain visible so users can retry or return to their draft.
        await expect(
            confirmation.getByText("Test editor delete failure"),
        ).toBeVisible();
        await confirmation
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
        await expect(editor).toHaveText("unsaved content");

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        // A failed removal keeps the file open, so its unsaved buffer stays on the server.
        await expect
            .poll(async () => {
                const state = userStateSchema.parse(
                    (await api.getUserState()).state,
                );

                return state.openFiles.some((file) => file.path === filePath);
            })
            .toBe(true);
    });
});
