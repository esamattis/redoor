import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiClient } from "../src/api-client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_TEST_DIR = path.join(__dirname, "..", "..", ".test");

// The UI is served from the same redoor server as the API, so both
// the browser and the API client target the same origin.
export const WEB_BASE_URL = "http://localhost:3000";
export const API_BASE_URL = "http://localhost:3000";

export interface TestContext {
    agentId: string;
    agentName: string;
    agent2Id: string;
    testDirName: string;
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
    await apiClient.waitForAgentNames(["agent1_src", "agent2_custom"], 120000);
    const agents = await apiClient.listAgents();
    const agent = agents.find((entry) => entry.name === "agent1_src");
    if (!agent) {
        throw new Error("Agent agent1_src not available for testing");
    }

    const agent2 = agents.find((entry) => entry.name === "agent2_custom");
    if (!agent2) {
        throw new Error("Agent agent2_custom not available for testing");
    }

    return {
        agentId: agent.id,
        agentName: agent.name,
        agent2Id: agent2.id,
        testDirName,
        testDirPath,
    };
}

export async function teardownTestDir(testDirPath: string): Promise<void> {
    await fs.rm(testDirPath, { force: true, recursive: true });
}
