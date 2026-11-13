import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "#ui/components/icon-button";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { cn } from "#ui/utils/cn";
import { useFocusTrap } from "#ui/utils/use-focus-trap";

/**
 * Provides consistent modal structure and dismissal behavior for UI workflows.
 *
 * When `anchorRef` is set the panel is pinned near that element instead of the
 * viewport center so the same dialog can power compact menus without a second
 * overlay primitive.
 */
export type DialogProps = {
    isOpen: boolean;
    title: string;
    hideTitle?: boolean;
    description?: React.ReactNode;
    closeAriaLabel: string;
    isBusy?: boolean;
    errorMessage?: string | null;
    role?: "dialog" | "alertdialog";
    /**
     * `medium` fits forms with side-by-side choices and long copyable values, which wrap
     * awkwardly at the default width; `wide` is for tables and logs.
     */
    size?: "default" | "medium" | "wide" | "search";
    children: React.ReactNode;
    onClose: () => void;
    /**
     * Optional trigger element. When present the panel extends toward the
     * roomier viewport sides rather than rendering as a centered modal.
     */
    anchorRef?: React.RefObject<HTMLElement | null>;
    /**
     * Optional pointer location. Used when the menu has no trigger element,
     * such as a canvas right-click.
     */
    anchorPoint?: { x: number; y: number };
    /** Focuses the non-tooltip panel surface instead of an action when opening. */
    initialFocus?: "panel";
    /**
     * Overrides the anchored panel's size and padding, so a pointer context menu can be
     * denser than the trigger-anchored action menus without changing them.
     */
    anchoredPanelClassName?: string;
};

/** A native dialog in the stack and the control focused in it when a dialog covered it. */
type StackedDialog = {
    dialog: HTMLDialogElement;
    focus: HTMLElement | null;
};

/** Marks the topmost dialog while it is shown non-modally, so its classes can stand in for the modal layout. */
const suspendedAttribute = "data-modality-suspended";

/**
 * Keeps only the topmost dialog open when dialogs stack, such as the vault unlock dialog a
 * form dialog asks for. The covered dialogs stay mounted with their state and reopen when the
 * dialog above them closes, so only one dialog ever needs to change its modality.
 *
 * Password managers like 1Password draw their passkey prompt as an ordinary element in
 * `<body>`. A modal dialog sits in the browser top layer and makes everything else inert, so
 * that prompt is drawn underneath it, cannot be clicked and the passkey request never
 * settles. While a passkey prompt runs, `suspendModality` therefore shows the topmost dialog
 * non-modally and makes only the page content around it inert.
 */
class ModalDialogStack {
    private entries: StackedDialog[] = [];
    /** Number of passkey prompts in flight; refcounted because prompts can overlap. */
    private suspensions = 0;
    /** Elements this stack made inert, so restoring touches nothing it did not set. */
    private inertElements: HTMLElement[] = [];
    /** The dialog that currently carries the suspended layout. */
    private suspendedDialog: HTMLDialogElement | null = null;
    /** Removes the Escape handler that replaces the native cancel of modal dialogs. */
    private removeEscapeHandler: (() => void) | null = null;

    /**
     * Shows the dialog above all others and hides the one it covers. Returns the release
     * that closes it again and reopens the dialog below.
     */
    push(dialog: HTMLDialogElement): () => void {
        const covered = this.entries.at(-1);

        if (covered !== undefined) {
            covered.focus = focusedWithin(covered.dialog);
            covered.dialog.close();
        }

        this.entries.push({ dialog, focus: null });

        if (!dialog.open) {
            this.open(dialog);
        }

        this.refreshSuspension();

        return () => this.release(dialog);
    }

    /**
     * Shows the topmost dialog non-modally until the returned release runs, so content that a
     * password manager injects into `<body>` stays visible and clickable. The release is
     * idempotent, and modality only returns once every overlapping suspension released.
     */
    suspendModality(): () => void {
        let released = false;
        this.suspensions += 1;

        if (this.suspensions === 1) {
            this.reopenTopmost();
            this.addEscapeHandler();
        }

        this.refreshSuspension();

        return () => {
            if (released) {
                return;
            }

            released = true;
            this.suspensions -= 1;

            if (this.suspensions > 0) {
                return;
            }

            this.removeEscapeHandler?.();
            this.removeEscapeHandler = null;
            this.refreshSuspension();
            this.reopenTopmost();
        };
    }

