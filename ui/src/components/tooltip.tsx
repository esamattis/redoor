import * as React from "react";
import { createPortal } from "react-dom";

type TooltipProps = {
    content: React.ReactNode;
    children: React.ReactNode;
    className?: string;
};

/**
 * Shows a small tooltip for its child content on hover, keyboard focus, and touch.
 *
 * On touch devices the tooltip opens on the trigger's touchstart and stays open
 * until the next touchstart anywhere on the page, so users can read it without
 * hover. This wrapper is also useful for disabled controls when the tooltip
 * needs to be attached to a non-disabled parent element instead of the control.
 */
export function Tooltip(props: TooltipProps) {
    const tooltipId = React.useId();
    const triggerRef = React.useRef<HTMLSpanElement>(null);
    const tooltipRef = React.useRef<HTMLSpanElement>(null);
    const [isOpen, setIsOpen] = React.useState(false);
    const [position, setPosition] = React.useState<{
        top: number;
        left: number;
        arrowLeft: number;
        placement: "above" | "below";
    } | null>(null);

    React.useLayoutEffect(() => {
        if (!isOpen) {
            return;
        }

        /** Keeps the portaled tooltip attached to its trigger and inside the viewport. */
        const updatePosition = () => {
            const trigger = triggerRef.current;
            const tooltip = tooltipRef.current;
            if (!trigger || !tooltip) {
                return;
            }

            const triggerRect = trigger.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            const gap = 8;
            const viewportPadding = 8;
            const spaceAbove = triggerRect.top - gap - viewportPadding;
            const spaceBelow =
                window.innerHeight - triggerRect.bottom - gap - viewportPadding;
            const placement =
                tooltipRect.height <= spaceAbove || spaceAbove >= spaceBelow
                    ? "above"
                    : "below";
            const desiredTop =
                placement === "above"
                    ? triggerRect.top - gap - tooltipRect.height
                    : triggerRect.bottom + gap;
            const maximumTop = Math.max(
                viewportPadding,
                window.innerHeight - tooltipRect.height - viewportPadding,
            );
            const top = Math.min(
                Math.max(desiredTop, viewportPadding),
                maximumTop,
            );
            const triggerCenter = triggerRect.left + triggerRect.width / 2;
            const desiredLeft = triggerCenter - tooltipRect.width / 2;
            const maximumLeft = Math.max(
                viewportPadding,
                window.innerWidth - tooltipRect.width - viewportPadding,
            );
            const left = Math.min(
                Math.max(desiredLeft, viewportPadding),
                maximumLeft,
            );
            const arrowLeft = Math.max(
                8,
                Math.min(triggerCenter - left, tooltipRect.width - 8),
            );

            setPosition({ top, left, arrowLeft, placement });
        };

        updatePosition();
        const resizeObserver = new ResizeObserver(updatePosition);
        if (triggerRef.current) {
            resizeObserver.observe(triggerRef.current);
        }
        if (tooltipRef.current) {
            resizeObserver.observe(tooltipRef.current);
        }
        window.addEventListener("resize", updatePosition);
        window.addEventListener("scroll", updatePosition, true);

        return () => {
            resizeObserver.disconnect();
            window.removeEventListener("resize", updatePosition);
            window.removeEventListener("scroll", updatePosition, true);
        };
    }, [isOpen, props.content]);

    React.useEffect(() => {
        if (!isOpen) {
            return;
        }

        /** Dismisses a touch-opened tooltip on the next touch anywhere on the page. */
        const hideOnTouchStart = () => {
            setIsOpen(false);
        };

        // Defer so the opening touchstart does not immediately dismiss the tooltip.
        const timeoutId = window.setTimeout(() => {
            document.addEventListener("touchstart", hideOnTouchStart);
        }, 0);

        return () => {
            window.clearTimeout(timeoutId);
            document.removeEventListener("touchstart", hideOnTouchStart);
        };
    }, [isOpen]);

    const tooltip = isOpen ? (
        <span
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none fixed z-50 w-max max-w-[calc(100vw-1rem)] rounded-md bg-slate-100 px-3 py-2 text-xs font-medium text-slate-950 shadow-lg shadow-black/30"
            style={
                position
                    ? { top: position.top, left: position.left }
                    : { visibility: "hidden" }
            }
        >
            {props.content}
            <span
                className={`absolute h-2 w-2 -translate-x-1/2 rotate-45 bg-slate-100 ${
                    position?.placement === "below"
                        ? "bottom-full translate-y-1"
                        : "top-full -translate-y-1"
                }`}
                style={{ left: position?.arrowLeft ?? "50%" }}
            />
        </span>
    ) : null;

    return (
        <span
            ref={triggerRef}
            className={`inline-flex ${props.className ?? ""}`}
            onMouseEnter={() => setIsOpen(true)}
            onMouseLeave={() => setIsOpen(false)}
            onFocus={() => setIsOpen(true)}
            onBlur={() => setIsOpen(false)}
            onTouchStart={() => setIsOpen(true)}
        >
            <span
                aria-describedby={isOpen ? tooltipId : undefined}
                className="inline-flex"
                tabIndex={0}
            >
                {props.children}
            </span>

            {tooltip && globalThis.document
                ? createPortal(tooltip, globalThis.document.body)
                : null}
        </span>
    );
}
