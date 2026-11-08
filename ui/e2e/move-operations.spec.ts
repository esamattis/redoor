import { test, expect } from "./fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    confirmSelectedTransfer,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

/** Selects one source entry and opens the directory that contains its conflict. */
async function openMoveConflict(props: {
    page: import("@playwright/test").Page;
    ctx: TestContext;
    sourceName: string;
    sourceType: "file" | "directory";
    destinationDirectoryName: string;
}) {
    await props.page.goto(
        `${WEB_BASE_URL}/agents/${props.ctx.agentName}/browser/${props.ctx.testDirUrlPath}`,
    );
    await props.page
        .getByRole("checkbox", {
            name: `Select ${props.sourceType} ${props.sourceName}`,
        })
        .click();
    await props.page
        .getByRole("link", {
            name: props.destinationDirectoryName,
            exact: true,
        })
        .click();
    await props.page
        .getByRole("button", {
            name: "Move selected items to this directory",
        })
        .click();
}

test.describe.serial("Move Operations", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("move");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("should show the move destination action only with a selection", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );

        let moveButton = page.getByRole("button", {
            name: "Move selected items to this directory",
        });

        // An empty selection has no destination action to offer.
        await expect(moveButton).toHaveCount(0);

        await page
            .getByRole("checkbox", { name: "Select file file1.txt" })
            .click();
        // Moving onto the same path is unusable, so the action stays hidden at the source.
        await expect(moveButton).toHaveCount(0);

        await page.getByRole("link", { name: "subdir1", exact: true }).click();
        moveButton = page.getByRole("button", {
            name: "Move selected items to this directory",
        });
        // A distinct directory is a valid move destination for the current selection.
        await expect(moveButton).toBeVisible();
        await expect(moveButton).toBeEnabled();
        // Copy must stay available until a transfer actually starts.
        await expect(
            page.getByRole("button", {
                name: "Copy selected items to this directory",
            }),
        ).toBeVisible();

        await page.getByRole("button", { name: "Clear selection" }).click();
        // Clearing the selection must hide both destination actions again.
        await expect(moveButton).toHaveCount(0);
    });

    test("should move selected files into the current directory", async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const suffix = Date.now();
        const firstName = `move-file-a-${suffix}.txt`;
        const secondName = `move-file-b-${suffix}.txt`;
        const firstSourcePath = path.join(ctx.testDirPath, firstName);
        const secondSourcePath = path.join(ctx.testDirPath, secondName);

        const firstDestinationPath = path.join(
            ctx.testDirPath,
            "subdir1",
            firstName,
        );

        const secondDestinationPath = path.join(
            ctx.testDirPath,
            "subdir1",
            secondName,
        );

        await fs.writeFile(firstSourcePath, "move content a");
        await fs.writeFile(secondSourcePath, "move content b");

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("checkbox", { name: `Select file ${firstName}` })
            .click();
        await page
            .getByRole("checkbox", { name: `Select file ${secondName}` })
            .click();
        // The summary proves both source rows entered the persistent selection.
        await expect(
            page.getByText("2 files, 0 directories selected"),
        ).toBeVisible();

        await page.getByRole("link", { name: "subdir1", exact: true }).click();
        const moveResponses: boolean[] = [];
        page.on("response", (response) => {
            if (
                response.url() === `${WEB_BASE_URL}/api/v1/move` &&
                response.request().method() === "POST"
            ) {
                moveResponses.push(response.ok());
            }
        });

        await page
            .getByRole("button", {
                name: "Move selected items to this directory",
            })
            .click();

        const confirmation = page.getByRole("dialog", {
            name: "Move selected items?",
        });

        // The confirmation lists every source before either move request starts.
        await expect(confirmation).toContainText(firstName);
        await expect(confirmation).toContainText(secondName);
        await confirmation
            .getByRole("button", { name: "Move selected items" })
            .click();
        await expect.poll(() => moveResponses.length).toBe(2);
        // Both accepted responses prove each selected source started its own move.
        expect(moveResponses).toEqual([true, true]);
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0, { timeout: 30_000 });

        await page.reload();
        await expect(
            page.getByRole("link", { name: firstName, exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: secondName, exact: true }),
        ).toBeVisible();
        // Filesystem contents verify both moves landed in the current directory.
        await expect(fs.readFile(firstDestinationPath, "utf8")).resolves.toBe(
            "move content a",
        );
        await expect(fs.readFile(secondDestinationPath, "utf8")).resolves.toBe(
            "move content b",
        );
        // A completed move must remove the sources after destination publication.
        await expect(fs.stat(firstSourcePath)).rejects.toThrow();
        await expect(fs.stat(secondSourcePath)).rejects.toThrow();
    });

    test("should move a selected directory into another subdirectory", async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const suffix = Date.now();
        const sourceName = `move-dir-${suffix}`;
        const nestedName = `nested-${suffix}.txt`;
        const sourcePath = path.join(ctx.testDirPath, sourceName);
        const nestedSourcePath = path.join(sourcePath, nestedName);

        const destinationPath = path.join(
            ctx.testDirPath,
            "subdir1",
            sourceName,
        );

        await fs.mkdir(sourcePath);
        await fs.writeFile(nestedSourcePath, "moved directory child");

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("checkbox", { name: `Select directory ${sourceName}` })
            .click();
        await page.getByRole("link", { name: "subdir1", exact: true }).click();
        const moveResponses: boolean[] = [];
        page.on("response", (response) => {
            if (
                response.url() === `${WEB_BASE_URL}/api/v1/move` &&
                response.request().method() === "POST"
            ) {
                moveResponses.push(response.ok());
            }
        });

        await page
            .getByRole("button", {
                name: "Move selected items to this directory",
            })
            .click();
        await confirmSelectedTransfer(page, "Move");
        await expect.poll(() => moveResponses.length).toBe(1);
        // One accepted start proves the directory move left the listing action.
        expect(moveResponses).toEqual([true]);
        // Progress invalidation must finish as success, not a cancelled-query toast.
        await expect(page.getByRole("status")).toContainText(
            `Moved ${sourceName}`,
            { timeout: 30_000 },
        );
        await expect(page.getByRole("alert")).toHaveCount(0);
        await expect(
            page.getByRole("button", { name: "Clear selection" }),
        ).toHaveCount(0);

        await page.reload();
        await expect(
            page.getByRole("link", { name: sourceName, exact: true }),
        ).toBeVisible();
        // Nested contents prove the directory moved as a tree, not as an empty name.
        await expect(
            fs.readFile(path.join(destinationPath, nestedName), "utf8"),
        ).resolves.toBe("moved directory child");
        await expect(fs.stat(sourcePath)).rejects.toThrow();
    });

    test("should hide move after navigating into the selected directory", async ({
        page,
    }) => {
        const sourceName = `nested-move-source-${Date.now()}`;
        const sourcePath = path.join(ctx.testDirPath, sourceName);
        await fs.mkdir(sourcePath);

        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );
        await page
            .getByRole("checkbox", { name: `Select directory ${sourceName}` })
            .click();
        await page.getByRole("link", { name: sourceName, exact: true }).click();
        // Moving a directory into itself is invalid, so the action must stay hidden.
        await expect(
            page.getByRole("button", {
                name: "Move selected items to this directory",
            }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: "Clear selection" }).click();
    });

    test("should move under a new name when resolving a move conflict", async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const stem = `rename-move-${Date.now()}`;
        const sourceName = `${stem}.txt`;
        const sourcePath = path.join(ctx.testDirPath, sourceName);
        const destinationDirPath = path.join(ctx.testDirPath, "subdir1");
        const destinationPath = path.join(destinationDirPath, sourceName);

        await fs.writeFile(sourcePath, "source content");
        await fs.writeFile(destinationPath, "destination content");

        await openMoveConflict({
            page,
            ctx,
            sourceName,
            sourceType: "file",
            destinationDirectoryName: "subdir1",
        });

        const dialog = page.getByRole("dialog", {
            name: "Move selected item?",
        });

        const resolution = dialog.getByRole("combobox", {
            name: `If ${sourceName} exists`,
        });

        // A same-named destination must ask before any request starts.
        await expect(resolution).toBeVisible();
        // Renaming keeps the destination intact, so it is the safe default policy.
        await expect(resolution).toHaveValue("rename");

        const renamedName = `${stem}_2.txt`;

        // The suggested name keeps the extension so the moved file opens the same way.
        await expect(
            dialog.getByRole("textbox", {
                name: `Name for ${sourceName}`,
            }),
        ).toHaveValue(renamedName);

        const moveButton = dialog.getByRole("button", {
            name: "Move selected item",
            exact: true,
        });

        // The shared dialog must use Move-specific confirm text.
        await expect(moveButton).toBeVisible();

        const moveRequest = page.waitForRequest(
            (request) =>
                request.url() === `${WEB_BASE_URL}/api/v1/move` &&
                request.method() === "POST",
        );

        await moveButton.click();

        const requestBody = (await moveRequest).postDataJSON();

        // The prefilled name must be what the move API receives.
        expect(requestBody.dest.path).toBe(
            path.join(destinationDirPath, renamedName),
        );
        // A rename must never overwrite, even if the new name got taken meanwhile.
        expect(requestBody.on_existing).toBe("error");
        // A finished move removes the source and leaves the existing file untouched.
        await expect
            .poll(() =>
                fs.stat(sourcePath).then(
                    () => true,
                    () => false,
                ),
            )
            .toBe(false);
        await expect(
            fs.readFile(path.join(destinationDirPath, renamedName), "utf8"),
        ).resolves.toBe("source content");
        await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe(
            "destination content",
        );
    });
});
