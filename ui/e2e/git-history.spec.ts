import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { $ } from "zx";
import {
    deviceBrowserUrl,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

test.describe.serial("Git history browsing", () => {
    let ctx: TestContext;
    let repositoryPath: string;
    let firstCommit: string;
    let secondCommit: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("git-history");
        repositoryPath = path.join(ctx.testDirPath, "history-repository");
        await fs.mkdir(path.join(repositoryPath, "src"), { recursive: true });
        await fs.writeFile(
            path.join(repositoryPath, "src", "app.ts"),
            'export const version = "first";\n',
        );
        await fs.writeFile(
            path.join(repositoryPath, "src", "retired.ts"),
            "export const retired = true;\n",
        );
        await fs.writeFile(
            path.join(repositoryPath, "notes.txt"),
            "first notes\n",
        );
        await $`git -C ${repositoryPath} init -b main`;
        await $`git -C ${repositoryPath} config user.email playwright@redoor.test`;
        await $`git -C ${repositoryPath} config user.name Playwright`;
        await $`git -C ${repositoryPath} add .`;
        await $`git -C ${repositoryPath} commit -m ${"Initial import"}`;
        await $`git -C ${repositoryPath} tag v1`;
        firstCommit = (
            await $`git -C ${repositoryPath} rev-parse HEAD`
        ).stdout.trim();

        await fs.writeFile(
            path.join(repositoryPath, "src", "app.ts"),
            'export const version = "second";\n',
        );
        await fs.rm(path.join(repositoryPath, "src", "retired.ts"));
        await fs.writeFile(
            path.join(repositoryPath, "notes.txt"),
            "second notes\n",
        );
        await $`git -C ${repositoryPath} add -A`;
        await $`git -C ${repositoryPath} commit -m ${"Bump version"} -m ${"Raises the version for the release."}`;
        secondCommit = (
            await $`git -C ${repositoryPath} rev-parse HEAD`
        ).stdout.trim();
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("browses a tag's tree read-only and keeps the revision in every link", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?rev=v1`,
        );

        const banner = page.getByRole("region", { name: "Git revision" });

        // The banner under the breadcrumbs says which revision is shown.
        await expect(banner).toContainText("v1");
        await expect(banner).toContainText("Initial import");
        const deviceTabs = page.getByLabel("Device view");

        // History is still a filesystem view, so the device tabs stay with Files active.
        await expect(
            deviceTabs.getByRole("link", { name: "Files" }),
        ).toHaveAttribute("aria-current", "page");
        await expect(
            deviceTabs.getByRole("link", { name: "Trash" }),
        ).toBeVisible();
        await expect(
            deviceTabs.getByRole("link", { name: "Logs" }),
        ).toBeVisible();
        // Sync writes files, so it is not offered for history.
        await expect(page.getByRole("link", { name: "Sync" })).toHaveCount(0);

        await page.getByRole("link", { name: "src", exact: true }).click();

        // Directory links keep the revision.
        await expect(page).toHaveURL(/\/src\?rev=v1$/);

        const retiredRow = page.getByRole("row", {
            name: "File entry retired.ts",
        });

        // The deleted file is still part of the tagged tree, in the same file list.
        await expect(retiredRow).toBeVisible();
        // A committed entry can be selected as a copy source of its committed content.
        await expect(
            retiredRow.getByRole("checkbox", {
                name: "Select file retired.ts",
            }),
        ).toBeEnabled();
        // Writing into a committed directory is disabled in the shared toolbar.
        await expect(
            page.getByRole("button", { name: "Upload", exact: true }),
        ).toBeDisabled();
        await expect(
            page.getByRole("button", { name: "New", exact: true }),
        ).toBeDisabled();
        await expect(
            page.getByRole("button", { name: "Paste files or text" }),
        ).toBeDisabled();

        await retiredRow
            .getByRole("button", { name: "Actions for file retired.ts" })
            .click();

        // The row menu keeps its verbs but disables the ones that write.
        await expect(
            page.getByRole("button", { name: "Delete file" }),
        ).toBeDisabled();
        await expect(
            page.getByRole("button", { name: "Rename", exact: true }),
        ).toBeDisabled();
        await page.keyboard.press("Escape");

        await page
            .getByRole("row", { name: "File entry app.ts" })
            .getByRole("link", { name: "app.ts" })
            .click();

        const editor = page.getByRole("textbox", { name: "File editor" });

        // The editor shows the committed text, not the worktree's newer version.
        await expect(editor).toContainText('version = "first"');
        // Committed text cannot be edited.
        await expect(editor).toHaveAttribute("contenteditable", "false");
        // Saving is not offered for a revision.
        await expect(
            page.getByRole("button", { name: "Save file" }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("status", { name: "File edit status" }),
        ).toHaveText("Read-only revision");

        await page
            .getByRole("navigation", { name: "Breadcrumbs" })
            .getByRole("link", { name: "src" })
            .click();

        // Breadcrumbs stay in history too.
        await expect(page).toHaveURL(/\/src\?rev=v1$/);

        await banner.getByRole("link", { name: "Working tree" }).click();

        // Leaving history drops the revision and shows the working files again.
        await expect(page).toHaveURL(/\/src$/);
        await expect(
            page.getByRole("region", { name: "Git revision" }),
        ).toHaveCount(0);
    });

    test("leaves history without leaving the current view", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, path.join(repositoryPath, "src"))}?view=git&rev=v1`,
        );

        await page
            .getByRole("region", { name: "Git revision" })
            .getByRole("link", { name: "Working tree" })
            .click();

        // Only the revision is dropped, so the Git view stays open instead of the file list.
        await expect(page).toHaveURL(/\/src\?view=git$/);
        await expect(
            page.getByRole("region", { name: "Git revision" }),
        ).toHaveCount(0);
    });

    test("shows revision details in the same layout with writes disabled", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, path.join(repositoryPath, "src", "app.ts"))}?view=details&rev=v1`,
        );

        // The details card is the same one the worktree uses.
        await expect(page.getByText("File details")).toBeVisible();
        await expect(page.getByLabel("File size value")).toHaveText("32 B");
        // Git records neither owner nor group, which the card says instead of guessing.
        await expect(page.getByText("Not in Git").first()).toBeVisible();
        // The committed mode drives the read-only permissions grid.
        await expect(page.getByText("rw-r--r--")).toBeVisible();
        // Download serves the committed blob, pinned to the commit the tag resolved to.
        await expect(
            page.getByRole("link", { name: "Download" }),
        ).toHaveAttribute(
            "href",
            new RegExp(`/git/download/.*app\\.ts\\?rev=${firstCommit}$`),
        );
        // Shareable links are one-time tokens for working files, so they stay disabled.
        await expect(
            page.getByRole("button", { name: "Create shareable link" }),
        ).toBeDisabled();
    });

    test("shows a commit's changes from view=git with a revision", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?view=git&rev=${secondCommit}`,
        );

        const modified = page.getByRole("region", {
            name: "Commit diff for src/app.ts",
        });

        const modifiedRow = modified.locator('tr[data-line-kind="modified"]');

        // The message body is shown under the title, not just the summary line.
        await expect(
            page.getByText("Raises the version for the release."),
        ).toBeVisible();
        // The commit's own patch is shown against its parent, as one edited line.
        await expect(modifiedRow).toContainText("export const version");
        await expect(modifiedRow.getByRole("deletion")).toHaveText("first");
        await expect(modifiedRow.getByRole("insertion")).toHaveText("second");
        // The deleted file is listed with its removed lines.
        await expect(
            page.getByRole("region", {
                name: "Commit diff for src/retired.ts",
            }),
        ).toContainText("retired = true");
    });

    test("steps to the previous and next commit from a commit's changes", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?view=git&rev=${secondCommit}`,
        );

        const stepper = page.getByRole("navigation", {
            name: "Commit navigation",
        });

        // HEAD is the newest change, so there is nothing to step forward to.
        await expect(stepper).toContainText("Latest change");
        await expect(
            stepper.getByRole("link", { name: /^Next commit/ }),
        ).toHaveCount(0);

        await stepper
            .getByRole("link", { name: "Previous commit: Initial import" })
            .click();

        // Previous opens the older commit's changes at the same path.
        await expect(page).toHaveURL(new RegExp(`view=git&rev=${firstCommit}`));
        await expect(
            page.getByText("Root commit: every file was added."),
        ).toBeVisible();
        // The root commit has no older change.
        await expect(stepper).toContainText("First change");

        await stepper
            .getByRole("link", { name: "Next commit: Bump version" })
            .click();

        // Next walks back toward HEAD.
        await expect(page).toHaveURL(new RegExp(`rev=${secondCommit}`));
        await expect(
            page.getByRole("region", {
                name: "Commit diff for src/retired.ts",
            }),
        ).toBeVisible();
    });

    test("steps between the changes of the browsed file only", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, path.join(repositoryPath, "src", "app.ts"))}?view=git&rev=${firstCommit}`,
        );

        await page
            .getByRole("navigation", { name: "Commit navigation" })
            .getByRole("link", { name: "Next commit: Bump version" })
            .click();

        // The step keeps the file scope, so only the file's own change is shown.
        await expect(page).toHaveURL(
            new RegExp(`src/app\\.ts\\?view=git&rev=${secondCommit}$`),
        );
        await expect(
            page.getByRole("region", { name: /Commit diff for/ }),
        ).toHaveCount(1);
    });

    test("scopes a commit diff to a file and links to the whole commit", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, path.join(repositoryPath, "src", "app.ts"))}?view=git&rev=${secondCommit}`,
        );

        // The file's own change is shown.
        await expect(
            page
                .getByRole("region", { name: "Commit diff for src/app.ts" })
                .getByRole("insertion"),
        ).toHaveText("second");
        // Changes to other files in the same commit are left out.
        await expect(
            page.getByRole("region", { name: /Commit diff for/ }),
        ).toHaveCount(1);
        await expect(page.getByText("Only changes to")).toContainText(
            "src/app.ts",
        );

        await page
            .getByRole("navigation", { name: "Repository path" })
            .getByRole("link", { name: "history-repository", exact: true })
            .click();

        // The repository root in the path opens the whole commit at the same revision.
        await expect(page).toHaveURL(
            new RegExp(`history-repository\\?view=git&rev=${secondCommit}$`),
        );
        await expect(
            page.getByRole("region", { name: /Commit diff for/ }),
        ).toHaveCount(3);
    });

    test("shows the deletion when a commit removed the browsed file", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, path.join(repositoryPath, "src", "retired.ts"))}?view=git&rev=${secondCommit}`,
        );

        // A file missing at the commit still shows the commit's deletion of it.
        await expect(
            page.getByRole("region", {
                name: "Commit diff for src/retired.ts",
            }),
        ).toContainText("retired = true");
        // The banner still names the commit, which the diff resolved.
        await expect(
            page.getByRole("region", { name: "Git revision" }),
        ).toContainText("Bump version");
    });

    test("shows a run of commits picked in the history as one diff", async ({
        page,
    }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?view=git&gitTab=commits`,
        );

        const history = page.getByRole("group", { name: "Commit history" });
        const selection = page.getByRole("group", { name: "Selected commits" });

        await history
            .getByRole("checkbox", {
                name: `Select commit ${secondCommit.slice(0, 12)}`,
            })
            .click();

        // One picked commit asks for the other end of the run.
        await expect(selection).toContainText("1 commit selected");

        await history
            .getByRole("checkbox", {
                name: `Select commit ${firstCommit.slice(0, 12)}`,
            })
            .click();

        // The second pick closes the run, counting both ends.
        await expect(selection).toContainText("2 commits selected");

        await selection.getByRole("link", { name: "Show changes" }).click();

        // The run opens as a range from the oldest commit's parent, so its changes are included.
        await expect
            .poll(() => new URL(page.url()).searchParams.get("rev"))
            .toBe(`${firstCommit}^..${secondCommit}`);
        await expect(
            page.getByRole("heading", { name: "Changes of a commit range" }),
        ).toBeVisible();
        // The run reaches the root commit, so it starts from an empty tree.
        await expect(page.getByText("Before the first commit")).toBeVisible();
        // The combined diff shows the end state of a file changed by both commits.
        await expect(
            page.getByRole("region", { name: "Commit diff for src/app.ts" }),
        ).toContainText("second");
        // A file added and removed inside the run is not part of the combined change.
        await expect(
            page.getByRole("region", {
                name: "Commit diff for src/retired.ts",
            }),
        ).toHaveCount(0);
        // A range has no single neighbouring commit to step to.
        await expect(
            page.getByRole("navigation", { name: "Commit navigation" }),
        ).toHaveCount(0);

        await page.goBack();

        // Back returns to the history with the same run still picked.
        await expect(selection).toContainText("2 commits selected");
    });

    test("explains a revision that does not exist", async ({ page }) => {
        await page.goto(
            `${deviceBrowserUrl(ctx.agentName, repositoryPath)}?rev=no-such-branch`,
        );

        // The failure is shown in place, with the banner offering the way back.
        await expect(page.getByRole("alert")).toContainText("no-such-branch");
        await expect(
            page
                .getByRole("region", { name: "Git revision" })
                .getByRole("link", { name: "Working tree" }),
        ).toBeVisible();
        // An unresolved revision keeps the device tabs, so the device stays one click away.
        await expect(
            page.getByLabel("Device view").getByRole("link", { name: "Files" }),
        ).toHaveAttribute("aria-current", "page");

        await page
            .getByLabel("Device view")
            .getByRole("link", { name: "Files" })
            .click();

        // The device's Files tab opens the working home directory, outside history.
        await expect(page).not.toHaveURL(/rev=/);
        await expect(
            page.getByRole("region", { name: "Git revision" }),
        ).toHaveCount(0);
    });
});
