import path from "node:path";
import { expect, test } from "@playwright/test";

import type { AgentListResponse } from "#bindings/AgentListResponse";
import { ApiClient } from "#ui/api-client";
import {
    API_BASE_URL,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";
import { dragReorderRow, waitForKeyboardSensor } from "./reorder";

test.describe.serial("Device order", () => {
    let ctx: TestContext;

    test.beforeAll(async () => {
        ctx = await setupTestDir("device-order");
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test.afterEach(async () => {
        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        await api.updateUserState({
            state: {
                showHiddenFiles: true,
                theme: "system",
                bookmarks: [],
                pinnedFiles: [],
                vimMode: false,
                wrapEditorLines: false,
                recursiveSearchTimeoutSeconds: 5,
                recursiveSearchIncludeHidden: false,
                recursiveSearchRespectGitignore: true,
                deviceOrder: [],
            },
        });
    });

    test("reorders devices with their bookmarks and restores the saved slots", async ({
        page,
    }) => {
        const extraId = "drag-order-extra";
        await page.setViewportSize({ width: 1440, height: 1200 });
        const extraName = "zzz-extra";
        const inventory = { includeExtra: true, extraName };
        await page.route("**/api/v1/agents", async (route) => {
            const url = new URL(route.request().url());
            if (
                route.request().method() !== "GET" ||
                url.pathname !== "/api/v1/agents"
            ) {
                await route.continue();
                return;
            }
            const response = await route.fetch();
            const body: AgentListResponse = await response.json();
            if (inventory.includeExtra) {
                const template = body.agents[0];
                if (!template) {
                    throw new Error("Expected at least one agent to clone");
                }
                body.agents.push({
                    ...template,
                    id: extraId,
                    name: inventory.extraName,
                    status: "disconnected",
                    cwd: null,
                    managed: false,
                    configuration_editable: false,
                    ssh_target: null,
                    connection_id: null,
                    connected_at: null,
                });
            }
            await route.fulfill({ json: body });
        });

        const api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        const bookmarks = Array.from({ length: 8 }, (_, index) => ({
            agentId: ctx.agentId,
            path: path.join(ctx.testDirPath, `mark-${index}.txt`),
            name: `mark-${index}.txt`,
            entryType: "file" as const,
        }));
        await api.updateUserState({
            state: {
                bookmarks,
                deviceOrder: [],
            },
        });
        const destination = `${WEB_BASE_URL}/agents/${ctx.agentId}/browser/${ctx.testDirUrlPath}`;
        await page.goto(destination);

        const realAgents = await api.listAgents();
        const deviceList = page.getByRole("list", { name: "Device list" });
        const devices = deviceList.getByRole("listitem", { name: /^Device / });
        await expect(devices).toHaveCount(realAgents.length + 1);
        const before = await devices.evaluateAll((items) =>
            items.map((item) => item.getAttribute("aria-label")),
        );
        const tall = deviceList.getByRole("listitem", {
            name: `Device ${ctx.agentName}`,
        });
        // A tall bookmark group must travel with its device rather than becoming a device row.
        await expect(
            tall.getByRole("link", { name: "mark-7.txt" }),
        ).toBeVisible();
        await dragReorderRow(
            page,
            devices.last(),
            devices.nth(0).getByRole("link").first(),
        );
        await expect(devices.nth(0)).toHaveAccessibleName(
            `Device ${extraName}`,
        );
        await expect(devices.nth(1)).toHaveAccessibleName(before[0] ?? "");
        await expect(page).toHaveURL(destination);
        await expect
            .poll(async () => (await api.getUserState()).state)
            .toMatchObject({
                deviceOrder: [extraId, ...realAgents.map((agent) => agent.id)],
                bookmarks,
            });

        inventory.includeExtra = false;
        await page.reload();
        // An unavailable id stays saved but must not render a phantom row.
        await expect(
            deviceList.getByRole("listitem", { name: `Device ${extraName}` }),
        ).toHaveCount(0);
        expect((await api.getUserState()).state).toMatchObject({
            deviceOrder: [extraId, ...realAgents.map((agent) => agent.id)],
        });
        inventory.includeExtra = true;
        inventory.extraName = "zzz-renamed";
        await page.reload();
        // A rename keeps the id slot instead of appending the device as new.
        await expect(devices.nth(0)).toHaveAccessibleName("Device zzz-renamed");
        await devices
            .filter({ hasText: ctx.agentName })
            .getByRole("link", { name: new RegExp(ctx.agentName) })
            .click();
        await expect(page).toHaveURL(destination);
    });

    test("cancels a device drag from the drawer without dismissing it", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${WEB_BASE_URL}/`);
        const trigger = page.getByRole("button", { name: "Open device menu" });
        await trigger.click();
        const dialog = page.getByRole("dialog", { name: "Device menu" });
        const handle = dialog
            .getByRole("listitem", { name: /^Device / })
            .first();
        await handle.focus();
        await page.keyboard.press("Space");
        await expect(handle).toHaveAttribute("data-dragging", "true");
        // The keyboard sensor attaches after pickup, so wait for its announcement before cancelling.
        await expect(
            dialog.getByLabel("Devices reorder announcement"),
        ).toContainText(/Picked up|position/);
        await waitForKeyboardSensor(page);
        await page.keyboard.press("Escape");
        // The first Escape cancels sorting and must leave the modal open.
        await expect(dialog).toBeVisible();
        await expect(handle).toHaveAttribute("data-dragging", "false");
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
    });
});
