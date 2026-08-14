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
        // The newest seeded history record must survive the bounded scan.
        await expect(logRegion).toContainText("[agent-history-fixture] 510");
        // The oldest fixture must be evicted rather than loading the complete file.
        await expect(logRegion).not.toContainText(
            "[agent-history-fixture] 001",
        );
        const historyText = (await logRegion.textContent()) ?? "";
        const fixtures = Array.from(
            historyText.matchAll(/\[agent-history-fixture\] (\d{3})/g),
        );
        // Multiple fixture records are necessary to make chronology observable.
        expect(fixtures.length).toBeGreaterThan(1);
        // Retained records must remain oldest-to-newest in DOM order.
        expect(Number(fixtures.at(-1)?.[1])).toBeGreaterThan(
            Number(fixtures[0]?.[1]),
        );

        const autoScroll = page.getByRole("checkbox", { name: "Auto-scroll" });
        // Agent logs should follow the newest entry by default just like server logs.
        await expect(autoScroll).toBeChecked();
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

        await autoScroll.uncheck();
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
        await autoScroll.check();
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
