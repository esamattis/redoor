import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiClient } from "../src/api-client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DIR = path.join(__dirname, "..", "..", ".test");
const API_BASE_URL = "http://localhost:3000";
const WEB_BASE_URL = "http://localhost:4000";

test.describe.serial("File Browser Navigation", () => {
    let agentId: string;
    let agentName: string;
    let testDirName: string;

    test.beforeAll(async () => {
        await fs.rm(TEST_DIR, { force: true, recursive: true });
        await fs.mkdir(TEST_DIR);
        testDirName = path.basename(TEST_DIR);
        await fs.mkdir(path.join(TEST_DIR, "subdir1"));
        await fs.mkdir(path.join(TEST_DIR, "subdir2"));
        await fs.mkdir(path.join(TEST_DIR, "subdir2", "deep"));
        await fs.mkdir(path.join(TEST_DIR, "subdir3"));

        await fs.writeFile(path.join(TEST_DIR, "file1.txt"), "content1");
        await fs.writeFile(path.join(TEST_DIR, "file2.txt"), "content2");
        await fs.writeFile(
            path.join(TEST_DIR, "subdir1", "nested1.txt"),
            "nested1",
        );
        await fs.writeFile(
            path.join(TEST_DIR, "subdir1", "nested2.txt"),
            "nested2",
        );
        await fs.writeFile(
            path.join(TEST_DIR, "subdir2", "deep", "nested3.txt"),
            "nested3",
        );

        const apiClient = new ApiClient(API_BASE_URL);
        await apiClient.waitForAgentNames(
            ["agent1_src", "agent2_custom"],
            120000,
        );
        const agents = await apiClient.listAgents();
        const agent = agents.find((entry) => entry.name === "agent1_src");
        if (!agent) {
            throw new Error("Agent agent1_src not available for testing");
        }
        agentId = agent.id;
        agentName = agent.name;
    });

    test.afterAll(async () => {
        await fs.rm(TEST_DIR, { force: true, recursive: true });
    });

    test("should display file list at agent root", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);

        await expect(
            page.locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`),
        ).toBeVisible();
    });

    test("should navigate to subdirectory and display files", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();

        await expect(page.getByText("file1.txt")).toBeVisible();
        await expect(page.getByText("file2.txt")).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir1", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir2", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir3", exact: true }),
        ).toBeVisible();

        const fileEntries = page.locator("main tbody tr");
        await expect(fileEntries).toHaveCount(5);
    });

    test("should navigate to deep nested directory", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();
        await page.getByRole("link", { name: "subdir2", exact: true }).click();

        await expect(
            page.getByRole("link", { name: "deep", exact: true }),
        ).toBeVisible();

        await page.getByRole("link", { name: "deep", exact: true }).click();

        await expect(page.getByText("nested3.txt")).toBeVisible();

        const fileEntries = page.locator("main tbody tr");
        await expect(fileEntries).toHaveCount(1);
    });

    test("should navigate using breadcrumbs", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();
        await page.getByRole("link", { name: "subdir2" }).click();
        await page.getByRole("link", { name: "deep" }).click();

        const breadcrumbs = page.locator(".flex.items-center.gap-2.text-sm");
        await expect(breadcrumbs).toContainText(agentName);
        await expect(breadcrumbs).toContainText(testDirName);
        await expect(breadcrumbs).toContainText("subdir2");
        await expect(breadcrumbs).toContainText("deep");

        await breadcrumbs.getByText(testDirName, { exact: true }).click();
        await expect(page.getByText("file1.txt")).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir1", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir2", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir3", exact: true }),
        ).toBeVisible();

        await page.getByRole("link", { name: "subdir1" }).click();
        const subdir1Breadcrumbs = page.locator(
            ".flex.items-center.gap-2.text-sm",
        );
        await expect(subdir1Breadcrumbs).toContainText("subdir1");
        await expect(page.getByText("nested1.txt")).toBeVisible();
        await expect(page.getByText("nested2.txt")).toBeVisible();
    });

    test("should navigate using Up button", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();
        await page.getByRole("link", { name: "subdir2", exact: true }).click();
        await page.getByRole("link", { name: "deep", exact: true }).click();

        // Waiting for deep-directory content ensures the next Up click runs
        // after the route loader has rendered the nested page rather than
        // racing with the intermediate URL change.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${agentId}/browser/${testDirName}/subdir2/deep`,
        );
        await expect(page.getByText("nested3.txt")).toBeVisible();

        await page.getByRole("link", { name: "Up", exact: true }).click();

        // One Up click should remove only the deepest path segment.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${agentId}/browser/${testDirName}/subdir2`,
        );
        // Seeing the child directory confirms we landed in the immediate parent directory.
        await expect(
            page.getByRole("link", { name: "deep", exact: true }),
        ).toBeVisible();
        // The breadcrumb text confirms the browser stopped at subdir2 instead of jumping to the test root.
        await expect(
            page.locator(".flex.items-center.gap-2.text-sm"),
        ).toContainText("subdir2");

        const upButton = page.getByRole("link", {
            name: "Up",
            exact: true,
        });
        await upButton.click();

        // The second Up click should return from subdir2 to the test directory root.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${agentId}/browser/${testDirName}`,
        );
        // Root directory entries confirm the browser returned to the expected directory listing.
        await expect(
            page.getByRole("link", { name: "subdir1", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir2", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir3", exact: true }),
        ).toBeVisible();

        await upButton.click();

        // This verifies the final upward navigation from the test directory returns to the agent cwd browser root.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${agentId}/browser`,
        );
        await expect(
            page.getByRole("link", { name: testDirName, exact: true }),
        ).toBeVisible();
        // The disabled styling confirms there is no parent above the agent cwd root.
        await expect(upButton).toHaveClass(/disabled:opacity-50/);
    });

    test("should navigate back to agent page using Back to Agent button", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();

        const backToAgentButton = page.getByRole("link", {
            name: "Back to Agent",
        });
        await backToAgentButton.click();

        await expect(page).toHaveURL(new RegExp(`/agents/${agentId}$`));
    });

    test("should display correct icons and sizes", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();

        const dirLinks = page.getByRole("link", {
            name: /^(subdir1|subdir2|subdir3)$/,
        });
        await expect(dirLinks).toHaveCount(3);

        const fileEntries = page
            .locator("td")
            .filter({ hasText: /^(file1|file2)\.txt$/ });
        await expect(fileEntries).toHaveCount(2);

        const dirSizeColumn = page.getByRole("cell", {
            name: "Size for subdir1",
        });
        await expect(dirSizeColumn).toBeVisible();

        const fileSizeColumn = page.getByRole("cell", {
            name: "Size for file1.txt",
        });
        await expect(fileSizeColumn).not.toHaveText("-");
    });

    test("should navigate to file detail view", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        await expect(page.locator("h1.text-2xl.font-bold")).toContainText(
            "file1.txt",
        );
        await expect(page.getByText("Size")).toBeVisible();
        await expect(page.getByText("Owner")).toBeVisible();
        await expect(page.getByText("Group")).toBeVisible();
        await expect(page.getByText("UID")).toBeVisible();
        await expect(page.getByText("GID")).toBeVisible();
        await expect(page.getByText("Full Path")).toBeVisible();
        await expect(
            page.getByRole("link", { name: "Download File" }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "Back", exact: true }),
        ).toBeVisible();
    });

    test("should display correct file size on detail view", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        const sizeText = await page
            .locator("p", { hasText: "Size" })
            .locator("..")
            .locator("p.text-gray-900")
            .textContent();

        expect(sizeText).toBeDefined();
        expect(sizeText).not.toBe("-");
    });

    test("should navigate back from file detail view", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        const backButton = page.getByRole("link", {
            name: "Back",
            exact: true,
        });
        await backButton.click();

        // This confirms returning from detail view restores the file list without matching the selection control cell.
        await expect(
            page.getByRole("link", { name: "file1.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "subdir1", exact: true }),
        ).toBeVisible();
    });

    test("should navigate back to agent from file detail view", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();

        await page
            .getByRole("link", { name: "file1.txt", exact: true })
            .click();

        const backToAgentButton = page.getByRole("link", {
            name: "Back to Agent",
        });
        await backToAgentButton.click();

        await expect(page).toHaveURL(new RegExp(`/agents/${agentId}$`));
    });

    test("should navigate to nested file detail view", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();
        await page.getByRole("link", { name: "subdir1" }).click();

        await page
            .getByRole("link", { name: "nested1.txt", exact: true })
            .click();

        await expect(page.locator("h1.text-2xl.font-bold")).toContainText(
            "nested1.txt",
        );
        await expect(page.getByText("Size")).toBeVisible();
        await expect(page.getByText("Full Path")).toBeVisible();

        const backLink = page.getByRole("link", { name: "Back", exact: true });
        await backLink.click();

        // These assertions verify the nested directory listing is restored after using the back link.
        await expect(
            page.getByRole("link", { name: "nested1.txt", exact: true }),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: "nested2.txt", exact: true }),
        ).toBeVisible();
    });

    test("should upload files from directory view", async ({ page }) => {
        const uploadSourceDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "redoor-upload-"),
        );
        const firstUploadPath = path.join(uploadSourceDir, "uploaded-a.txt");
        const secondUploadPath = path.join(uploadSourceDir, "uploaded-b.txt");

        await fs.writeFile(firstUploadPath, "uploaded content a");
        await fs.writeFile(secondUploadPath, "uploaded content b");

        try {
            await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
            await page
                .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
                .click();
            await page.getByRole("link", { name: "subdir3" }).click();

            await page
                .getByLabel("Choose files to upload")
                .setInputFiles([firstUploadPath, secondUploadPath]);

            // This checks the inline status feedback shown next to the upload action.
            await expect(page.getByText("Uploaded 2 files")).toBeVisible();

            // This confirms the transfer progress panel reflects the completed upload state for the first uploaded file.
            await expect(
                page
                    .getByRole("row")
                    .filter({ hasText: "uploaded-a.txt" })
                    .filter({ hasText: "completed" })
                    .last(),
            ).toBeVisible();
            // This verifies the first uploaded file name is rendered in transfer progress even if multiple matching rows exist during refreshes.
            await expect(
                page
                    .getByRole("row")
                    .filter({ hasText: "uploaded-a.txt" })
                    .last(),
            ).toBeVisible();
            // This verifies multi-file uploads are tracked independently in transfer progress even if multiple matching rows exist during refreshes.
            await expect(
                page
                    .getByRole("row")
                    .filter({ hasText: "uploaded-b.txt" })
                    .last(),
            ).toBeVisible();
        } finally {
            await fs.rm(uploadSourceDir, { force: true, recursive: true });
        }
    });

    test("should create directory from directory view", async ({ page }) => {
        const createdDirectoryName = `created-via-ui-${Date.now()}`;
        const createdDirectoryPath = path.join(
            TEST_DIR,
            "subdir3",
            createdDirectoryName,
        );

        await fs.rm(createdDirectoryPath, { force: true, recursive: true });

        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();
        await page.getByRole("link", { name: "subdir3", exact: true }).click();

        await page.getByRole("button", { name: "Create directory" }).click();

        // The dialog must open before submitting so the test exercises the browser action rather than the API directly.
        await expect(
            page.getByRole("dialog", { name: "Create directory" }),
        ).toBeVisible();

        await page
            .getByRole("textbox", { name: "Directory name" })
            .fill(createdDirectoryName);

        // The preview path confirms the UI targets the current directory instead of the agent root.
        await expect(page.getByText(createdDirectoryPath)).toBeVisible();

        await page
            .getByRole("dialog", { name: "Create directory" })
            .getByRole("button", { name: "Create directory", exact: true })
            .click();

        // Seeing the new entry in the listing confirms the route refreshed with the created directory.
        await expect(
            page.getByRole("link", { name: createdDirectoryName, exact: true }),
        ).toBeVisible();

        const createdDirectoryStats = await fs.stat(createdDirectoryPath);

        // A directory on disk proves the UI action created the requested directory through the backend.
        expect(createdDirectoryStats.isDirectory()).toBe(true);
    });

    test("should delete file from detail view after confirmation", async ({
        page,
    }) => {
        const deletableFilePath = path.join(
            TEST_DIR,
            "subdir3",
            "delete-me.txt",
        );
        await fs.writeFile(deletableFilePath, "temporary content");

        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();
        await page.getByRole("link", { name: "subdir3" }).click();
        await page.getByRole("link", { name: "delete-me.txt" }).click();

        await page.getByRole("button", { name: "Delete file" }).click();

        // This verifies the UI uses a custom confirmation dialog instead of deleting immediately.
        await expect(
            page.getByRole("dialog", { name: "Delete this file?" }),
        ).toBeVisible();
        // This keeps accidental-delete protection intact by ensuring the cancel action closes the dialog.
        await page.getByRole("button", { name: "Cancel" }).click();
        await expect(
            page.getByRole("dialog", { name: "Delete this file?" }),
        ).toBeHidden();

        await page.getByRole("button", { name: "Delete file" }).click();
        await page
            .getByRole("dialog", { name: "Delete this file?" })
            .getByRole("button", { name: "Delete file" })
            .click();

        // Redirecting back to the parent directory confirms the delete request completed successfully.
        await expect(page).toHaveURL(
            new RegExp(`/agents/${agentId}/browser/${testDirName}/subdir3$`),
        );
        // The deleted entry disappearing from the listing proves the route refreshed with the new filesystem state.
        await expect(
            page.getByRole("link", { name: "delete-me.txt" }),
        ).toHaveCount(0);
    });

    test("should delete selected file from directory view after confirmation", async ({
        page,
    }) => {
        const deletableFilePath = path.join(
            TEST_DIR,
            "subdir3",
            "delete-selected.txt",
        );

        await fs.writeFile(deletableFilePath, "temporary content");

        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .locator(`a[href="/agents/${agentId}/browser/${testDirName}"]`)
            .click();
        await page.getByRole("link", { name: "subdir3" }).click();

        await page
            .getByRole("button", { name: "Select file delete-selected.txt" })
            .click();

        const deleteSelectedItemsButton = page.getByRole("button", {
            name: "Delete selected items",
        });

        // This verifies the selected-items delete action is available after selecting a file.
        await expect(deleteSelectedItemsButton).toBeEnabled();

        await deleteSelectedItemsButton.click();

        // The file name is rendered in both the listing and the selected-items panel, so wait on disk state first.
        await expect
            .poll(async () => {
                try {
                    await fs.stat(deletableFilePath);
                    return "present";
                } catch {
                    return "missing";
                }
            })
            .toBe("missing");
        await expect(
            page.getByRole("button", { name: "Unselect delete-selected.txt" }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("button", {
                name: "Select file delete-selected.txt",
            }),
        ).toHaveCount(0);
        await expect(
            page.getByRole("row", {
                name: /File entry delete-selected\.txt/,
            }),
        ).toHaveCount(0);
        // The file row disappearing confirms the directory view refreshed after the shared selected-items delete action.
        await expect(
            page.getByRole("button", {
                name: "Unselect file delete-selected.txt",
            }),
        ).toHaveCount(0);
    });
});
