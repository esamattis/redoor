import * as React from "react";
import { createPortal } from "react-dom";

type TooltipChildProps = {
    "aria-describedby"?: string;
    tabIndex?: number;
};

type TooltipProps = {
    content: React.ReactNode;
    children: React.ReactElement<TooltipChildProps>;
    className?: string;
};

type TooltipHide = () => void;

let activeTooltipHide: TooltipHide | null = null;

/** Closes any other open tooltip so hover, focus, and touch cannot stack. */
function claimActiveTooltip(hide: TooltipHide) {
    if (activeTooltipHide !== null && activeTooltipHide !== hide) {
        activeTooltipHide();
    }
    activeTooltipHide = hide;
}

/** Clears the registry only when this instance still owns the visible tooltip. */
function releaseActiveTooltip(hide: TooltipHide) {
    if (activeTooltipHide === hide) {
        activeTooltipHide = null;
    }
}

/**
 * Shows a small tooltip for its child content on hover, keyboard focus, and touch.
 *
 * Pointer activation focuses links and buttons, but that focus must not keep the
 * tooltip open after the cursor leaves. Keyboard and programmatic focus still
 * open it. On touch devices the tooltip opens on the trigger's touchstart and
 * closes on that same gesture's touchend, so it cannot linger after the finger
 * lifts. This wrapper is also useful for disabled controls when the tooltip
 * needs to be attached to a non-disabled parent element instead of the control.
 */
export function Tooltip(props: TooltipProps) {
    const tooltipId = React.useId();
    const triggerRef = React.useRef<HTMLSpanElement>(null);
    const tooltipRef = React.useRef<HTMLSpanElement>(null);
    const ignoreFocusFromPointerRef = React.useRef(false);
    // Touch synthesizes mouseenter; ignore that hover until a real mouse leave.
    const ignoreHoverFromTouchRef = React.useRef(false);
    const [isHovered, setIsHovered] = React.useState(false);
    const [isFocused, setIsFocused] = React.useState(false);
    const [isTouchOpen, setIsTouchOpen] = React.useState(false);
    const isOpen = isHovered || isFocused || isTouchOpen;
    const hideAll = React.useCallback(() => {
        setIsHovered(false);
        setIsFocused(false);
        setIsTouchOpen(false);
    }, []);
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
            releaseActiveTooltip(hideAll);
            return;
        }

        claimActiveTooltip(hideAll);
        return () => {
            releaseActiveTooltip(hideAll);
        };
    }, [hideAll, isOpen]);

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
    const childProps = props.children.props;
    const describedBy = [childProps["aria-describedby"], isOpen && tooltipId]
        .filter(Boolean)
        .join(" ");
    const tooltipChildProps: TooltipChildProps = {
        "aria-describedby": describedBy || undefined,
        tabIndex: childProps.tabIndex ?? 0,
    };
    const child = React.cloneElement(props.children, tooltipChildProps);

    /** Prevents a click-induced focus from pinning the tooltip after mouseleave. */
    const handlePointerDown = () => {
        ignoreFocusFromPointerRef.current = true;
        setIsFocused(false);
    };

    /** Drops the pointer flag when this press never focused the trigger. */
    const handlePointerUp = () => {
        window.setTimeout(() => {
            ignoreFocusFromPointerRef.current = false;
        }, 0);
    };

    /** Opens on keyboard or programmatic focus, but not on the focus that follows a click. */
    const handleFocus = () => {
        if (ignoreFocusFromPointerRef.current) {
            ignoreFocusFromPointerRef.current = false;
            return;
        }
        setIsFocused(true);
    };

    return (
        <span
            ref={triggerRef}
            className={`inline-flex ${props.className ?? ""}`}
            onMouseEnter={() => {
                if (ignoreHoverFromTouchRef.current) {
                    return;
                }
                setIsHovered(true);
            }}
            onMouseLeave={() => {
                ignoreHoverFromTouchRef.current = false;
                setIsHovered(false);
            }}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onFocus={handleFocus}
            onBlur={() => setIsFocused(false)}
            onTouchStart={() => {
                ignoreHoverFromTouchRef.current = true;
                setIsHovered(false);
                setIsTouchOpen(true);
            }}
            onTouchEnd={() => setIsTouchOpen(false)}
            onTouchCancel={() => setIsTouchOpen(false)}
        >
            {child}

            {tooltip && globalThis.document
                ? createPortal(tooltip, globalThis.document.body)
                : null}
        </span>
    );
}
