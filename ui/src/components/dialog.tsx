import React from "react";
import { X } from "lucide-react";

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
    description?: React.ReactNode;
    closeAriaLabel: string;
    isBusy?: boolean;
    errorMessage?: string | null;
    role?: "dialog" | "alertdialog";
    children: React.ReactNode;
    onClose: () => void;
    /**
     * Optional trigger element. When present the panel is positioned below it
     * (end-aligned) rather than as a centered modal.
     */
    anchorRef?: React.RefObject<HTMLElement | null>;
}) {
    const titleId = React.useId();
    const descriptionId = React.useId();
    const dialogRef = React.useRef<HTMLDialogElement>(null);
    const panelRef = React.useRef<HTMLDivElement>(null);
    const [anchorPosition, setAnchorPosition] = React.useState<{
        top: number;
        left: number;
    } | null>(null);
    const isAnchored = props.anchorRef != null;

    React.useEffect(() => {
        if (!props.isOpen || !isAnchored || props.isBusy) {
            return;
        }

        /** Closes an idle dialog from the keyboard for accessible dismissal. */
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                props.onClose();
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [isAnchored, props.isBusy, props.isOpen, props.onClose]);

    React.useEffect(() => {
        const dialog = dialogRef.current;
        if (!props.isOpen || isAnchored || !dialog) {
            return;
        }

        if (!dialog.open) {
            dialog.showModal();
        }

        return () => {
            if (dialog.open) {
                dialog.close();
            }
        };
    }, [isAnchored, props.isOpen]);

    React.useLayoutEffect(() => {
        if (!props.isOpen || !props.anchorRef) {
            setAnchorPosition(null);
            return;
        }

        /** Keeps the panel attached to the trigger across layout shifts. */
        const updatePosition = () => {
            const anchor = props.anchorRef?.current;
            const panel = panelRef.current;
            if (!anchor) {
                return;
            }

            const anchorRect = anchor.getBoundingClientRect();
            const panelWidth = panel?.offsetWidth ?? 224;
            const panelHeight = panel?.offsetHeight ?? 0;
            const gap = 8;
            const viewportPadding = 8;

            let top = anchorRect.bottom + gap;
            // Flip above the trigger when there is not enough room below.
            if (
                panelHeight > 0 &&
                top + panelHeight > window.innerHeight - viewportPadding &&
                anchorRect.top - gap - panelHeight >= viewportPadding
            ) {
                top = anchorRect.top - gap - panelHeight;
            }

            let left = anchorRect.right - panelWidth;
            left = Math.min(
                left,
                window.innerWidth - panelWidth - viewportPadding,
            );
            left = Math.max(viewportPadding, left);

            setAnchorPosition({ top, left });
        };

        updatePosition();
        // Second pass after paint so measured panel size is accurate.
        const frameId = window.requestAnimationFrame(updatePosition);
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);

        return () => {
            window.cancelAnimationFrame(frameId);
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
    }, [props.anchorRef, props.isOpen, props.children, props.errorMessage]);

    if (!props.isOpen) {
        return null;
    }

    const panel = (
        <div
            ref={panelRef}
            className={
                isAnchored
                    ? "absolute w-56 rounded-xl border border-slate-700 bg-[#11141b] p-3 shadow-2xl shadow-black/40"
                    : "w-full rounded-xl border border-slate-700 bg-[#11141b] p-6 shadow-2xl shadow-black/40"
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
                <button
                    type="button"
                    aria-label={props.closeAriaLabel}
                    onClick={props.onClose}
                    disabled={props.isBusy}
                    className="rounded p-2 text-slate-400 hover:bg-white/10 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

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
        return (
            <div
                className="fixed inset-0 z-50"
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
            </div>
        );
    }

    return (
        <dialog
            ref={dialogRef}
            role={props.role ?? "dialog"}
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={props.description ? descriptionId : undefined}
            className="m-auto w-[calc(100%-2rem)] max-w-md overflow-visible border-0 bg-transparent p-0 text-slate-200 backdrop:bg-black/60"
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
