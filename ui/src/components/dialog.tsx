import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "#ui/components/icon-button";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
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
};

/** A native dialog in the stack and the control focused in it when a dialog covered it. */
type StackedDialog = {
    dialog: HTMLDialogElement;
    focus: HTMLElement | null;
};

/**
 * Keeps only the topmost dialog open when dialogs stack, such as the vault unlock dialog a
 * form dialog asks for. Password managers like 1Password draw their passkey prompt into the
 * page, and with several open modal dialogs it lands in a covered, inert one, so the prompt
 * never shows. The covered dialogs stay mounted with their state and reopen when the dialog
 * above them closes.
 */
class ModalDialogStack {
    private entries: StackedDialog[] = [];

    /**
     * Shows the dialog modally above all others and hides the one it covers. Returns the
     * release that closes it again and reopens the dialog below.
     */
    push(dialog: HTMLDialogElement): () => void {
        const covered = this.entries.at(-1);

        if (covered !== undefined) {
            const active = document.activeElement;

            covered.focus =
                active instanceof HTMLElement && covered.dialog.contains(active)
                    ? active
                    : null;

            covered.dialog.close();
        }

        this.entries.push({ dialog, focus: null });

        if (!dialog.open) {
            dialog.showModal();
        }

        return () => this.release(dialog);
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

        if (!wasTopmost || uncovered === undefined) {
            return;
        }

        if (!uncovered.dialog.open) {
            uncovered.dialog.showModal();
        }

        uncovered.focus?.focus();
        uncovered.focus = null;
    }
}

/** Shared by every dialog, because stacking spans unrelated components. */
const modalDialogStack = new ModalDialogStack();

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
                    ? "absolute w-56 rounded-xl border border-slate-700 bg-surface p-3 shadow-2xl shadow-black/40"
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
            className={`m-auto touch-pan-y overflow-y-auto overscroll-y-contain border-0 bg-transparent p-0 text-slate-200 backdrop:bg-black/60 ${props.size === "search" ? "h-dvh max-h-dvh w-full max-w-none sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-6xl" : `max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${props.size === "wide" ? "max-w-4xl" : props.size === "medium" ? "max-w-2xl" : "max-w-md"}`}`}
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
