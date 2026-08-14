import { expect, test } from "@playwright/test";

import {
    WEB_BASE_URL,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

let context: TestContext;

test.describe.serial("Agent home", () => {
    test.beforeAll(async () => {
        context = await setupTestDir("agent-home");
    });

    test.afterAll(async () => {
        await teardownTestDir(context.testDirPath);
    });

    test("shows mount capacity and opens mount paths in the file browser", async ({
        page,
    }) => {
        await page.goto(`${WEB_BASE_URL}/agents/${context.agentId}`);

        const mounts = page.getByRole("region", { name: "Mount Points" });
        await expect(mounts).toBeVisible();
        // Column labels prove the section exposes both capacity values and filesystem format.
        await expect(
            mounts.getByRole("columnheader", { name: "Available / Total" }),
        ).toBeVisible();
        await expect(
            mounts.getByRole("columnheader", { name: "Type" }),
        ).toBeVisible();
        // Defensive rendering must hide pseudo-filesystems even if an older agent reports them.
        for (const hiddenType of [
            "devpts",
            "devtmpfs",
            "proc",
            "fuse.lxcfs",
            "sysfs",
            "efivarfs",
            "cgroup2",
            "fusectl",
            "pstore",
            "debugfs",
            "securityfs",
            "tmpfs",
            "mqueue",
            "binfmt_misc",
        ]) {
            await expect(
                mounts.getByText(hiddenType, { exact: true }),
            ).toHaveCount(0);
        }

        const rootMount = mounts.getByRole("link", {
            name: "Browse mount point /",
            exact: true,
        });
        // Linux agents must expose the root mount as a browser destination.
        await expect(rootMount).toBeVisible();
        await rootMount.click();
        // Clicking the path must use the existing root browser route rather than a raw file URL.
        await expect(page).toHaveURL(
            new RegExp(`/agents/${context.agentId}/browser/?$`),
        );
    });
});
