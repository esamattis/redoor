import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
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

    test.beforeAll(async () => {
        await fs.rm(TEST_DIR, { force: true, recursive: true });
        await fs.mkdir(TEST_DIR);
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
        await apiClient.waitForAgentNames(["agent1", "agent2"], 30000);
        const agents = await apiClient.listAgents();
        const agent = agents[0];
        if (!agent) {
            throw new Error("No agent available for testing");
        }
        agentId = agent.id;
        agentName = agent.name;
    });

    test.afterAll(async () => {
        await fs.rm(TEST_DIR, { force: true, recursive: true });
    });

    test("should display file list at agent root", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);

        const testDirLink = page.getByRole("link", { name: ".test" });
        await expect(testDirLink).toBeVisible();
    });

    test("should navigate to subdirectory and display files", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .getByRole("cell", { name: ".test" })
            .getByText(".test")
            .click();

        await expect(page.getByText("file1.txt")).toBeVisible();
        await expect(page.getByText("file2.txt")).toBeVisible();
        await expect(page.getByRole("cell", { name: "subdir1" })).toBeVisible();
        await expect(page.getByRole("cell", { name: "subdir2" })).toBeVisible();
        await expect(page.getByRole("cell", { name: "subdir3" })).toBeVisible();

        const fileEntries = page.locator("tbody tr");
        await expect(fileEntries).toHaveCount(5);
    });

    test("should navigate to deep nested directory", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .getByRole("cell", { name: ".test" })
            .getByText(".test")
            .click();
        await page
            .getByRole("cell", { name: "subdir2" })
            .getByText("subdir2")
            .click();

        await expect(page.getByRole("cell", { name: "deep" })).toBeVisible();

        await page
            .getByRole("cell", { name: "deep" })
            .getByText("deep")
            .click();

        await expect(page.getByText("nested3.txt")).toBeVisible();

        const fileEntries = page.locator("tbody tr");
        await expect(fileEntries).toHaveCount(1);
    });

    test("should navigate using breadcrumbs", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page.getByRole("link", { name: ".test" }).click();
        await page.getByRole("link", { name: "subdir2" }).click();
        await page.getByRole("link", { name: "deep" }).click();

        const breadcrumbs = page.locator(".flex.items-center.gap-2.text-sm");
        await expect(breadcrumbs).toContainText(agentName);
        await expect(breadcrumbs).toContainText(".test");
        await expect(breadcrumbs).toContainText("subdir2");
        await expect(breadcrumbs).toContainText("deep");

        await breadcrumbs.getByText(".test").click();
        await expect(page.getByText("file1.txt")).toBeVisible();
        await expect(page.getByRole("cell", { name: "subdir1" })).toBeVisible();
        await expect(page.getByRole("cell", { name: "subdir2" })).toBeVisible();
        await expect(page.getByRole("cell", { name: "subdir3" })).toBeVisible();

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
            .getByRole("cell", { name: ".test" })
            .getByText(".test")
            .click();
        await page
            .getByRole("cell", { name: "subdir2" })
            .getByText("subdir2")
            .click();
        await page
            .getByRole("cell", { name: "deep" })
            .getByText("deep")
            .click();

        const upButton = page.getByRole("link", { name: "Up" });
        await upButton.click();

        await expect(page.getByRole("cell", { name: "deep" })).toBeVisible();

        await upButton.click();

        await expect(page.getByText("file1.txt")).toBeVisible();
        await expect(page.getByRole("cell", { name: "subdir1" })).toBeVisible();
        await expect(page.getByRole("cell", { name: "subdir2" })).toBeVisible();

        await upButton.click();

        await expect(page).toHaveURL(new RegExp(`/agents/${agentId}`));
        await expect(upButton).toHaveClass(/disabled:opacity-50/);
    });

    test("should navigate back to agent page using Back to Agent button", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page
            .getByRole("cell", { name: ".test" })
            .getByText(".test")
            .click();

        const backToAgentButton = page.getByRole("link", {
            name: "Back to Agent",
        });
        await backToAgentButton.click();

        await expect(page).toHaveURL(new RegExp(`/agents/${agentId}$`));
    });

    test("should display correct icons and sizes", async ({ page }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${agentId}/browser`);
        await page.getByRole("link", { name: ".test" }).click();

        const dirLinks = page.getByRole("link", {
            name: /^(subdir1|subdir2|subdir3)$/,
        });
        await expect(dirLinks).toHaveCount(3);

        const fileEntries = page
            .locator("td")
            .filter({ hasText: /^(file1|file2)\.txt$/ });
        await expect(fileEntries).toHaveCount(2);

        const dirSizeColumn = page
            .getByRole("cell", { name: "subdir1" })
            .locator("xpath=..")
            .getByRole("cell", { name: "-" });
        await expect(dirSizeColumn).toBeVisible();

        const fileSizeColumn = page
            .getByRole("cell", { name: "file1.txt" })
            .locator("xpath=..")
            .locator("td")
            .nth(2);
        await expect(fileSizeColumn).not.toHaveText("-");
    });
});
