import React from "react";

import { Dialog } from "./dialog";

/**
 * Positions a compact action list at the pointer so surfaces without a trigger
 * element, such as a canvas terminal or the code editor, can still expose clipboard
 * actions in place of the browser menu.
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
            // A pointer menu sits on top of the content it acts on, so it stays as small as a
            // native context menu instead of matching the roomier trigger menus.
            anchoredPanelClassName="w-auto min-w-48 rounded-lg p-1"
            onClose={props.onClose}
        >
            <div ref={itemsRef} className="grid">
                {props.children(props.onClose)}
            </div>
        </Dialog>
    );
}

/**
 * One dense row of a `ContextMenu`. The icon and the shortcut hint let users scan the
 * menu the way they scan a native one and learn the faster keyboard route.
 */
export function ContextMenuItem(props: {
    icon: React.ReactNode;
    children: React.ReactNode;
    /** The keyboard shortcut that does the same thing, shown muted at the trailing edge. */
    shortcut?: string;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            disabled={props.disabled}
            onClick={props.onClick}
            // Coarse pointers get taller rows, since a long press opens the menu on phones.
            className="group flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1 text-left text-sm text-slate-200 transition-colors hover:bg-tint hover:text-slate-100 focus-visible:bg-tint focus-visible:outline-none disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent pointer-coarse:py-2"
        >
            <span
                aria-hidden="true"
                className="flex h-4 w-4 shrink-0 items-center justify-center text-slate-400 group-disabled:text-slate-600"
            >
                {props.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{props.children}</span>
            {props.shortcut === undefined ? null : (
                <kbd
                    aria-hidden="true"
                    className="ml-4 shrink-0 font-sans text-xs text-slate-500 group-disabled:text-slate-700"
                >
                    {props.shortcut}
                </kbd>
            )}
        </button>
    );
}

/** Splits context menu rows into groups, like the separators of a native menu. */
export function ContextMenuSeparator() {
    return (
        <div role="separator" className="mx-1 my-1 border-t border-slate-800" />
    );
}
