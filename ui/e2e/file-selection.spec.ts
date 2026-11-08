import { test, expect } from "./fixtures";
import fs from "node:fs/promises";
import path from "node:path";
import {
    setupTestDir,
    teardownTestDir,
    WEB_BASE_URL,
    type TestContext,
} from "./helpers";

test.describe("File range selection", () => {
    let ctx: TestContext;

    const names = [
        "range-a.txt",
        "range-b.txt",
        "range-c.txt",
        "range-d.txt",
    ] as const;

    test.beforeAll(async () => {
        ctx = await setupTestDir("range-selection");
        await Promise.all(
            names.map((name) =>
                fs.writeFile(path.join(ctx.testDirPath, name), name),
            ),
        );
    });

    test.afterAll(async () => {
        await teardownTestDir(ctx.testDirPath);
    });

    test("selects and deselects ranges without disturbing other selections", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );

        // Locate by row because a checkbox's accessible name changes when selected.
        const checkbox = (name: string) =>
            page
                .getByRole("row", { name: `File entry ${name}`, exact: true })
                .getByRole("checkbox");

        await checkbox("file1.txt").click();
        await checkbox(names[0]).click();
        await checkbox(names[3]).click({ modifiers: ["Shift"] });

        for (const name of names) {
            // Both endpoints and every intervening file must join the selection.
            await expect(checkbox(name)).toBeChecked();
        }

        await checkbox(names[3]).click();
        await checkbox(names[1]).click({ modifiers: ["Shift"] });

        for (const name of names.slice(1)) {
            // Reverse Shift-click must apply deselection to the whole range too.
            await expect(checkbox(name)).not.toBeChecked();
        }

        // Selections outside the affected range must survive both operations.
        await expect(checkbox(names[0])).toBeChecked();
        await expect(checkbox("file1.txt")).toBeChecked();
    });

    test("uses visible sorted rows and handles Shift-click without an anchor", async ({
        page,
    }) => {
        await page.goto(
            `${WEB_BASE_URL}/agents/${ctx.agentName}/browser/${ctx.testDirUrlPath}`,
        );

        // Locate by row so the same locator survives checkbox state changes.
        const checkbox = (name: string) =>
            page
                .getByRole("row", { name: `File entry ${name}`, exact: true })
                .getByRole("checkbox");

        await checkbox(names[3]).click({ modifiers: ["Shift"] });
        // An initial Shift-click must still select its target normally.
        await expect(checkbox(names[3])).toBeChecked();
        await expect(checkbox(names[2])).not.toBeChecked();

        await page
            .getByRole("button", {
                name: "Sort by Name ascending",
                exact: true,
            })
            .click();
        await page
            .getByRole("button", {
                name: "Sort by Name descending",
                exact: true,
            })
            .click();
        await page
            .getByRole("searchbox", { name: "Filter files", exact: true })
            .fill("range-");
        await checkbox(names[1]).click({ modifiers: ["Shift"] });
        // Descending order must select the same visible interval in reverse.
        await expect(checkbox(names[3])).toBeChecked();
        await expect(checkbox(names[2])).toBeChecked();
        await expect(checkbox(names[1])).toBeChecked();
        await expect(checkbox(names[0])).not.toBeChecked();

        await page
            .getByRole("searchbox", { name: "Filter files", exact: true })
            .fill("range-a");
        await checkbox(names[0]).click({ modifiers: ["Shift"] });
        // A filtered-out anchor must fall back to the clicked item rather than selecting hidden rows.
        await expect(checkbox(names[0])).toBeChecked();
        await page
            .getByRole("searchbox", { name: "Filter files", exact: true })
            .clear();
        // Filtered-out unrelated rows must never be pulled into a range.
        await expect(checkbox("file1.txt")).not.toBeChecked();
        await expect(checkbox("file2.txt")).not.toBeChecked();
    });
});
