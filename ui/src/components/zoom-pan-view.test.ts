import { expect, test } from "vitest";
import { IDENTITY_TRANSFORM, applyZoomPanGesture } from "./zoom-pan-view";

/** Where a content point lands on screen under a transform. */
function screenPoint(
    transform: { x: number; y: number; scale: number },
    content: { x: number; y: number },
) {
    return {
        x: transform.x + content.x * transform.scale,
        y: transform.y + content.y * transform.scale,
    };
}

test("zooming keeps the point under the cursor in place", () => {
    const cursor = { x: 120, y: 80 };

    const zoomed = applyZoomPanGesture({
        transform: IDENTITY_TRANSFORM,
        from: cursor,
        to: cursor,
        factor: 2,
    });

    // The detail the reader aimed at must not slide away while zooming into it.
    expect(zoomed.scale).toBe(2);
    expect(screenPoint(zoomed, { x: 120, y: 80 })).toEqual(cursor);
});

test("a pinch zooms around its center and pans with it", () => {
    const zoomed = applyZoomPanGesture({
        transform: IDENTITY_TRANSFORM,
        from: { x: 100, y: 100 },
        to: { x: 150, y: 120 },
        factor: 1.5,
    });

    // The content under the fingers' starting midpoint follows the midpoint to its new place.
    expect(screenPoint(zoomed, { x: 100, y: 100 })).toEqual({ x: 150, y: 120 });
});

test("zooming past a limit stops without drifting the content", () => {
    const atLimit = { x: -400, y: -300, scale: 20 };

    const zoomed = applyZoomPanGesture({
        transform: atLimit,
        from: { x: 50, y: 50 },
        to: { x: 50, y: 50 },
        factor: 3,
    });

    // At the maximum scale further zooming changes nothing, rather than moving the view.
    expect(zoomed).toEqual(atLimit);
});
