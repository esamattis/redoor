import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { ApiClient } from "#ui/api-client";
import { encodeFilesystemPath } from "#ui/api-paths";
import { testPorts } from "#test-ports";

export { encodeFilesystemPath };

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

const BASE_TEST_DIR = path.join(__dirname, "..", "..", ".test");

// The UI is served from the same redoor server as the API, so both
// the browser and the API client target the same origin.
export const WEB_BASE_URL = `http://localhost:${testPorts.playwright}`;

export const API_BASE_URL = WEB_BASE_URL;

/** A logged-in API client for test setup and cleanup. */
async function loggedInApi(): Promise<ApiClient> {
    const api = new ApiClient(API_BASE_URL);
    await api.login("test-user", "test-password");

    return api;
}

/** Whether a websocket is the socket that attaches a page to a terminal session. */
export function isTerminalSocket(url: string): boolean {
    return /^\/api\/v1\/terminals\/[^/]+\/ws$/.test(new URL(url).pathname);
}

/** Directories of sessions created by isolated pages, kept after the session is closed. */
const createdTerminalCwds = new Map<string, string>();

/**
 * The directory the terminal session behind an attach socket was created in. Sessions of
 * isolated pages are remembered, so this works after the tab was closed too.
 */
export async function terminalSocketCwd(
    url: string,
): Promise<string | undefined> {
    const sessionId = new URL(url).pathname.split("/").at(-2) ?? "";
    const remembered = createdTerminalCwds.get(sessionId);

    if (remembered !== undefined) {
        return remembered;
    }

    const api = await loggedInApi();

    return (await api.listTerminalSessions()).sessions.find(
        (session) => session.id === sessionId,
    )?.cwd;
}

/**
 * Deletes every terminal session. Sessions outlive pages, so serial specs call this between
 * tests: otherwise the next test's page restores the previous test's shells as tabs.
 */
export async function deleteAllTerminalSessions(): Promise<void> {
    const api = await loggedInApi();

    for (const session of (await api.listTerminalSessions()).sessions) {
        await api.deleteTerminalSession(session.id).catch(() => undefined);
    }
}

/** The fields of a created session the isolation keeps. */
const createdSessionSchema = z.object({
    session: z.object({ id: z.string(), cwd: z.string() }),
});

/** A session list, keeping every field of each session for the page. */
const sessionListSchema = z.object({
    sessions: z.array(z.looseObject({ id: z.string() })),
});

/** Sessions created by each isolated page, so its spec can delete them afterwards. */
const isolatedTerminalSessions = new WeakMap<Page, Set<string>>();

/**
 * Shows a page only the terminal sessions it created itself. Sessions are server state that
 * every page restores as tabs, and parallel specs share the same devices, so without this
 * one spec's shells would appear in another's tab strip, shift its tab numbers, and could
 * even be taken over by it. Pair with `deleteIsolatedTerminalSessions` in `afterEach`.
 */
export async function isolateTerminalSessions(page: Page): Promise<void> {
    const own = new Set<string>();
    isolatedTerminalSessions.set(page, own);
    await page.route("**/api/v1/agents/*/terminals", async (route) => {
        const response = await route.fetch();

        if (response.ok()) {
            const created = createdSessionSchema.parse(await response.json());

            own.add(created.session.id);
            createdTerminalCwds.set(created.session.id, created.session.cwd);
        }

        await route.fulfill({ response });
    });
    await page.route("**/api/v1/terminals", async (route) => {
        if (route.request().method() !== "GET") {
            await route.fallback();

            return;
        }

        const response = await route.fetch();
        const list = sessionListSchema.parse(await response.json());

        await route.fulfill({
            response,
            json: {
                sessions: list.sessions.filter((session) =>
                    own.has(session.id),
                ),
            },
        });
    });
}

/** Deletes the sessions an isolated page created, so later specs never see them. */
export async function deleteIsolatedTerminalSessions(
    page: Page,
): Promise<void> {
    const own = isolatedTerminalSessions.get(page);

    if (own === undefined || own.size === 0) {
        return;
    }

    const api = await loggedInApi();

    for (const sessionId of own) {
        await api.deleteTerminalSession(sessionId).catch(() => undefined);
    }
}

