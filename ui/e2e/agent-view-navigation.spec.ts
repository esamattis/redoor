import { expect, test } from "@playwright/test";

import {
    encodeFilesystemPath,
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe("Agent view navigation", () => {
    let context: TestContext;

    test.beforeAll(async () => {
        context = await setupTestDir("agent-view-navigation");
    });

    test.afterAll(async () => {
        await teardownTestDir(context.testDirPath);
    });

    test("switches connected agent views and selects an agent from the mobile drawer", async ({
        page,
    }) => {
        await page.setViewportSize({ width: 360, height: 844 });
        await page.goto(`${WEB_BASE_URL}/agents/${context.agentId}`);

        const agentView = page.getByLabel("Agent view");
        const agentLink = agentView.getByRole("link", {
            name: "Agent",
            exact: true,
        });
        const agentViewScroll = await agentView.evaluate((element) => {
            element.scrollLeft = element.scrollWidth;
            return {
                clientWidth: element.clientWidth,
                scrollLeft: element.scrollLeft,
                scrollWidth: element.scrollWidth,
            };
        });
        // The tab strip under the touch point must own the mobile overflow.
        expect(agentViewScroll.scrollWidth).toBeGreaterThan(
            agentViewScroll.clientWidth,
        );
        // Moving the tab strip itself proves the overflow is not stranded on its parent.
        expect(agentViewScroll.scrollLeft).toBeGreaterThan(0);
        // Agent details must be represented by the first current contextual top tab.
        await expect(agentLink).toHaveAttribute("aria-current", "page");
        await expect(agentView.getByRole("link").first()).toHaveText("Agent");

        await agentView
            .getByRole("link", { name: "Files", exact: true })
            .click();
        // Files must open the connected agent's published browser location.
        await expect(page).toHaveURL(context.agentBrowserUrl);
        const browserAgentView = page.getByLabel("Agent view");
        // Browser routes retain the global Files destination and identify it as current.
        await expect(
            browserAgentView.getByRole("link", {
                name: "Files",
                exact: true,
            }),
        ).toHaveAttribute("aria-current", "page");
        const homeBox = await page
            .getByRole("link", { name: "Agent home" })
            .boundingBox();
        const upBox = await page
            .getByRole("link", { name: "Go to the parent directory" })
            .boundingBox();
        const breadcrumbsBox = await page
            .getByRole("navigation", { name: "Breadcrumbs" })
            .boundingBox();
        // Path controls must read from home to parent navigation and then breadcrumbs.
        expect(homeBox?.x ?? 1).toBeLessThan(upBox?.x ?? 0);
        expect(upBox?.x ?? 1).toBeLessThan(breadcrumbsBox?.x ?? 0);
        const filesActions = page.getByLabel("Files view actions");
        const uploadBox = await filesActions
            .getByRole("button", { name: "Upload", exact: true })
            .boundingBox();
        const downloadBox = await filesActions
            .getByRole("link", { name: "Download", exact: true })
            .boundingBox();
        const moreBox = await filesActions
            .getByRole("button", { name: "More", exact: true })
            .boundingBox();
        // Upload, Download, and overflow actions must remain on one horizontally scrollable row.
        const uploadCenter = (uploadBox?.y ?? 0) + (uploadBox?.height ?? 0) / 2;
        expect(
            (downloadBox?.y ?? 0) + (downloadBox?.height ?? 0) / 2,
        ).toBeCloseTo(uploadCenter);
        expect((moreBox?.y ?? 0) + (moreBox?.height ?? 0) / 2).toBeCloseTo(
            uploadCenter,
        );
        await page.goto(
            `${WEB_BASE_URL}/agents/${context.agentId}/browser/${encodeFilesystemPath(`${context.testDirPath}/file1.txt`)}`,
        );
        const fileView = page.getByLabel("File view");
        const fileViewScroll = await fileView.evaluate((element) => {
            element.scrollLeft = element.scrollWidth;
            return {
                clientWidth: element.clientWidth,
                scrollLeft: element.scrollLeft,
                scrollWidth: element.scrollWidth,
            };
        });
        // File representation tabs must use the same touch-scrollable strip.
        expect(fileViewScroll.scrollWidth).toBeGreaterThan(
            fileViewScroll.clientWidth,
        );
        // The final file tab must be reachable by horizontal scrolling on mobile.
        expect(fileViewScroll.scrollLeft).toBeGreaterThan(0);
        await browserAgentView
            .getByRole("link", { name: "Agent", exact: true })
            .click();
        // Returning to the agent page must restore the Agent tab as current.
        await expect(page).toHaveURL(new RegExp(`/agents/${context.agentId}$`));
        await expect(agentLink).toHaveAttribute("aria-current", "page");

        const logsLink = agentView.getByRole("link", {
            name: "Logs",
            exact: true,
        });
        // Agent logs must remain the final contextual tab on the agent page.
        await expect(agentView.getByRole("link").last()).toHaveText("Logs");
        await logsLink.click();
        // The logs route must keep the tab strip visible and mark Logs as current.
        await expect(page).toHaveURL(
            new RegExp(`/agents/${context.agentId}/logs$`),
        );
        await expect(logsLink).toHaveAttribute("aria-current", "page");

        await page.getByRole("button", { name: "Open agent menu" }).click();
        const agentDialog = page.getByRole("dialog", { name: "Agent menu" });
        await agentDialog
            .getByRole("link", { name: "agent2_custom, connected" })
            .click();
        // Selecting an agent must navigate and dismiss the mobile drawer.
        await expect(page).toHaveURL(
            new RegExp(`/agents/${context.agent2Id}/browser/`),
        );
        await expect(agentDialog).toBeHidden();
    });
});
