import { expect, test, type Locator } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

test.describe("Server home", () => {
    test("keeps transfer progress available in a minimized bar", async ({
        page,
    }) => {
        await page.route("**/api/v1/transfers/progress", async (route) => {
            const transfers = [
                ...createTransfers(3, {
                    state: "active",
                    direction: "download",
                }),
                ...createTransfers(2, {
                    state: "active",
                    direction: "upload",
                    offset: 3,
                }),
                ...createTransfers(38, {
                    state: "completed",
                    direction: "download",
                    offset: 5,
                }),
                ...createTransfers(1, {
                    state: "errored",
                    direction: "upload",
                    offset: 43,
                }),
            ];
            await route.fulfill({ json: { transfers } });
        });

        await page.goto(`${WEB_BASE_URL}/`);

        const panel = page.getByRole("region", {
            name: "Application tools",
        });
        const transfersTab = panel.getByRole("tab", { name: /Transfers/ });
        // Active work prioritizes its completion percentage in the compact tab badge.
        await expect(transfersTab).toContainText("50%");
        // Starting minimized prevents transfer details from taking page space by default.
        await expect(
            panel.getByRole("button", { name: "Expand bottom drawer" }),
        ).toHaveAttribute("aria-expanded", "false");
        // The list is absent, rather than merely hidden, while the drawer is minimized.
        await expect(panel.getByRole("table")).toHaveCount(0);

        await transfersTab.press("Enter");

        // Expanding mounts only active transfer rows; history remains behind View all.
        await expect(panel.getByRole("row")).toHaveCount(6);
    });

    test("shows percent, speed, and remaining time on active transfers", async ({
        page,
    }) => {
        const startedAt = Math.floor(Date.now() / 1000) - 10;
        await page.route("**/api/v1/transfers/progress", async (route) => {
            await route.fulfill({
                json: {
                    transfers: [
                        {
                            request_id: 1,
                            agent_id: "agent-1",
                            path: "/tmp/active.bin",
                            source: null,
                            dest: null,
                            direction: "download",
                            total_bytes: 100_000_000,
                            transferred_bytes: 50_000_000,
                            started_at: startedAt,
                            ended_at: null,
                            state: "active",
                            error: null,
                        },
                    ],
                },
            });
        });

        await page.goto(`${WEB_BASE_URL}/`);
        const panel = page.getByRole("region", {
            name: "Application tools",
        });
        const transfersTab = panel.getByRole("tab", { name: /Transfers/ });
        // The only active transfer is also the one expected to finish last.
        await expect(transfersTab).toContainText(/\d+%/);
        await transfersTab.press("Enter");

        const progress = panel.getByRole("img", {
            name: /Transfer progress \d+% .+\/s/,
        });
        // Percent comes first so the row reads as completion, then rate, then ETA.
        await expect(progress).toHaveAttribute(
            "aria-label",
            /Transfer progress \d+% .+\/s .+ remaining$/,
        );
        const activeTransfer = panel
            .getByRole("row")
            .filter({ hasText: "active.bin" });
        // The visible row summary presents the same progress details as the accessible label.
        await expect(
            activeTransfer.getByText(/\d+% .+\/s .+ remaining$/),
        ).toBeVisible();
        // Labels next to the rate made finished and in-flight rows harder to scan.
        await expect(
            panel.getByText(/Current speed|Final speed|Speed:/),
        ).toHaveCount(0);
    });

    test("grows overlay scroll padding when the bottom drawer opens", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/`);

        const panel = page.getByRole("region", {
            name: "Application tools",
        });
        const scrollArea = page.getByRole("main");

        await expect(
            panel.getByRole("button", { name: "Expand bottom drawer" }),
        ).toBeVisible();

        // The minimized bar still needs a matching inset so the last page row is not covered.
        await expect
            .poll(async () => {
                const inset = await readBottomChromeHeight(scrollArea);
                const panelHeight = (await panel.boundingBox())?.height ?? 0;
                return Math.abs(inset - panelHeight);
            })
            .toBeLessThan(1);

        await panel.getByRole("tab", { name: "Terminal" }).click();
        await expect(
            panel.getByRole("button", { name: "Minimize bottom drawer" }),
        ).toBeVisible();

        // Opening the drawer must grow the inset so page content can scroll above the full panel.
        await expect
            .poll(async () => {
                const inset = await readBottomChromeHeight(scrollArea);
                const panelHeight = (await panel.boundingBox())?.height ?? 0;
                return {
                    matchesPanel: Math.abs(inset - panelHeight) < 1,
                    isExpanded: inset > 100,
                };
            })
            .toEqual({ matchesPanel: true, isExpanded: true });
    });

    test("renders a working hostname-defaulted agent config", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/`);

        const config = page.getByLabel("config.toml contents");
        await expect(config).toBeVisible();
        await expect(
            page.getByText("redoor agent --config config.toml", {
                exact: true,
            }),
        ).toBeVisible();

        const browserUrl = new URL(page.url());
        const serverProtocol =
            browserUrl.protocol === "https:" ? "https:" : "http:";
        const expectedConfig = `agent_token = "test-agent-token"

[agent]
server = "${serverProtocol}//${browserUrl.host}"
`;
        // Exact text proves the browser generated a complete config from the real token and its own origin.
        await expect(config).toHaveText(expectedConfig);
        // Omitting both options preserves hostname naming and conventional file logging defaults.
        expect(expectedConfig).not.toMatch(/^(name|log)\s*=/m);
    });

    test("lists agent names in a compact grid before server details", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/`);

        const agentNames = page.getByRole("region", { name: "Agent names" });
        const serverHeading = page.getByRole("heading", {
            name: "Server",
            exact: true,
        });
        const appName = page.getByRole("heading", { name: "App name" });
        const firstAgent = agentNames.getByRole("link", {
            name: "agent1_src",
            exact: true,
        });
        const secondAgent = agentNames.getByRole("link", {
            name: "agent2_custom",
            exact: true,
        });

        // Names sit above identity details so operators can jump to an agent first.
        const agentBox = await agentNames.boundingBox();
        const appNameBox = await appName.boundingBox();
        expect(agentBox?.y ?? 1).toBeLessThan(appNameBox?.y ?? 0);
        // App name is a card section rather than a badge beside the Server heading.
        await expect(appName).toBeVisible();
        await expect(serverHeading).toBeVisible();

        // The persistent desktop sidebar already shows agents, so no extra drawer control.
        await expect(
            page.getByRole("button", { name: "Open agent sidebar" }),
        ).toHaveCount(0);

        // Several names share a row instead of stacking as a single-column list.
        const firstBox = await firstAgent.boundingBox();
        const secondBox = await secondAgent.boundingBox();
        expect(Math.abs((firstBox?.y ?? 0) - (secondBox?.y ?? 1))).toBeLessThan(
            8,
        );

        await firstAgent.click();
        // A name is a shortcut to that agent's own home.
        await expect(page).toHaveURL(/\/agents\/[^/]+$/);
        await expect(
            page.getByRole("heading", { name: "Agent name" }),
        ).toContainText("agent1_src");
    });

    test("opens the agent sidebar from the home agent list on narrow viewports", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${WEB_BASE_URL}/`);

        const agentNames = page.getByRole("region", { name: "Agent names" });
        const openSidebar = agentNames.getByRole("button", {
            name: "Open agent sidebar",
        });
        // The persistent right sidebar is gone, so the list must expose a drawer control.
        await expect(openSidebar).toBeVisible();
        await openSidebar.click();

        const agentMenu = page.getByRole("dialog", { name: "Agent menu" });
        // The home control must open the same drawer as the top-bar trigger.
        await expect(agentMenu).toBeVisible();
        await expect(
            agentMenu.getByRole("navigation", { name: "Agents" }),
        ).toBeVisible();
    });
});

/** Reads the measured overlay inset used to keep page content above the drawer. */
async function readBottomChromeHeight(scrollArea: Locator) {
    return scrollArea.evaluate((element) =>
        Number.parseFloat(
            getComputedStyle(element).getPropertyValue(
                "--bottom-chrome-height",
            ),
        ),
    );
}

/** Builds deterministic transfer snapshots for the minimized-bar progress test. */
function createTransfers(
    count: number,
    options: {
        state: "active" | "completed" | "errored";
        direction: "download" | "upload" | "copy";
        offset?: number;
    },
) {
    const offset = options?.offset ?? 0;
    return Array.from({ length: count }, (_value, index) => ({
        request_id: offset + index + 1,
        agent_id: "agent-1",
        path: `/tmp/transfer-${offset + index + 1}`,
        source: null,
        dest: null,
        direction: options.direction,
        total_bytes: 100,
        transferred_bytes: options.state === "completed" ? 100 : 50,
        started_at: 1,
        ended_at: options.state === "active" ? null : 2,
        state: options.state,
        error: options.state === "errored" ? "Transfer failed" : null,
    }));
}