    /**
     * Closes the dialog and, when it was the topmost one, reopens the dialog below with the
     * control the user left focused there.
     */
    private release(dialog: HTMLDialogElement): void {
        const index = this.entries.findIndex(
            (entry) => entry.dialog === dialog,
        );

        if (index === -1) {
            return;
        }

        const wasTopmost = index === this.entries.length - 1;
        this.entries.splice(index, 1);

        if (dialog.open) {
            dialog.close();
        }

        const uncovered = this.entries.at(-1);

        if (wasTopmost && uncovered !== undefined) {
            if (!uncovered.dialog.open) {
                this.open(uncovered.dialog);
            }

            uncovered.focus?.focus();
            uncovered.focus = null;
        }

        this.refreshSuspension();
    }

    /** Opens a dialog in the modality the stack is currently in. */
    private open(dialog: HTMLDialogElement): void {
        if (this.suspensions > 0) {
            dialog.show();
        } else {
            dialog.showModal();
        }
    }

    /**
     * Reopens the topmost dialog in the current modality, because a dialog cannot switch
     * between modal and non-modal while open. The focused control is put back, since closing
     * and opening move focus.
     */
    private reopenTopmost(): void {
        const topmost = this.entries.at(-1);

        if (topmost === undefined || !topmost.dialog.open) {
            return;
        }

        const isModal = topmost.dialog.matches(":modal");

        if (isModal === (this.suspensions === 0)) {
            return;
        }

        const focus = focusedWithin(topmost.dialog);
        topmost.dialog.close();
        this.open(topmost.dialog);
        focus?.focus();
    }

    /**
     * Moves the suspended layout and the inert page content to the current topmost dialog,
     * or removes them when modality is not suspended.
     */
    private refreshSuspension(): void {
        for (const element of this.inertElements) {
            element.inert = false;
        }

        this.inertElements = [];
        this.suspendedDialog?.removeAttribute(suspendedAttribute);
        this.suspendedDialog = null;

        const topmost = this.entries.at(-1);

        if (this.suspensions === 0 || topmost === undefined) {
            return;
        }

        topmost.dialog.setAttribute(suspendedAttribute, "");
        this.suspendedDialog = topmost.dialog;

        // Making the app root inert would make the dialog inside it inert too, so every
        // sibling on the way from the dialog up to the app root is made inert instead. The
        // rest of <body> stays untouched for the password manager's injected prompt.
        const appRoot = topmost.dialog.closest("#app");
        let node: Element = topmost.dialog;

        while (appRoot !== null && node !== appRoot && node.parentElement) {
            for (const sibling of node.parentElement.children) {
                if (
                    sibling !== node &&
                    sibling instanceof HTMLElement &&
                    !sibling.inert
                ) {
                    sibling.inert = true;
                    this.inertElements.push(sibling);
                }
            }

            node = node.parentElement;
        }
    }

    /**
     * Non-modal dialogs get no native `cancel` on Escape, so this dispatches one on the
     * topmost dialog and the dialog's own cancel handling (which respects busy state) runs.
     */
    private addEscapeHandler(): void {
        const onKeyDown = (event: KeyboardEvent) => {
            const topmost = this.entries.at(-1);

            // Escape inside the password manager's own prompt belongs to the prompt.
            const fromDialog =
                event.target === document.body ||
                (event.target instanceof Node &&
                    topmost?.dialog.contains(event.target) === true);

            if (
                event.key !== "Escape" ||
                topmost === undefined ||
                !fromDialog
            ) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            topmost.dialog.dispatchEvent(
                new Event("cancel", { cancelable: true }),
            );
        };

        window.addEventListener("keydown", onKeyDown, true);

        this.removeEscapeHandler = () =>
            window.removeEventListener("keydown", onKeyDown, true);
    }
}

/** The focused control inside the dialog, to restore it after the dialog closes and reopens. */
function focusedWithin(dialog: HTMLDialogElement): HTMLElement | null {
    const active = document.activeElement;

    return active instanceof HTMLElement && dialog.contains(active)
        ? active
        : null;
}

/**
 * Shared by every dialog, because stacking spans unrelated components, and by the passkey
 * prompts, which suspend modality for whichever dialog is on top.
 */
export const modalDialogStack = new ModalDialogStack();

