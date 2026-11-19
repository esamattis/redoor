// Serial: the script and image approvals of previews are stored in the shared user settings.
import { expect, test, type Page } from "../fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiClient } from "#ui/api-client";
import { defaultUserState, userStateSchema } from "#ui/user-state";
import {
    API_BASE_URL,
    WEB_BASE_URL,
    deviceBrowserUrl,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "../helpers";

/**
 * The page reports what its script could do into its own text, so the test can read the
 * outcome through the frame. The script sits before the end marker, so once the marker is
 * visible the parser has already passed the script and it can no longer run late.
 */
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><title>Fixture page</title></head>
<body>
<h1>Sandboxed heading</h1>
<p id="status">Script did not run</p>
<p id="parent">Parent untested</p>
<p id="network">Network untested</p>
<script>
document.getElementById("status").textContent = "Script ran";
let parentAccess = "Parent reachable";
try {
    void window.parent.document.title;
} catch {
    parentAccess = "Parent blocked";
}
document.getElementById("parent").textContent = parentAccess;
fetch("/api/v1/agents").then(
    () => {
        document.getElementById("network").textContent = "Network reachable";
    },
    () => {
        document.getElementById("network").textContent = "Network blocked";
    },
);
</script>
<p>End of page</p>
</body>
</html>
`;

/**
 * A page with an image from a web address. Redoor's own logo is served without a session, so
 * it loads once the policy lets images reach the network.
 */
const IMAGE_PAGE = `<!DOCTYPE html>
<html lang="en">
<body>
<h1>Image page</h1>
<img id="remote" alt="Remote logo" src="${WEB_BASE_URL}/logo192.png">
</body>
</html>
`;

/** A drawing whose script rewrites its label, which only happens when the markup is in the page. */
const SVG_DRAWING = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50">
<text id="label" x="10" y="30">Drawing label</text>
<script>document.getElementById("label").textContent = "Script ran in SVG";</script>
</svg>
`;

/** Opens a file in the editor and switches it to its rendered preview. */
async function openPreview(page: Page, url: string) {
    await page.goto(url);
    // The editor is the default view of HTML and SVG, unlike markdown.
    await expect(page.getByLabel("File editor", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page).toHaveURL(`${url}?preview=true`);
}

/** Reads the stored approvals, so a test knows a toggle was saved before it reloads. */
async function storedApprovals(api: ApiClient) {
    const state = userStateSchema.parse((await api.getUserState()).state);

    return state.previewApprovals.map((approval) => ({
        path: approval.path,
        kind: approval.kind,
    }));
}

/** Whether the frame's image finished with pixels, which only happens when it was allowed. */
async function remoteImageLoaded(page: Page) {
    const frame = page
        .getByRole("region", { name: "HTML preview" })
        .getByTitle("HTML preview frame", { exact: true })
        .contentFrame();

    return frame
        .locator("#remote")
        .evaluate((image: HTMLImageElement) =>
            image.complete ? image.naturalWidth > 0 : null,
        );
}

test.describe.serial("Sandboxed HTML and SVG preview", () => {
    let ctx: TestContext;
    let api: ApiClient;
    let htmlPath: string;
    let htmlUrl: string;
    let imagePageUrl: string;
    let svgUrl: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("sandboxed-preview");
        api = new ApiClient(API_BASE_URL);
        await api.login("test-user", "test-password");
        htmlPath = path.join(ctx.testDirPath, "page.html");
        const imagePagePath = path.join(ctx.testDirPath, "images.html");
        const svgPath = path.join(ctx.testDirPath, "drawing.svg");
        await fs.writeFile(htmlPath, HTML_PAGE);
        await fs.writeFile(imagePagePath, IMAGE_PAGE);
        await fs.writeFile(svgPath, SVG_DRAWING);
        htmlUrl = deviceBrowserUrl(ctx.agentName, htmlPath);
        imagePageUrl = deviceBrowserUrl(ctx.agentName, imagePagePath);
        svgUrl = deviceBrowserUrl(ctx.agentName, svgPath);
    });

    test.beforeEach(async () => {
        // The test dir keeps its path between runs, so an approval from an earlier run would stay.
        await api.updateUserState({ state: defaultUserState });
    });

    test.afterAll(async () => {
        await api.updateUserState({ state: defaultUserState });
        await teardownTestDir(ctx.testDirPath);
    });

    test("renders HTML and runs its scripts only when enabled", async ({
        page,
    }) => {
        await openPreview(page, htmlUrl);

        const preview = page.getByRole("region", { name: "HTML preview" });

        const frameElement = preview.getByTitle("HTML preview frame", {
            exact: true,
        });

        const frame = frameElement.contentFrame();

        const scripts = preview.getByRole("button", {
            name: "Enable JavaScript",
        });

        // The page is rendered by the browser, not shown as source.
        await expect(
            frame.getByRole("heading", { name: "Sandboxed heading" }),
        ).toBeVisible();
        await expect(frame.getByText("End of page")).toBeVisible();
        // Scripts are off until the reader opts in, so the inline script must not have run.
        await expect(scripts).toHaveAttribute("aria-pressed", "false");
        await expect(frame.locator("#status")).toHaveText("Script did not run");
        // The policy alone would also stop the script, so the frame must carry the full sandbox.
        await expect(frameElement).toHaveAttribute("sandbox", "");

        await scripts.click();

        await expect(scripts).toHaveAttribute("aria-pressed", "true");
        // Scripts are the only thing the opt-in grants; the origin stays opaque.
        await expect(frameElement).toHaveAttribute("sandbox", "allow-scripts");
        // Enabling scripts recreates the frame, so the same page now runs its script.
        await expect(frame.locator("#status")).toHaveText("Script ran");
        // Even with scripts the page has an opaque origin and cannot touch redoor's page.
        await expect(frame.locator("#parent")).toHaveText("Parent blocked");
        // The policy blocks requests, including ones to the authenticated API.
        await expect(frame.locator("#network")).toHaveText("Network blocked");

        // The approval is stored for the file, so it must be saved before the page reloads.
        await expect
            .poll(() => storedApprovals(api))
            .toEqual([{ path: htmlPath, kind: "scripts" }]);
        await page.reload();
        await expect(frame.getByText("End of page")).toBeVisible();

        // A new visit of the approved file runs its scripts without asking again.
        await expect(scripts).toHaveAttribute("aria-pressed", "true");
        await expect(frame.locator("#status")).toHaveText("Script ran");

        await scripts.click();

        // Revoking forgets the approval rather than only turning scripts off for this visit.
        await expect.poll(() => storedApprovals(api)).toEqual([]);
        // Turning scripts off again must give a fresh page in which nothing ran.
        await expect(scripts).toHaveAttribute("aria-pressed", "false");
        await expect(frame.getByText("End of page")).toBeVisible();
        await expect(frame.locator("#status")).toHaveText("Script did not run");

        await preview.getByRole("button", { name: "Close preview" }).click();

        // Closing returns to the source the preview was built from.
        await expect(page).toHaveURL(`${htmlUrl}?preview=false`);
        await expect(
            page.getByLabel("File editor", { exact: true }),
        ).toBeVisible();
        await expect(preview).toHaveCount(0);
    });

    test("loads remote images in HTML only while approved", async ({
        page,
    }) => {
        await openPreview(page, imagePageUrl);

        const preview = page.getByRole("region", { name: "HTML preview" });
        const images = preview.getByRole("button", { name: "Show images" });

        // Without approval the policy refuses the image, so it ends without any pixels.
        await expect(images).toHaveAttribute("aria-pressed", "false");
        await expect.poll(() => remoteImageLoaded(page)).toBe(false);

        await images.click();

        // Approving lets the same page load its image from the network.
        await expect.poll(() => remoteImageLoaded(page)).toBe(true);
        await expect(
            preview.getByText("Sandboxed, images load from the network"),
        ).toBeVisible();
        await expect
            .poll(() => storedApprovals(api))
            .toEqual([
                {
                    path: path.join(ctx.testDirPath, "images.html"),
                    kind: "images",
                },
            ]);

        await page.reload();

        // The approval outlives the visit, so the image loads again without asking.
        await expect(images).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => remoteImageLoaded(page)).toBe(true);

        await images.click();

        // Revoking removes the stored approval and blocks the image again at once.
        await expect.poll(() => storedApprovals(api)).toEqual([]);
        await expect.poll(() => remoteImageLoaded(page)).toBe(false);
    });

    test("renders SVG as an image and inline when scripts are enabled", async ({
        page,
    }) => {
        await openPreview(page, svgUrl);

        const preview = page.getByRole("region", { name: "SVG preview" });

        const frame = preview
            .getByTitle("SVG preview frame", { exact: true })
            .contentFrame();

        // Without scripts the drawing is an image, where its script can never run.
        await expect(
            frame.getByRole("img", { name: "SVG drawing" }),
        ).toBeVisible();
        // The label is only in the frame's DOM when the markup is inlined.
        await expect(frame.locator("#label")).toHaveCount(0);

        await preview
            .getByRole("button", { name: "Enable JavaScript" })
            .click();

        // With scripts the markup is part of the page, so its script rewrites the label.
        await expect(frame.locator("#label")).toHaveText("Script ran in SVG");
        await expect(
            frame.getByRole("img", { name: "SVG drawing" }),
        ).toHaveCount(0);
    });
});
