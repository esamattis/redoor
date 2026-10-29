import React from "react";
import { createPortal } from "react-dom";

/**
 * The element in the browser header's tab row that a view can put its toolbar in. The setter
 * lives here too, because the header that owns the element and the view that fills it are
 * siblings under the route shell.
 */
type ViewToolbarSlot = {
    element: HTMLElement | null;
    setElement: (element: HTMLElement | null) => void;
};

const ViewToolbarSlotContext = React.createContext<ViewToolbarSlot | null>(
    null,
);

/**
 * Lets the active view share the tab row instead of stacking its own toolbar row under it,
 * which saves a row of height above the content on every screen.
 */
export function ViewToolbarSlotProvider(props: { children: React.ReactNode }) {
    const [element, setElement] = React.useState<HTMLElement | null>(null);

    const value = React.useMemo(() => ({ element, setElement }), [element]);

    return (
        <ViewToolbarSlotContext.Provider value={value}>
            {props.children}
        </ViewToolbarSlotContext.Provider>
    );
}

/** Registers the header element that view toolbars render into. */
export function useViewToolbarSlotRef() {
    return React.useContext(ViewToolbarSlotContext)?.setElement;
}

/**
 * Renders a view's toolbar in the header's tab row, or in place when the view has no header
 * slot, such as the full-window editor that covers the header. While the slot mounts it renders
 * nothing, so the toolbar never flashes in place first; the slot registers before paint.
 */
export function ViewToolbar(props: {
    inPlace: boolean;
    children: React.ReactNode;
}) {
    const slot = React.useContext(ViewToolbarSlotContext);

    if (props.inPlace || slot === null) {
        return props.children;
    }

    return slot.element === null
        ? null
        : createPortal(props.children, slot.element);
}
