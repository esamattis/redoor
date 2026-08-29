import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "#ui/components/icon-button";

/**
 * Provides consistent modal structure and dismissal behavior for UI workflows.
 *
 * When `anchorRef` is set the panel is pinned near that element instead of the
 * viewport center so the same dialog can power compact menus without a second
 * overlay primitive.
 */
export function Dialog(props: {
    isOpen: boolean;
    title: string;
    hideTitle?: boolean;
    description?: React.ReactNode;
    closeAriaLabel: string;
    isBusy?: boolean;
    errorMessage?: string | null;
    role?: "dialog" | "alertdialog";
    size?: "default" | "wide" | "search";
    children: React.ReactNode;
    onClose: () => void;
    /**
     * Optional trigger element. When present the panel is positioned below it
     * (end-aligned) rather than as a centered modal.
     */
    anchorRef?: React.RefObject<HTMLElement | null>;
    /**
     * Optional pointer location. Used when the menu has no trigger element,
     * such as a canvas right-click.
     */
    anchorPoint?: { x: number; y: number };
}) {
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
    });

    if (!props.isOpen) {
        return null;
    }

    const panel = (
        <div
            ref={panelRef}
            className={
                isAnchored
                    ? "absolute w-56 rounded-xl border border-slate-700 bg-[#11141b] p-3 shadow-2xl shadow-black/40"
                    : props.size === "search"
                      ? "flex h-dvh w-full flex-col bg-[#11141b] p-4 text-left shadow-2xl shadow-black/40 sm:h-[min(90dvh,56rem)] sm:rounded-xl sm:border sm:border-slate-700 sm:p-6"
                      : "w-full rounded-xl border border-slate-700 bg-[#11141b] p-6 text-left shadow-2xl shadow-black/40"
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
                        className="rounded p-2 text-slate-400 hover:bg-white/10 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <X className="h-4 w-4" />
                    </IconButton>
                </div>
            )}

            {props.errorMessage ? (
                <p
                    role="alert"
                    className="mt-4 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
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
            className={`m-auto touch-pan-y overflow-y-auto overscroll-y-contain border-0 bg-transparent p-0 text-slate-200 backdrop:bg-black/60 ${props.size === "search" ? "h-dvh max-h-dvh w-full max-w-none sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-6xl" : `max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${props.size === "wide" ? "max-w-4xl" : "max-w-md"}`}`}
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
}) {
    const [anchorPosition, setAnchorPosition] = React.useState<{
        top: number;
        left: number;
    } | null>(null);

    React.useEffect(() => {
        if (!props.isOpen || !props.isAnchored || props.isBusy) {
            return;
        }

        /** Capture so Escape dismisses the menu before a focused terminal consumes it. */
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                props.onClose();
            }
        };

        document.addEventListener("keydown", handleKeyDown, true);
        return () =>
            document.removeEventListener("keydown", handleKeyDown, true);
    }, [props.isAnchored, props.isBusy, props.isOpen, props.onClose]);

    React.useEffect(() => {
        const dialog = props.dialogRef.current;
        if (!props.isOpen || props.isAnchored || !dialog) {
            return;
        }

        if (!dialog.open) {
            dialog.showModal();
        }

        // showModal() runs after React's autoFocus layout effect and focuses the
        // first tabbable control (usually the close button). Prefer an explicit
        // autofocus target, otherwise the first editable field in the body.
        const autofocusTarget =
            dialog.querySelector<HTMLElement>("[autofocus]") ??
            dialog.querySelector<HTMLElement>(
                "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled])",
            );
        autofocusTarget?.focus();

        return () => {
            if (dialog.open) {
                dialog.close();
            }
        };
    }, [props.dialogRef, props.isAnchored, props.isOpen]);

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

/** Keeps menus on screen without covering the click or trigger that opened them. */
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
    let top = args.point ? args.point.y : (anchorRect?.bottom ?? 0) + gap;
    let left = args.point
        ? args.point.x
        : (anchorRect?.right ?? 0) - panelWidth;

    if (
        panelHeight > 0 &&
        top + panelHeight > window.innerHeight - viewportPadding
    ) {
        const flippedTop = args.point
            ? args.point.y - panelHeight
            : (anchorRect?.top ?? 0) - gap - panelHeight;
        if (flippedTop >= viewportPadding) {
            top = flippedTop;
        }
    }

    left = Math.min(left, window.innerWidth - panelWidth - viewportPadding);
    left = Math.max(viewportPadding, left);
    top = Math.max(viewportPadding, top);
    return { top, left };
}
