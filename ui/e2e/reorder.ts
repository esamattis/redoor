import { expect, type Locator, type Page } from "@playwright/test";

/** Waits for the pickup paint and the library's deferred keyboard listener attachment. */
export async function waitForKeyboardSensor(page: Page) {
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                );
            }),
    );
}

/** Drives the mouse sensor across its distance threshold instead of using native drag-and-drop. */
export async function dragReorderHandle(
    page: Page,
    handle: Locator,
    target: Locator,
) {
    await handle.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    const start = await handle.boundingBox();
    const end = await target.boundingBox();
    const destination = await target.evaluate((element) => {
        const row = element.closest("li");
        return row?.parentElement
            ? Array.from(row.parentElement.children).indexOf(row) + 1
            : 0;
    });
    if (!start || !end) {
        throw new Error("Reorder drag needs a visible handle and target");
    }
    const startX = start.x + start.width / 2;
    const startY = start.y + start.height / 2;
    const endX = end.x + end.width / 2;
    const endY = end.y + end.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 8, startY);
    // The drag listeners attach after activation, so wait before the real move.
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    const steps = 24;
    for (let step = 1; step <= steps; step += 1) {
        await page.mouse.move(
            startX + ((endX - startX) * step) / steps,
            startY + ((endY - startY) * step) / steps,
        );
    }
    // Confirm collision feedback has reached the target before releasing the pointer.
    await expect(
        page
            .getByLabel(/reorder announcement$/)
            .filter({ hasText: `position ${destination} of` })
            .first(),
    ).toBeAttached();
    await page.mouse.up();
}

/** Picks up a grip from the keyboard and moves it along the list axis. */
export async function keyboardReorder(
    page: Page,
    handle: Locator,
    move: {
        key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
        times: number;
    },
) {
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    // Wait for pickup feedback before sending keys to the asynchronously attached sensor.
    const announcement = page
        .getByLabel(/reorder announcement$/)
        .filter({ hasText: /Picked up|position/ })
        .first();
    await expect(announcement).toBeAttached();
    await waitForKeyboardSensor(page);
    for (let step = 0; step < move.times; step += 1) {
        const previous = await announcement.textContent();
        await page.keyboard.press(move.key);
        // Wait for the destination preview so dropping cannot race its collision update.
        await expect(announcement).not.toHaveText(previous ?? "");
    }
    await page.keyboard.press("Space");
    await expect(handle).not.toHaveAttribute("aria-pressed", "true");
}
