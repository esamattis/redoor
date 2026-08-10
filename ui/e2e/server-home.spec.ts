import { expect, test } from "@playwright/test";

import { WEB_BASE_URL } from "./helpers";

test.describe("Server home", () => {
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