export function Dialog(props: DialogProps) {
    const titleId = React.useId();
    const descriptionId = React.useId();
    const dialogRef = React.useRef<HTMLDialogElement>(null);
    const panelRef = React.useRef<HTMLDivElement>(null);
    const isAnchored = props.anchorRef != null || props.anchorPoint != null;

    const anchorPosition = useDialogBehavior({
        isOpen: props.isOpen,
        isBusy: props.isBusy,
        isAnchored,
        anchorRef: props.anchorRef,
        anchorPoint: props.anchorPoint,
        dialogRef,
        panelRef,
        onClose: props.onClose,
        children: props.children,
        errorMessage: props.errorMessage,
        initialFocus: props.initialFocus,
    });

    if (!props.isOpen) {
        return null;
    }

    const panel = (
        <div
            ref={panelRef}
            tabIndex={props.initialFocus === "panel" ? -1 : undefined}
            className={
                isAnchored
                    ? cn(
                          "absolute w-56 rounded-xl border border-slate-700 bg-surface p-3 shadow-2xl shadow-black/40",
                          props.anchoredPanelClassName,
                      )
                    : props.size === "search"
                      ? "min-h-dvh w-full bg-surface p-4 text-left shadow-2xl shadow-black/40 sm:min-h-0 sm:rounded-xl sm:border sm:border-slate-700 sm:p-6"
                      : "w-full rounded-xl border border-slate-700 bg-surface p-6 text-left shadow-2xl shadow-black/40"
            }
            style={
                isAnchored && anchorPosition
                    ? {
                          top: anchorPosition.top,
                          left: anchorPosition.left,
                      }
                    : isAnchored
                      ? { visibility: "hidden" }
                      : undefined
            }
        >
            {props.hideTitle ? (
                <h2 id={titleId} className="sr-only">
                    {props.title}
                </h2>
            ) : (
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h2
                            id={titleId}
                            className={
                                isAnchored
                                    ? "text-sm font-semibold text-slate-100"
                                    : "text-lg font-semibold text-slate-100"
                            }
                        >
                            {props.title}
                        </h2>
                        {props.description ? (
                            <div
                                id={descriptionId}
                                className="mt-2 text-sm text-slate-400"
                            >
                                {props.description}
                            </div>
                        ) : null}
                    </div>
                    <IconButton
                        type="button"
                        label={props.closeAriaLabel}
                        onClick={props.onClose}
                        disabled={props.isBusy}
                        variant="ghost"
                        size="md"
                    >
                        <X className="h-4 w-4" />
                    </IconButton>
                </div>
            )}

            {props.errorMessage ? (
                <p
                    role="alert"
                    className="mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300 whitespace-pre-line break-words"
                >
                    {props.errorMessage}
                </p>
            ) : null}

            {props.children}
        </div>
    );

    if (isAnchored) {
        // Anchored menus escape overflow containers such as collapsed bottom panels.
        return createPortal(
            <div
                className="fixed inset-0 z-[70]"
                role={props.role ?? "dialog"}
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={props.description ? descriptionId : undefined}
                onMouseDown={(event) => {
                    if (event.target === event.currentTarget && !props.isBusy) {
                        props.onClose();
                    }
                }}
            >
                {panel}
            </div>,
            document.body,
        );
    }

    return (
        <dialog
            ref={dialogRef}
            role={props.role ?? "dialog"}
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={props.description ? descriptionId : undefined}
            className={`m-auto touch-pan-y data-modality-suspended:fixed data-modality-suspended:inset-0 data-modality-suspended:z-[90] data-modality-suspended:shadow-[0_0_0_100vmax_rgb(0_0_0/0.6)] overflow-y-auto overscroll-y-contain border-0 bg-transparent p-0 text-slate-200 backdrop:bg-black/60 ${props.size === "search" ? "h-dvh max-h-dvh w-full max-w-none sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-6xl" : `max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${props.size === "wide" ? "max-w-4xl" : props.size === "medium" ? "max-w-2xl" : "max-w-md"}`}`}
            onCancel={(event) => {
                event.preventDefault();

                if (!props.isBusy) {
                    props.onClose();
                }
            }}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && !props.isBusy) {
                    props.onClose();
                }
            }}
        >
            {panel}
        </dialog>
    );
}

