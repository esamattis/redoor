import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    expect,
    test,
    type WebSocket as PlaywrightWebSocket,
} from "@playwright/test";

import {
    WEB_BASE_URL,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

const projectRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const agentLogPath = path.join(projectRoot, "log/playwright-agent1_src.log");
const serverLogPath = path.join(projectRoot, "log/playwright-redoor.log");
let context: TestContext;

/** Identifies only browser-owned agent log sockets so UI refresh traffic is ignored. */
function isAgentLogSocket(socket: PlaywrightWebSocket): boolean {
    return /^\/api\/v1\/agents\/[^/]+\/logs\/ws$/.test(
        new URL(socket.url()).pathname,
    );
}

/** Returns the newest lifecycle identifier after Strict Mode transient streams settle. */
async function latestStartedStreamId(): Promise<string | undefined> {
    const contents = await fs.readFile(agentLogPath, "utf8");
    return Array.from(
        contents.matchAll(
            /Agent log stream started: log_stream_id=([0-9a-f-]+)/g,
        ),
    ).at(-1)?.[1];
}

test.describe.serial("Agent logs", () => {
    test.beforeAll(async () => {
        context = await setupTestDir("agent-logs");
    });

    test.afterAll(async () => {
        await teardownTestDir(context.testDirPath);
    });

    test("shows bounded history and releases both relay ends on navigation", async ({
        page,
    }) => {
        await page.clock.install();
        const sockets: PlaywrightWebSocket[] = [];
        page.on("websocket", (socket) => {
            if (isAgentLogSocket(socket)) {
                sockets.push(socket);
            }
        });

        await page.goto(`${WEB_BASE_URL}/agents/${context.agentId}`);
        await page.getByRole("link", { name: "View logs" }).click();
        // The visible detail action must target the selected agent's dedicated logs route.
        await expect(page).toHaveURL(
            new RegExp(`/agents/${context.agentId}/logs$`),
        );
        // The shared viewer must retain source-specific heading text.
        await expect(
            page.getByRole("heading", { name: `${context.agentName} logs` }),
        ).toBeVisible();

        const logRegion = page.getByRole("log", {
            name: `${context.agentName} log entries`,
        });
        // Agent startup records must replay from process memory rather than parsed file history.
        await expect(logRegion).toContainText("Starting agent");
        // File-only fixtures from before startup must not appear in process-local replay.
        await expect(logRegion).not.toContainText(
            "[agent-history-fixture] 001",
        );
        const infoSeverity = logRegion.getByLabel("Severity: Info").first();
        // Severity remains independently accessible from timestamp and message text.
        await expect(infoSeverity).toBeVisible();

        const autoScroll = page.getByRole("checkbox", { name: "Auto-scroll" });
        // Agent logs should follow the newest entry by default just like server logs.
        await expect(autoScroll).toHaveAttribute("aria-checked", "true");
        const wrapLines = page.getByRole("checkbox", { name: "Wrap lines" });
        // The shared agent viewer must expose the same line-wrapping control as server logs.
        await expect(wrapLines).toHaveAttribute("aria-checked", "true");
        await expect
            .poll(() =>
                logRegion.evaluate(
                    (element) =>
                        element.scrollHeight -
                        element.scrollTop -
                        element.clientHeight,
                ),
            )
            // A small layout rounding allowance still proves initial bottom positioning.
            .toBeLessThanOrEqual(1);

        await autoScroll.click();
        // The button-based checkbox must expose the disabled auto-scroll state to assistive technology.
        await expect(autoScroll).toHaveAttribute("aria-checked", "false");
        await logRegion.evaluate((element) => {
            element.scrollTop = 0;
        });
        const topBefore = await logRegion.evaluate(
            (element) => element.scrollTop,
        );
        // Explicit top positioning establishes the value live rendering must preserve.
        expect(topBefore).toBeLessThanOrEqual(1);
        await expect(logRegion).toContainText("Agent log stream started:");
        // Live rendering must not override an operator-controlled scroll position.
        await expect
            .poll(() => logRegion.evaluate((element) => element.scrollTop))
            .toBeLessThanOrEqual(1);
        await autoScroll.click();
        // The button-based checkbox must expose that bottom-following behavior is enabled again.
        await expect(autoScroll).toHaveAttribute("aria-checked", "true");
        await expect
            .poll(() =>
                logRegion.evaluate(
                    (element) =>
                        element.scrollHeight -
                        element.scrollTop -
                        element.clientHeight,
                ),
            )
            // Re-enabling auto-scroll must immediately jump to the newest record.
            .toBeLessThanOrEqual(1);

        await expect
            .poll(() => sockets.filter((socket) => !socket.isClosed()).length)
            // Strict Mode may create transient sockets, but only one mounted stream may remain.
            .toBe(1);
        const loggingLevel = page.getByRole("combobox", {
            name: "agent1_src logging level",
        });
        await loggingLevel.selectOption("trace");
        // The agent control must expose the threshold confirmed over its authoritative socket.
        await expect(loggingLevel).toHaveValue("trace");
        await loggingLevel.selectOption("info");
        // Returning to info gives the failed-update check a known confirmed value.
        await expect(loggingLevel).toHaveValue("info");
        await page.route("**/api/v1/agents/*/logging-level", async (route) => {
            if (route.request().method() === "PUT") {
                await route.fulfill({
                    status: 503,
                    contentType: "application/json",
                    body: JSON.stringify({ error: "Agent is disconnected" }),
                });
                return;
            }
            await route.continue();
        });
        await loggingLevel.selectOption("debug");
        // Failed control-plane updates must be announced assertively to assistive technology.
        await expect(page.getByRole("alert")).toContainText("Could not change");
        // A rejected update must retain the last server-confirmed selection.
        await expect(loggingLevel).toHaveValue("info");
        await expect
            .poll(() => sockets.filter((socket) => !socket.isClosed()).length)
            // Success and failure both leave the active log stream mounted.
            .toBe(1);
        const activeSocket = sockets.find((socket) => !socket.isClosed());
        // The preceding poll guarantees one route-owned socket to observe during teardown.
        expect(activeSocket).toBeDefined();
        if (!activeSocket) {
            throw new Error(
                "active agent log socket disappeared before navigation",
            );
        }
        const streamId = await expect
            .poll(latestStartedStreamId, {
                message: "expected an active agent log lifecycle identifier",
            })
            .not.toBeUndefined()
            .then(() => latestStartedStreamId());
        // Cleanup assertions need a non-secret identifier shared by both lifecycle markers.
        expect(streamId).toBeDefined();
        if (!streamId) {
            throw new Error("agent log stream identifier was unavailable");
        }
        const closed = activeSocket.waitForEvent("close");

        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("link", { name: "Server logs" })
            .click();
        await closed;
        // Destination rendering proves the agent route unmounted completely.
        await expect(
            page.getByRole("heading", { name: "Server logs" }),
        ).toBeVisible();
        await expect
            .poll(() => sockets.filter((socket) => !socket.isClosed()).length)
            // Browser route cleanup must leave no active agent log socket.
            .toBe(0);
        const socketCount = sockets.length;
        await page.clock.runFor(1100);
        // Advancing past reconnect delay proves unmount cleared the stale timer.
        expect(sockets).toHaveLength(socketCount);

        await expect
            .poll(async () => fs.readFile(agentLogPath, "utf8"))
            // The agent marker proves its logger receiver and active task were released.
            .toContain(`Agent log stream stopped: log_stream_id=${streamId}`);
        await expect
            .poll(async () => fs.readFile(serverLogPath, "utf8"))
            // The server marker proves no detached paired relay survived browser teardown.
            .toContain(
                `Agent log relay stopped: agent_id=${context.agentId}, log_stream_id=${streamId}`,
            );
    });
});
