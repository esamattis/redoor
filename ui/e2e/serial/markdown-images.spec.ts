// Serial: image approvals of markdown previews are stored in the shared user settings.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../fixtures";
import type { Page } from "../fixtures";
import { ApiClient } from "#ui/api-client";
import {
    PREVIEW_APPROVAL_TTL_MS,
    defaultUserState,
    userStateSchema,
} from "#ui/user-state";
import {
    API_BASE_URL,
    deviceBrowserUrl,
    setupTestDir,
    teardownTestDir,
} from "../helpers";
import type { TestContext } from "../helpers";

/** Reads the stored approvals, so a test knows a toggle was saved before it reloads. */
async function storedApprovals(api: ApiClient) {
    const state = userStateSchema.parse((await api.getUserState()).state);

    return state.previewApprovals.map((approval) => ({
        path: approval.path,
        kind: approval.kind,
    }));
}

/** Whether the shown image finished with pixels, proving the device served the file. */
async function imageLoaded(page: Page) {
    return page
        .getByRole("img", { name: "Logo", exact: true })
        .evaluate((image: HTMLImageElement) =>
            image.complete ? image.naturalWidth > 0 : null,
        );
}

test.describe.serial("Markdown preview images", () => {
    let ctx: TestContext;
    let api: ApiClient;
    let markdownPath: string;
    let markdownUrl: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("markdown-images");
        api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        const docs = path.join(ctx.testDirPath, "docs");
        await fs.mkdir(path.join(ctx.testDirPath, "assets"));
        await fs.mkdir(docs);
        await fs.copyFile(
            path.join(import.meta.dirname, "../../public/logo192.png"),
            path.join(ctx.testDirPath, "assets", "logo.png"),
        );
        markdownPath = path.join(docs, "README.md");
        await fs.writeFile(
            markdownPath,
            `# Images

![Logo](../assets/logo.png)

<details><summary>Embedded HTML</summary>Inside details</details>
`,
        );
        markdownUrl = deviceBrowserUrl(ctx.agentName, markdownPath);
    });

    test.beforeEach(async () => {
        // The test dir keeps its path between runs, so an approval from an earlier run would stay.
        await api.updateUserState({ state: defaultUserState });
    });

    test.afterAll(async () => {
        await api.updateUserState({ state: defaultUserState });
        await teardownTestDir(ctx.testDirPath);
    });

    test("shows images once approved and hides them again when revoked", async ({
        page,
    }) => {
        await page.goto(markdownUrl);

        const preview = page.getByRole("region", { name: "Markdown preview" });
        const toggle = preview.getByRole("button", { name: "Show images" });

        // Embedded HTML renders as elements, not escaped source.
        await expect(preview.getByText("Embedded HTML")).toBeVisible();
        // A new file's images are never fetched, only described.
        await expect(
            preview.getByRole("img", { name: "Hidden image: Logo" }),
        ).toBeVisible();
        await expect(preview.getByText("1 image hidden")).toBeVisible();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");

        await toggle.click();

        // The relative image is served from the device next to the document.
        await expect.poll(() => imageLoaded(page)).toBe(true);
        await expect
            .poll(() => storedApprovals(api))
            .toEqual([{ path: markdownPath, kind: "images" }]);

        await page.reload();

        // The approval is remembered, so the next visit shows the image without asking.
        await expect(toggle).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => imageLoaded(page)).toBe(true);

        await toggle.click();

        // Revoking forgets the approval and puts the placeholder back at once.
        await expect.poll(() => storedApprovals(api)).toEqual([]);
        await expect(
            preview.getByRole("img", { name: "Hidden image: Logo" }),
        ).toBeVisible();

        await page.reload();

        // A revoked file starts hidden again on the next visit.
        await expect(
            preview.getByRole("img", { name: "Hidden image: Logo" }),
        ).toBeVisible();
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
    });

    test("asks again once an approval is older than its lifetime", async ({
        page,
    }) => {
        await api.updateUserState({
            state: {
                ...defaultUserState,
                previewApprovals: [
                    {
                        agentId: ctx.agentId,
                        path: markdownPath,
                        kind: "images",
                        // Aged instead of waiting, so the lapse is tested without real time.
                        approvedAt: Date.now() - PREVIEW_APPROVAL_TTL_MS - 1000,
                    },
                ],
            },
        });

        await page.goto(markdownUrl);

        const preview = page.getByRole("region", { name: "Markdown preview" });

        // A lapsed approval counts as never given, so the image stays hidden.
        await expect(
            preview.getByRole("img", { name: "Hidden image: Logo" }),
        ).toBeVisible();
        await expect(
            preview.getByRole("button", { name: "Show images" }),
        ).toHaveAttribute("aria-pressed", "false");
    });
});