/** Owns open/close lifecycle and anchor placement so Dialog stays presentation-focused. */
function useDialogBehavior(props: {
    isOpen: boolean;
    isBusy?: boolean;
    isAnchored: boolean;
    anchorRef?: React.RefObject<HTMLElement | null>;
    anchorPoint?: { x: number; y: number };
    dialogRef: React.RefObject<HTMLDialogElement | null>;
    panelRef: React.RefObject<HTMLDivElement | null>;
    onClose: () => void;
    children: React.ReactNode;
    errorMessage?: string | null;
    initialFocus?: "panel";
}) {
    const [anchorPosition, setAnchorPosition] = React.useState<{
        top: number;
        left: number;
    } | null>(null);

    // Modal tier and capture, so Escape dismisses the menu before a focused terminal or an
    // editor panel beneath it can consume the key.
    useShortcut(
        {
            name: "anchored-dialog-dismiss",
            phase: "capture",
            priority: shortcutPriority.modal,
            effect: "swallow",
            match: (event) => event.key === "Escape",
            run: props.onClose,
        },
        props.isOpen && props.isAnchored && !props.isBusy,
    );

    // The native <dialog> traps focus itself; the portaled panel of an anchored menu does not,
    // so it needs the same wrap-around the side-menu drawer uses.
    useFocusTrap(props.panelRef, props.isOpen && props.isAnchored);

    React.useEffect(() => {
        const dialog = props.dialogRef.current;

        if (!props.isOpen || props.isAnchored || !dialog) {
            return;
        }

        const release = modalDialogStack.push(dialog);

        // showModal() runs after React's autoFocus layout effect and focuses the
        // first tabbable control (usually the close button). Prefer an explicit
        // autofocus target, otherwise the first editable field in the body.
        const autofocusTarget =
            dialog.querySelector<HTMLElement>("[autofocus]") ??
            dialog.querySelector<HTMLElement>(
                "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled])",
            ) ??
            (props.initialFocus === "panel" ? props.panelRef.current : null);

        autofocusTarget?.focus();

        return release;
    }, [
        props.dialogRef,
        props.initialFocus,
        props.isAnchored,
        props.isOpen,
        props.panelRef,
    ]);

    React.useEffect(() => {
        if (
            props.isOpen &&
            props.isAnchored &&
            props.initialFocus === "panel"
        ) {
            const frame = window.requestAnimationFrame(() => {
                props.panelRef.current?.focus();
            });

            return () => window.cancelAnimationFrame(frame);
        }

        return undefined;
    }, [props.initialFocus, props.isAnchored, props.isOpen, props.panelRef]);

    React.useLayoutEffect(() => {
        if (!props.isOpen || (!props.anchorRef && !props.anchorPoint)) {
            setAnchorPosition(null);

            return;
        }

        /** Keeps the panel attached to the trigger or pointer across layout shifts. */
        const updatePosition = () => {
            const nextPosition = getAnchoredDialogPosition({
                panel: props.panelRef.current,
                point: props.anchorPoint,
                anchor: props.anchorRef?.current,
            });

            if (nextPosition) {
                setAnchorPosition(nextPosition);
            }
        };

        updatePosition();
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);

        return () => {
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
    }, [
        props.anchorPoint,
        props.anchorRef,
        props.children,
        props.errorMessage,
        props.isOpen,
        props.panelRef,
    ]);

    return anchorPosition;
}

/** Extends toward the roomier sides while keeping menus within viewport edges. */
function getAnchoredDialogPosition(args: {
    panel: HTMLDivElement | null;
    point?: { x: number; y: number };
    anchor?: HTMLElement | null;
}) {
    const panelWidth = args.panel?.offsetWidth ?? 224;
    const panelHeight = args.panel?.offsetHeight ?? 0;
    const gap = 8;
    const viewportPadding = 8;

    if (!args.point && !args.anchor) {
        return null;
    }

    const anchorRect = args.anchor?.getBoundingClientRect();

    const belowEdge = args.point
        ? args.point.y
        : (anchorRect?.bottom ?? 0) + gap;

    const aboveEdge = args.point ? args.point.y : (anchorRect?.top ?? 0) - gap;
    const availableBelow = window.innerHeight - viewportPadding - belowEdge;
    const availableAbove = aboveEdge - viewportPadding;

    let top =
        availableAbove > availableBelow ? aboveEdge - panelHeight : belowEdge;

    const leftEdge = args.point ? args.point.x : (anchorRect?.left ?? 0);
    const rightEdge = args.point ? args.point.x : (anchorRect?.right ?? 0);
    const availableLeft = leftEdge - viewportPadding;
    const availableRight = window.innerWidth - viewportPadding - rightEdge;

    let left =
        availableRight > availableLeft ? leftEdge : rightEdge - panelWidth;

    left = Math.min(left, window.innerWidth - panelWidth - viewportPadding);
    left = Math.max(viewportPadding, left);
    top = Math.max(viewportPadding, top);

    return { top, left };
}
