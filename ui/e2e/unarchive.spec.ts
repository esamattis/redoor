import fs from "node:fs/promises";
import path from "node:path";
import {
    expect,
    test,
    type WebSocket as PlaywrightWebSocket,
} from "@playwright/test";
import { $ } from "zx";
import { z } from "zod";
import {
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

const terminalFrameSchema = z.union([
    z.string(),
    z.instanceof(Buffer).transform((payload) => payload.toString("utf8")),
]);

type TerminalSocketEvent = {
    direction: "received" | "sent";
    payload: string;
};

test.describe.serial("Unarchive file action", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("unarchive");
        const currentSource = path.join(ctx.testDirPath, "current-source");
        const subSource = path.join(ctx.testDirPath, "sub-source");
        const isolationSource = path.join(ctx.testDirPath, "isolation-source");
        const isolationDirectory = path.join(
            ctx.testDirPath,
            "refresh-isolation",
        );
        await fs.mkdir(currentSource);
        await fs.mkdir(subSource);
        await fs.mkdir(isolationSource);
        await fs.mkdir(isolationDirectory);
        await fs.writeFile(
            path.join(currentSource, "current-output.txt"),
            "current extraction",
        );
        await fs.writeFile(
            path.join(subSource, "sub-output.txt"),
            "subdirectory extraction",
        );
        await fs.writeFile(
            path.join(isolationSource, "isolation-output.txt"),
            "isolated refresh",
        );
        await fs.writeFile(
            path.join(isolationDirectory, "unrelated.txt"),
            "unrelated listing",
        );
        await $`tar -czf ${path.join(ctx.testDirPath, "current sample.tar.gz")} -C ${currentSource} .`;
        await $`tar -czf ${path.join(ctx.testDirPath, "sub stuff.tgz")} -C ${subSource} .`;
        await $`tar -czf ${path.join(ctx.testDirPath, "isolation.tar.gz")} -C ${isolationSource} .`;
        await fs.rm(currentSource, { recursive: true });
        await fs.rm(subSource, { recursive: true });
        await fs.rm(isolationSource, { recursive: true });
        await fs.writeFile(
            path.join(ctx.testDirPath, "unsupported.txt"),
            "not an archive",
        );
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("extracts each destination in a fresh terminal", async ({ page }) => {
        await page.clock.install({
            time: new Date("2026-08-20T08:00:00Z"),
        });
        const terminalSockets: PlaywrightWebSocket[] = [];
        const terminalEvents: TerminalSocketEvent[][] = [];
        page.on("websocket", (socket) => {
            if (!socket.url().includes("/terminal/ws")) return;
            terminalSockets.push(socket);
            const socketEvents: TerminalSocketEvent[] = [];
            terminalEvents.push(socketEvents);
            socket.on("framereceived", (event) => {
                socketEvents.push({
                    direction: "received",
                    payload: terminalFrameSchema.parse(event.payload),
                });
            });
            socket.on("framesent", (event) => {
                socketEvents.push({
                    direction: "sent",
                    payload: terminalFrameSchema.parse(event.payload),
                });
            });
        });

        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);

        await page
            .getByRole("button", { name: "Actions for file unsupported.txt" })
            .click();
        // Unsupported rows must not advertise an extraction workflow.
        await expect(
            page.getByRole("button", { name: "Unarchive" }),
        ).toHaveCount(0);
        await page.keyboard.press("Escape");

        await page
            .getByRole("button", {
                name: "Actions for file current sample.tar.gz",
            })
            .click();
        // A recognized archive row exposes the new action in its own menu.
        await expect(
            page.getByRole("button", { name: "Unarchive" }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Unarchive" }).click();
        const currentDialog = page.getByRole("dialog", { name: "Unarchive" });
        // Accessible radios make every destination policy explicit before execution.
        await expect(
            currentDialog.getByRole("radio", { name: /Current directory/ }),
        ).toBeChecked();
        await expect(
            currentDialog.getByRole("radio", {
                name: /Subdirectory current sample/,
            }),
        ).toBeVisible();
        await expect(
            currentDialog.getByRole("radio", { name: /Custom directory/ }),
        ).toBeVisible();
        // Pause browser timers immediately before submission so both delay boundaries are exact.
        await page.clock.pauseAt(new Date("2026-08-20T10:00:00Z"));
        await currentDialog
            .getByRole("button", { name: "Unarchive", exact: true })
            .click();

        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        await page.clock.runFor(199);
        // Startup input must remain absent until the shell has settled for the full delay.
        expect(
            terminalEvents[0]?.filter(
                (event) =>
                    event.direction === "sent" &&
                    event.payload.includes(
                        "tar -xzf './current sample.tar.gz'",
                    ),
            ),
        ).toHaveLength(0);
        await page.clock.runFor(1);
        await expect
            .poll(() =>
                terminalEvents[0]
                    ?.filter((event) => event.direction === "sent")
                    .map((event) => event.payload)
                    .join(""),
            )
            .toContain("tar -xzf './current sample.tar.gz'");
        await expect
            .poll(async () =>
                fs
                    .readFile(
                        path.join(ctx.testDirPath, "current-output.txt"),
                        "utf8",
                    )
                    .catch(() => ""),
            )
            .toBe("current extraction");
        // The mounted listing must remain unchanged before its post-send refresh timer matures.
        await expect(
            page.getByRole("link", { name: "current-output.txt", exact: true }),
        ).toHaveCount(0);
        await page.getByRole("button", { name: "Close agent1_src 1" }).click();
        // Closing the terminal after a successful send must not cancel its earned refresh.
        await expect(
            page.getByRole("button", { name: "Close agent1_src 1" }),
        ).toHaveCount(0);
        await page.clock.runFor(999);
        // The refresh is intentionally delayed for one complete second after command delivery.
        await expect(
            page.getByRole("link", { name: "current-output.txt", exact: true }),
        ).toHaveCount(0);
        await page.clock.runFor(1);
        await page.clock.resume();
        // Refetching the exact originating query makes extracted entries appear without navigation.
        await expect(
            page.getByRole("link", { name: "current-output.txt", exact: true }),
        ).toBeVisible();
        // The terminal socket proves extraction starts in the archive's containing directory.
        expect(
            new URL(terminalSockets[0]?.url() ?? "").searchParams.get("cwd"),
        ).toBe(ctx.testDirPath);
        // Startup input must contain the generated archive-specific command rather than waiting for typing.
        const firstReadyIndex = terminalEvents[0]?.findIndex(
            (event) =>
                event.direction === "received" &&
                event.payload.includes('"type":"ready"'),
        );
        const firstCommandEvents = terminalEvents[0]?.filter(
            (event) =>
                event.direction === "sent" &&
                event.payload.includes("tar -xzf './current sample.tar.gz'"),
        );
        // The startup command must be sent once and only after the shell reports readiness.
        expect(firstReadyIndex).toBeGreaterThanOrEqual(0);
        expect(firstCommandEvents).toHaveLength(1);
        const firstCommandIndex = terminalEvents[0]?.findIndex(
            (event) =>
                event.direction === "sent" &&
                event.payload.includes("tar -xzf './current sample.tar.gz'"),
        );
        expect(firstCommandIndex).toBeGreaterThan(firstReadyIndex ?? -1);

        await page
            .getByRole("button", { name: "Actions for file sub stuff.tgz" })
            .click();
        await page.getByRole("button", { name: "Unarchive" }).click();
        const subDialog = page.getByRole("dialog", { name: "Unarchive" });
        await subDialog
            .getByRole("radio", { name: /Subdirectory sub stuff/ })
            .check();
        await subDialog
            .getByRole("button", { name: "Unarchive", exact: true })
            .click();

        await expect(
            page.getByRole("status", { name: "agent1_src 2: Connected" }),
        ).toBeVisible();
        await expect
            .poll(async () =>
                fs
                    .readFile(
                        path.join(
                            ctx.testDirPath,
                            "sub stuff",
                            "sub-output.txt",
                        ),
                        "utf8",
                    )
                    .catch(() => ""),
            )
            .toBe("subdirectory extraction");
        // Subdirectory extraction must also preserve the containing cwd.
        expect(
            new URL(terminalSockets[1]?.url() ?? "").searchParams.get("cwd"),
        ).toBe(ctx.testDirPath);
        // The startup command must create and target the suffix-stripped directory.
        const secondCommandEvents = terminalEvents[1]?.filter(
            (event) =>
                event.direction === "sent" &&
                event.payload.includes(
                    "mkdir -- './sub stuff' && tar -xzf './sub stuff.tgz' -C './sub stuff'",
                ),
        );
        // Each fresh terminal owns exactly one startup extraction command.
        expect(secondCommandEvents).toHaveLength(1);

        await page
            .getByRole("button", { name: "Actions for file sub stuff.tgz" })
            .click();
        await page.getByRole("button", { name: "Unarchive" }).click();
        const customDialog = page.getByRole("dialog", { name: "Unarchive" });
        // Each dialog opening resets to the safer current-directory default.
        await expect(
            customDialog.getByRole("radio", { name: /Current directory/ }),
        ).toBeChecked();
        await customDialog
            .getByRole("radio", { name: /Custom directory/ })
            .check();
        const customTarget = customDialog.getByRole("textbox", {
            name: "Target directory name",
        });
        // Selecting custom reveals a labeled field rather than an unlabeled path control.
        await expect(customTarget).toBeVisible();
        await customDialog
            .getByRole("button", { name: "Unarchive", exact: true })
            .click();
        // Empty custom names produce an actionable live dialog error.
        await expect(customDialog.getByRole("alert")).toHaveText(
            "Directory name is required",
        );
        await customTarget.fill("nested/name");
        await customDialog
            .getByRole("button", { name: "Unarchive", exact: true })
            .click();
        // A separator must not turn the custom child name into a nested path.
        await expect(customDialog.getByRole("alert")).toContainText(
            "without path separators",
        );
        await customTarget.fill("  custom output  ");
        await customDialog
            .getByRole("button", { name: "Unarchive", exact: true })
            .click();

        await expect(
            page.getByRole("status", { name: "agent1_src 3: Connected" }),
        ).toBeVisible();
        await expect
            .poll(async () =>
                fs
                    .readFile(
                        path.join(
                            ctx.testDirPath,
                            "custom output",
                            "sub-output.txt",
                        ),
                        "utf8",
                    )
                    .catch(() => ""),
            )
            .toBe("subdirectory extraction");
        // Custom extraction remains rooted at the archive's containing directory.
        expect(
            new URL(terminalSockets[2]?.url() ?? "").searchParams.get("cwd"),
        ).toBe(ctx.testDirPath);
        const customReadyIndex = terminalEvents[2]?.findIndex(
            (event) =>
                event.direction === "received" &&
                event.payload.includes('"type":"ready"'),
        );
        const customCommand =
            "mkdir -- './custom output' && tar -xzf './sub stuff.tgz' -C './custom output'";
        const customCommandEvents = terminalEvents[2]?.filter(
            (event) =>
                event.direction === "sent" &&
                event.payload.includes(customCommand),
        );
        const customCommandIndex = terminalEvents[2]?.findIndex(
            (event) =>
                event.direction === "sent" &&
                event.payload.includes(customCommand),
        );
        // A fresh custom terminal sends the normalized command exactly once after readiness.
        expect(customReadyIndex).toBeGreaterThanOrEqual(0);
        expect(customCommandEvents).toHaveLength(1);
        expect(customCommandIndex).toBeGreaterThan(customReadyIndex ?? -1);

        await page
            .getByRole("button", {
                name: "Actions for file current sample.tar.gz",
            })
            .click();
        await page.getByRole("button", { name: "Unarchive" }).click();
        await page
            .getByRole("dialog", { name: "Unarchive" })
            .getByRole("button", { name: "Unarchive", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 4: Connected" }),
        ).toBeVisible();
        // Repeating an action must allocate a fourth socket instead of reusing a matching cwd tab.
        expect(terminalSockets).toHaveLength(4);
    });

    test("refreshes only the originating listing after navigation", async ({
        page,
    }) => {
        await page.clock.install({
            time: new Date("2026-08-20T12:00:00Z"),
        });
        const listingRequests: string[] = [];
        page.on("request", (request) => {
            if (request.url().includes("/ls")) {
                listingRequests.push(request.url());
            }
        });
        const directoryUrl = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(directoryUrl);
        await page
            .getByRole("button", { name: "Actions for file isolation.tar.gz" })
            .click();
        await page.getByRole("button", { name: "Unarchive" }).click();
        await page.clock.pauseAt(new Date("2026-08-20T14:00:00Z"));
        await page
            .getByRole("dialog", { name: "Unarchive" })
            .getByRole("button", { name: "Unarchive", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: "agent1_src 1: Connected" }),
        ).toBeVisible();
        await page.clock.runFor(200);
        await expect
            .poll(async () =>
                fs
                    .readFile(
                        path.join(ctx.testDirPath, "isolation-output.txt"),
                        "utf8",
                    )
                    .catch(() => ""),
            )
            .toBe("isolated refresh");

        await page.goto(`${directoryUrl}/refresh-isolation`);
        // The unrelated route is fully loaded before the originating refresh matures.
        await expect(
            page.getByRole("link", { name: "unrelated.txt", exact: true }),
        ).toBeVisible();
        const requestsAfterNavigation = listingRequests.length;
        await page.clock.runFor(1000);
        // Exact query targeting must not refetch the currently mounted unrelated listing.
        expect(listingRequests).toHaveLength(requestsAfterNavigation);

        await page.clock.resume();
        await page.goto(directoryUrl);
        // Returning to the stale origin loads the extracted file without refreshing the wrong route.
        await expect(
            page.getByRole("link", {
                name: "isolation-output.txt",
                exact: true,
            }),
        ).toBeVisible();
    });
});
