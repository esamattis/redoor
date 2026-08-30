// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Dialog } from "./dialog";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/** Renders an anchored dialog against a predictable trigger rectangle. */
function AnchoredDialog(props: {
    anchorTop: number;
    anchorBottom: number;
    anchorLeft: number;
    anchorRight: number;
}) {
    const anchorRef = React.useRef<HTMLButtonElement>(null);
    const setAnchor = (element: HTMLButtonElement | null) => {
        anchorRef.current = element;
        if (element) {
            element.getBoundingClientRect = () => ({
                top: props.anchorTop,
                bottom: props.anchorBottom,
                left: props.anchorLeft,
                right: props.anchorRight,
                width: props.anchorRight - props.anchorLeft,
                height: props.anchorBottom - props.anchorTop,
                x: props.anchorLeft,
                y: props.anchorTop,
                toJSON: () => ({}),
            });
        }
    };

    return (
        <>
            <button ref={setAnchor}>Open</button>
            <Dialog
                isOpen
                title="Options"
                closeAriaLabel="Close options"
                anchorRef={anchorRef}
                onClose={() => undefined}
            >
                Content
            </Dialog>
        </>
    );
}

/** Supplies the dimensions jsdom does not calculate for dialog panels. */
function renderAnchoredDialog(anchor: {
    top: number;
    bottom: number;
    left?: number;
    right?: number;
}) {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(224);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
    vi.stubGlobal("innerWidth", 1_000);
    vi.stubGlobal("innerHeight", 800);
    render(
        <AnchoredDialog
            anchorTop={anchor.top}
            anchorBottom={anchor.bottom}
            anchorLeft={anchor.left ?? 400}
            anchorRight={anchor.right ?? 440}
        />,
    );
    const panel = screen.getByRole("dialog", {
        name: "Options",
    }).firstElementChild;
    if (!(panel instanceof HTMLElement)) {
        throw new Error("Expected the dialog panel to render");
    }
    return panel;
}

test("opens above when there is more space above the anchor", () => {
    const panel = renderAnchoredDialog({ top: 500, bottom: 540 });

    // The roomier side wins even though the panel would also fit below.
    expect(panel.style.top).toBe("292px");
    expect(panel.style.left).toBe("400px");
});

test("opens below when there is more space below the anchor", () => {
    const panel = renderAnchoredDialog({ top: 200, bottom: 240 });

    // The anchor gap remains intact when the lower viewport area is larger.
    expect(panel.style.top).toBe("248px");
    expect(panel.style.left).toBe("400px");
});

test("extends left when there is more space left of the anchor", () => {
    const panel = renderAnchoredDialog({
        top: 200,
        bottom: 240,
        left: 700,
        right: 740,
    });

    // End alignment extends the panel into the larger left side.
    expect(panel.style.left).toBe("516px");
});
