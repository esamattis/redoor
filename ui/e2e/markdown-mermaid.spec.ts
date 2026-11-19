import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";
import {
    deviceBrowserUrl,
    setupTestDir,
    teardownTestDir,
    type TestContext,
} from "./helpers";

test.describe.serial("Markdown preview Mermaid diagrams", () => {
    let ctx: TestContext;
    let markdownUrl: string;

    test.beforeAll(async () => {
        ctx = await setupTestDir("markdown-mermaid");
        const markdownPath = path.join(ctx.testDirPath, "README.md");
        await fs.writeFile(
            markdownPath,
            `# Diagrams

${"```mermaid"}
flowchart LR
    accTitle: Login flow
    Start --> Finish
${"```"}

${"```mermaid"}
flowchart LR
    Broken -->
${"```"}
`,
        );
        markdownUrl = deviceBrowserUrl(ctx.agentName, markdownPath);
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("draws mermaid fences as images and shows parse errors", async ({
        page,
    }) => {
        await page.goto(markdownUrl);

        const preview = page.getByRole("region", { name: "Markdown preview" });
        const diagram = preview.getByRole("img", { name: "Login flow" });

        // The fence becomes a drawing named by its accTitle instead of staying code.
        await expect(diagram).toBeVisible();
        // The drawing decodes to pixels, proving the frame returned a valid SVG image.
        await expect
            .poll(() =>
                diagram.evaluate((image: HTMLImageElement) =>
                    image.complete ? image.naturalWidth > 0 : null,
                ),
            )
            .toBe(true);
        // Diagrams are read, not copied, so their fences get no copy button.
        await expect(
            preview.getByRole("button", { name: "Copy code" }),
        ).toHaveCount(0);
        // The source of a drawn diagram no longer shows as code.
        await expect(preview.getByText("Start --> Finish")).toHaveCount(0);

        // A diagram that does not parse explains why and keeps its source for fixing.
        await expect(preview.getByRole("alert")).toContainText(
            "Mermaid diagram failed",
        );
        await expect(
            preview.locator("pre code", { hasText: "Broken -->" }),
        ).toBeVisible();

        await preview
            .getByRole("button", { name: "View diagram in full window" })
            .click();

        const fullWindow = page.getByRole("dialog", { name: "Login flow" });

        // The full window view shows the same drawing, scaled to the window.
        await expect(
            fullWindow.getByRole("img", { name: "Login flow" }),
        ).toBeVisible();

        const zoomable = fullWindow.getByRole("group", {
            name: "Login flow, zoomable",
        });

        const reset = fullWindow.getByRole("button", {
            name: "Reset zoom and position",
        });

        const box = await zoomable.boundingBox();

        if (box === null) {
            throw new Error("The zoomable view has no layout");
        }

        // The view starts fitted, so there is nothing to reset.
        await expect(fullWindow.getByText("100%")).toBeVisible();
        await expect(reset).toBeDisabled();

        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -500);

        // Scrolling the wheel up zooms in instead of scrolling the page.
        await expect(fullWindow.getByText("100%")).toHaveCount(0);

        await reset.click();
        await expect(fullWindow.getByText("100%")).toBeVisible();

        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 80, box.y + 40, {
            steps: 4,
        });
        await page.mouse.up();

        // Dragging pans the diagram, which leaves a position to reset while the zoom stays.
        await expect(reset).toBeEnabled();
        await expect(fullWindow.getByText("100%")).toBeVisible();

        await page.keyboard.press("Escape");

        // Escape returns to the preview, like every other dialog.
        await expect(fullWindow).toBeHidden();

        // Mermaid runs only in a frame with scripts but an opaque origin, never on redoor's.
        await expect(
            page.locator('iframe[title="Mermaid renderer"]'),
        ).toHaveAttribute("sandbox", "allow-scripts");
    });

    test("drops a renderer frame that navigates away", async ({ page }) => {
        await page.goto(markdownUrl);
        await expect(
            page.getByRole("img", { name: "Login flow" }),
        ).toBeVisible();

        const renderer = page
            .frames()
            .find((frame) => frame.url() === "about:srcdoc");

        if (renderer === undefined) {
            throw new Error("The Mermaid renderer frame did not start");
        }

        // Stands in for a renderer compromised through a Mermaid sanitizer bypass.
        await renderer.evaluate(() => {
            window.location.href = "data:text/html,<p>Replacement</p>";
        });

        // A navigated frame must never be sent another diagram source, so it is removed.
        await expect(
            page.locator('iframe[title="Mermaid renderer"]'),
        ).toHaveCount(0);
    });
});
