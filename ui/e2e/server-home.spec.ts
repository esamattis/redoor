import { expect, test } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

test.describe("Server home", () => {
    test("keeps transfer totals available in a minimized bar", async ({
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

        const panel = page
            .getByRole("heading", { name: "Transfers" })
            .locator("xpath=ancestor::section");
        // The aggregate header keeps transfer state visible without opening the drawer.
        await expect(panel).toContainText(
            "3 downloading, 2 uploading, 38 completed, 1 errored",
        );
        // Starting minimized prevents transfer details from taking page space by default.
        await expect(
            panel.getByRole("button", { name: "Expand Transfers" }),
        ).toHaveAttribute("aria-expanded", "false");
        // The list is absent, rather than merely hidden, while the drawer is minimized.
        await expect(panel.getByRole("table")).toHaveCount(0);

        await panel
            .getByRole("button", { name: "Expand Transfers" })
            .press("Enter");

        // Expanding mounts only active transfer rows; history remains behind View all.
        await expect(panel.getByRole("row")).toHaveCount(6);
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
});

/** Builds deterministic transfer snapshots for the minimized-bar aggregate test. */
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
