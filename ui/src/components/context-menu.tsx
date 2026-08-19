import React from "react";

import { Dialog } from "./dialog";

/**
 * Positions a compact action list at the pointer so surfaces without a trigger
 * element, such as a canvas terminal, can still expose copy and paste.
 */
export function ContextMenu(props: {
    isOpen: boolean;
    title: string;
    closeAriaLabel: string;
    position: { x: number; y: number } | null;
    onClose: () => void;
    children: (close: () => void) => React.ReactNode;
}) {
    const itemsRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (!props.isOpen) {
            return;
        }

        // Keyboard users land on the first available action instead of the canvas.
        const firstEnabled = itemsRef.current?.querySelector<HTMLButtonElement>(
            "button:not([disabled])",
        );
        firstEnabled?.focus();
    }, [props.isOpen]);

    return (
        <Dialog
            isOpen={props.isOpen}
            title={props.title}
            hideTitle
            closeAriaLabel={props.closeAriaLabel}
            anchorPoint={props.position ?? undefined}
            onClose={props.onClose}
        >
            <div ref={itemsRef} className="grid gap-1">
                {props.children(props.onClose)}
            </div>
        </Dialog>
    );
}
