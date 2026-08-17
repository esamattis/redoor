import {
    expect,
    test,
    type WebSocket as PlaywrightWebSocket,
} from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

/** Identifies only the route-scoped socket so unrelated UI refresh traffic does not affect assertions. */
function isServerLogSocket(socket: PlaywrightWebSocket): boolean {
    return new URL(socket.url()).pathname === "/api/v1/server/logs/ws";
}

/** Opens the logs page through the user-visible navigation path. */
async function navigateToServerLogs(page: import("@playwright/test").Page) {
    await page.goto(`${WEB_BASE_URL}/`);
    await page
        .getByRole("navigation", { name: "Application" })
        .getByRole("link", { name: "Server logs" })
        .click();
}

test.describe.serial("Server logs", () => {
    test("navigates from the menu and shows the latest history in order", async ({
        page,
    }) => {
        const logSockets: PlaywrightWebSocket[] = [];
        page.on("websocket", (socket) => {
            if (isServerLogSocket(socket)) {
                logSockets.push(socket);
            }
        });

        await navigateToServerLogs(page);

        // Menu navigation must resolve to the dedicated authenticated file route.
        await expect(page).toHaveURL(/\/logs$/);
        // The route heading proves the logs destination rendered rather than only changing history.
        await expect(
            page.getByRole("heading", { name: "Server logs" }),
        ).toBeVisible();
        const agentLogsLink = page.getByRole("link", {
            name: "View logs for agent1_src",
        });
        // Connected agents must be discoverable directly from the server-log view.
        await expect(agentLogsLink).toBeVisible();
        const autoScroll = page.getByRole("checkbox", { name: "Auto-scroll" });
        // Operators should initially follow the newest entry without extra interaction.
        await expect(autoScroll).toHaveAttribute("aria-checked", "true");

        const logRegion = page.getByRole("log", {
            name: "Server log entries",
        });
        // The newest seeded fixture must survive the bounded latest-history scan.
        await expect(logRegion).toContainText("[history-fixture] 510");
        // Excluding the oldest fixture proves the server did not return the file beginning or whole file.
        await expect(logRegion).not.toContainText("[history-fixture] 001");

        const historyText = (await logRegion.textContent()) ?? "";
        const retainedFixtures = Array.from(
            historyText.matchAll(/\[history-fixture\] (\d{3})/g),
        );
        // Multiple retained fixtures are needed to make chronological ordering observable.
        expect(retainedFixtures.length).toBeGreaterThan(1);
        const firstFixture = retainedFixtures[0]?.[1] ?? "";
        const lastFixture = retainedFixtures.at(-1)?.[1] ?? "";
        // Oldest-to-newest DOM order must place a later fixture number after an earlier retained one.
        expect(Number(lastFixture)).toBeGreaterThan(Number(firstFixture));
        // The newest deterministic fixture must remain the final fixture in source order.
        expect(lastFixture).toBe("510");

        await expect
            .poll(
                () => logSockets.filter((socket) => !socket.isClosed()).length,
                {
                    message:
                        "expected one open route-scoped log socket after Strict Mode settles",
                },
            )
            // Strict Mode may create a transient socket, but only one mounted route socket may remain open.
            .toBe(1);
    });

    test("navigates from server logs to one connected agent log route", async ({
        page,
    }) => {
        await navigateToServerLogs(page);
        await page
            .getByRole("link", { name: "View logs for agent1_src" })
            .click();
        // The typed link must preserve the selected connected agent in the route.
        await expect(page).toHaveURL(/\/agents\/[^/]+\/logs$/);
        // Rendering the agent-specific heading proves navigation reached the shared viewer wrapper.
        await expect(
            page.getByRole("heading", { name: "agent1_src logs" }),
        ).toBeVisible();
    });

    test("streams live entries, honors auto-scroll, and closes on navigation", async ({
        page,
    }) => {
        await page.clock.install();
        const logSockets: PlaywrightWebSocket[] = [];
        page.on("websocket", (socket) => {
            if (isServerLogSocket(socket)) {
                logSockets.push(socket);
            }
        });

        await navigateToServerLogs(page);
        const connectionStatus = page.getByRole("status", {
            name: "Server log connection status",
        });
        // A Live status proves the initial snapshot arrived before testing live behavior.
        await expect(connectionStatus).toHaveText("Live");
        const logRegion = page.getByRole("log", {
            name: "Server log entries",
        });
        await expect(logRegion).toBeVisible();

        await expect
            .poll(
                () =>
                    logRegion.evaluate(
                        (element) =>
                            element.scrollHeight -
                            element.scrollTop -
                            element.clientHeight,
                    ),
                {
                    message:
                        "expected initial history to auto-scroll to the bottom",
                },
            )
            // A small layout rounding allowance still proves the newest entry is visible.
            .toBeLessThanOrEqual(1);

        const autoScroll = page.getByRole("checkbox", { name: "Auto-scroll" });
        await autoScroll.click();
        // The button-based checkbox must expose the disabled auto-scroll state to assistive technology.
        await expect(autoScroll).toHaveAttribute("aria-checked", "false");
        await logRegion.evaluate((element) => {
            element.scrollTop = 0;
        });
        const scrollTopBefore = await logRegion.evaluate(
            (element) => element.scrollTop,
        );
        // Explicitly moving to the top establishes the position that live rendering must preserve.
        expect(scrollTopBefore).toBeLessThanOrEqual(1);

        const marker = `playwright-live-log-${crypto.randomUUID()}`;
        await page.evaluate(async (value) => {
            const protocol =
                window.location.protocol === "https:" ? "wss:" : "ws:";
            const socket = new WebSocket(
                `${protocol}//${window.location.host}/ws`,
            );
            await new Promise<void>((resolve, reject) => {
                socket.addEventListener("open", () => resolve(), {
                    once: true,
                });
                socket.addEventListener(
                    "error",
                    () => reject(new Error("agent test socket failed")),
                    { once: true },
                );
            });
            socket.send(`not-json-${value}`);
            socket.close();
        }, marker);

        // The unique malformed agent payload must reach the page through the logger broadcast path.
        await expect(logRegion).toContainText(marker);
        const newestEntryTexts = await logRegion.evaluate((element) =>
            Array.from(element.children)
                .slice(-3)
                .map((child) => child.textContent ?? ""),
        );
        // The marker must append near the bottom; the authentic socket shutdown may follow it.
        expect(newestEntryTexts.some((entry) => entry.includes(marker))).toBe(
            true,
        );
        // Disabling auto-scroll must preserve the operator's position while entries still render.
        await expect
            .poll(() => logRegion.evaluate((element) => element.scrollTop))
            .toBeLessThanOrEqual(1);

        await autoScroll.click();
        // The button-based checkbox must expose that bottom-following behavior is enabled again.
        await expect(autoScroll).toHaveAttribute("aria-checked", "true");
        await expect
            .poll(
                () =>
                    logRegion.evaluate(
                        (element) =>
                            element.scrollHeight -
                            element.scrollTop -
                            element.clientHeight,
                    ),
                {
                    message:
                        "expected re-enabled auto-scroll to jump to the newest entry",
                },
            )
            // Re-enabling must immediately restore bottom-following behavior.
            .toBeLessThanOrEqual(1);

        await expect
            .poll(
                () => logSockets.filter((socket) => !socket.isClosed()).length,
            )
            // Exactly one active socket gives teardown a deterministic route-owned connection.
            .toBe(1);
        const activeSocket = logSockets.find((socket) => !socket.isClosed());
        // The preceding poll guarantees an open socket is available to observe closing.
        expect(activeSocket).toBeDefined();
        if (!activeSocket) {
            throw new Error(
                "active server log socket disappeared before navigation",
            );
        }
        const closed = activeSocket.waitForEvent("close");

        await page
            .getByRole("navigation", { name: "Application" })
            .getByRole("link", { name: "Server home" })
            .click();
        await closed;
        // The home heading proves navigation completed and unmounted the logs route.
        await expect(
            page.getByRole("heading", { name: "Server", exact: true }),
        ).toBeVisible();
        await expect
            .poll(
                () => logSockets.filter((socket) => !socket.isClosed()).length,
            )
            // Route cleanup must immediately leave no active log connection.
            .toBe(0);
        const socketCountAfterNavigation = logSockets.length;
        await page.clock.runFor(1100);
        // Advancing beyond the reconnect delay proves cleanup did not leave a stale timer behind.
        expect(logSockets).toHaveLength(socketCountAfterNavigation);
    });
});
