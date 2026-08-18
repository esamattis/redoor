import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { ApiClient, encodeFilesystemPath } from "#ui/api-client";
import { testPorts } from "#test-ports";

export { encodeFilesystemPath };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_TEST_DIR = path.join(__dirname, "..", "..", ".test");

// The UI is served from the same redoor server as the API, so both
// the browser and the API client target the same origin.
export const WEB_BASE_URL = `http://localhost:${testPorts.playwright}`;
export const API_BASE_URL = WEB_BASE_URL;

export interface TestContext {
    agentId: string;
    agentName: string;
    agentHome: string;
    agent2Id: string;
    agent2Home: string;
    agentBrowserUrl: string;
    agent2BrowserUrl: string;
    testDirName: string;
    testDirUrlPath: string;
    testDirPath: string;
}

export async function setupTestDir(suffix: string): Promise<TestContext> {
    const testDirPath = `${BASE_TEST_DIR}-${suffix}`;
    await fs.rm(testDirPath, { force: true, recursive: true });
    await fs.mkdir(testDirPath);
    const testDirName = path.basename(testDirPath);
    await fs.mkdir(path.join(testDirPath, "subdir1"));
    await fs.mkdir(path.join(testDirPath, "subdir2"));
    await fs.mkdir(path.join(testDirPath, "subdir2", "deep"));
    await fs.mkdir(path.join(testDirPath, "subdir3"));

    await fs.writeFile(path.join(testDirPath, "file1.txt"), "content1");
    await fs.writeFile(path.join(testDirPath, "file2.txt"), "content2");
    await fs.writeFile(
        path.join(testDirPath, "subdir1", "nested1.txt"),
        "nested1",
    );
    await fs.writeFile(
        path.join(testDirPath, "subdir1", "nested2.txt"),
        "nested2",
    );
    await fs.writeFile(
        path.join(testDirPath, "subdir2", "deep", "nested3.txt"),
        "nested3",
    );

    const apiClient = new ApiClient(API_BASE_URL);
    await apiClient.login("test-user", "test-password");
    await apiClient.waitForConnectedAgentNames(
        ["agent1_src", "agent2_custom"],
        120000,
    );
    const agents = await apiClient.listAgents();
    const agent = agents.find((entry) => entry.name === "agent1_src");
    if (!agent || agent.status !== "connected" || agent.cwd === null) {
        throw new Error("Connected agent agent1_src not available for testing");
    }

    const agent2 = agents.find((entry) => entry.name === "agent2_custom");
    if (!agent2 || agent2.status !== "connected" || agent2.cwd === null) {
        throw new Error(
            "Connected agent agent2_custom not available for testing",
        );
    }

    return {
        agentId: agent.id,
        agentName: agent.name,
        agentHome: agent.cwd,
        agent2Id: agent2.id,
        agent2Home: agent2.cwd,
        agentBrowserUrl: `${WEB_BASE_URL}${agent.getBrowserUrl(agent.cwd)}`,
        agent2BrowserUrl: `${WEB_BASE_URL}${agent2.getBrowserUrl(agent2.cwd)}`,
        testDirName,
        testDirUrlPath: encodeFilesystemPath(testDirPath),
        testDirPath,
    };
}

export async function teardownTestDir(testDirPath: string): Promise<void> {
    await fs.rm(testDirPath, { force: true, recursive: true });
}

/** Collapses the drawer and waits so overlay chrome no longer covers file-list clicks. */
export async function minimizeBottomDrawer(page: Page): Promise<void> {
    const toggle = page.getByRole("button", {
        name: "Minimize bottom drawer",
    });
    // Enter avoids a hover tooltip that would later collide with other tooltip assertions.
    await toggle.press("Enter");
    const expand = page.getByRole("button", { name: "Expand bottom drawer" });
    await expect(expand).toBeVisible();
    const panel = page.getByRole("region", { name: "Application tools" });
    // The close slide still covers the listing until height returns to the compact bar.
    await expect
        .poll(async () => (await panel.boundingBox())?.height ?? 0)
        .toBeLessThan(60);
    await expand.blur();
}

/** Fires the same visibility/focus events the listing and editor listen for. */
export async function simulateTabRefocus(page: Page): Promise<void> {
    await page.evaluate(() => {
        window.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
    });
}
