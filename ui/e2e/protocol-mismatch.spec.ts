import { expect, test } from "./fixtures";

import { WEB_BASE_URL, upgradeWithProtocol } from "./helpers";

test.describe("Protocol mismatches", () => {
    test("lists agents refused for speaking another protocol", async ({
        page,
    }) => {
        const version = `0.0.0-mismatch-${Date.now()}`;

        // An agent of another protocol generation is refused before any socket exists.
        expect(await upgradeWithProtocol("redoor.v1", version)).toBe(426);

        await page.goto(`${WEB_BASE_URL}/agents`);

        const refused = page.getByRole("region", {
            name: "Refused agent connections",
        });

        // The refused agent never registers, so this list is the only place the UI shows it.
        await expect(refused).toBeVisible();
        // The agent's own version identifies which installation needs the upgrade.
        await expect(
            refused.getByRole("row").filter({ hasText: version }),
        ).toContainText("redoor.v1");
        // The explanation names the protocol the agent has to speak instead.
        await expect(refused).toContainText("redoor.v6");
    });
});