/** Asserts keyboard ownership through wterm's hidden textarea inside the accessible host. */
export async function expectTerminalFocused(terminal: Locator): Promise<void> {
    // WTerm also labels its textarea; filter to the host whose descendants own shell focus.
    const host = terminal.filter({ has: terminal.page().locator("textarea") });
    await expect
        .poll(() =>
            host.evaluate((host) =>
                host.contains(host.ownerDocument.activeElement),
            ),
        )
        .toBe(true);
}

/** Asserts that neither the terminal host nor its internal input owns keyboard focus. */
export async function expectTerminalBlurred(terminal: Locator): Promise<void> {
    const host = terminal.filter({ has: terminal.page().locator("textarea") });
    // Leaving the shell must move focus completely outside its accessible host.
    await expect
        .poll(() =>
            host.evaluate(
                (host) => !host.contains(host.ownerDocument.activeElement),
            ),
        )
        .toBe(true);
}

/**
 * Builds the browser URL of a path on a device the way a person would type it. UI URLs carry
 * the device name, never its id; the UI itself builds them through the router.
 */
export function deviceBrowserUrl(deviceName: string, path: string): string {
    return `${WEB_BASE_URL}/agents/${encodeURIComponent(deviceName)}/browser/${encodeFilesystemPath(path)}`;
}

export interface TestContext {
    /** Device id for API requests and stored references such as bookmarks. */
    agentId: string;
    /** Device name for UI URLs. */
    agentName: string;
    agentHome: string;
    agent2Id: string;
    agent2Name: string;
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
        agent2Name: agent2.name,
        agent2Home: agent2.cwd,
        agentBrowserUrl: deviceBrowserUrl(agent.name, agent.cwd),
        agent2BrowserUrl: deviceBrowserUrl(agent2.name, agent2.cwd),
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
    const minimize = page.getByRole("button", {
        name: "Minimize bottom drawer",
    });

    const expand = page.getByRole("button", { name: "Expand bottom drawer" });
    await expect(minimize.or(expand)).toBeVisible();

    if (await minimize.isVisible()) {
        // Enter avoids a hover tooltip that would later collide with other tooltip assertions.
        await minimize.press("Enter");
    }

    await expect(expand).toBeVisible();
    const panel = page.getByRole("region", { name: "Application tools" });
    // The close slide still covers the listing until height returns to the compact bar.
    await expect
        .poll(async () => (await panel.boundingBox())?.height ?? 0)
        .toBe(49);
    await expand.blur();
}

/** Confirms the selected-item transfer dialog opened by Copy or Move. */
export async function confirmSelectedTransfer(
    page: Page,
    operation: "Copy" | "Move",
): Promise<void> {
    const dialog = page.getByRole("dialog", {
        name: new RegExp(`^${operation} selected items?\\?$`),
    });

    await expect(dialog).toBeVisible();
    await dialog
        .getByRole("button", {
            name: `${operation} selected item`,
            exact: true,
        })
        .or(
            dialog.getByRole("button", {
                name: `${operation} selected items`,
                exact: true,
            }),
        )
        .click();
}

/**
 * Keeps the page's server event stream open but silent. Uploads and edits by specs running
 * in parallel broadcast `routes_changed` to every UI, which refetches all cached agent data,
 * so a test that counts requests would otherwise also count refetches it did not cause.
 */
export async function ignoreServerEvents(page: Page): Promise<void> {
    // Not connecting to the server leaves a mocked socket that opens and never sends.
    await page.routeWebSocket("**/api/v1/ui/ws", () => {});
}

/** Fires the same visibility/focus events the listing and editor listen for. */
export async function simulateTabRefocus(page: Page): Promise<void> {
    await page.evaluate(() => {
        window.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
    });
}

/** Agent token the Playwright server is configured with. */
const AGENT_TOKEN = "test-agent-token";

/**
 * Attempts an agent websocket upgrade that offers an unknown protocol, the way an agent of a
 * different release would, and resolves with the HTTP status the server answered.
 */
export function upgradeWithProtocol(protocol: string, version: string) {
    const url = new URL("/api/v1/agent/ws", WEB_BASE_URL);

    return new Promise<number>((resolve, reject) => {
        const request = http.request(url, {
            headers: {
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
                "Sec-WebSocket-Protocol": protocol,
                "X-Redoor-Agent-Version": version,
                Authorization: `Bearer ${AGENT_TOKEN}`,
            },
        });

        request.on("response", (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
        });
        request.on("upgrade", (_response, socket) => {
            socket.destroy();
            reject(new Error("the server accepted an unknown protocol"));
        });
        request.on("error", reject);
        request.end();
    });
}
