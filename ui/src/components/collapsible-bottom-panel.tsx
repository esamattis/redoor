import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/** Keeps persistent activity visible without letting its controls dominate the page. */
export function CollapsibleBottomPanel(props: {
    title: string;
    description: string;
    badge: React.ReactNode;
    actions?: React.ReactNode;
    actionsAlignment?: "start" | "end";
    icon?: React.ReactNode;
    children: React.ReactNode;
    defaultCollapsed?: boolean;
    isCollapsed?: boolean;
    onCollapsedChange?: (isCollapsed: boolean) => void;
    keepChildrenMounted?: boolean;
    defaultExpandedHeight?: number;
}) {
    const [uncontrolledCollapsed, setUncontrolledCollapsed] = React.useState(
        props.defaultCollapsed ?? false,
    );
    const isCollapsed = props.isCollapsed ?? uncontrolledCollapsed;
    const resize = useBottomPanelResize({
        isCollapsed,
        defaultExpandedHeight: props.defaultExpandedHeight,
    });
    const toggleLabel = `${isCollapsed ? "Expand" : "Minimize"} ${props.title}`;

    /** Updates either the controlled owner or this panel's local collapse state. */
    const setIsCollapsed = (nextCollapsed: boolean) => {
        if (props.isCollapsed === undefined) {
            setUncontrolledCollapsed(nextCollapsed);
        }
        props.onCollapsedChange?.(nextCollapsed);
    };

    return (
        <section
            ref={resize.panelRef}
            style={
                !isCollapsed && resize.expandedHeight !== null
                    ? { height: resize.expandedHeight }
                    : undefined
            }
            className="sticky bottom-0 z-10 flex shrink-0 flex-col overflow-hidden border-t border-slate-800 bg-[#11141b]/95 shadow-[0_-10px_30px_-12px_rgba(0,0,0,0.6)] backdrop-blur supports-backdrop-filter:bg-[#11141b]/80"
        >
            {isCollapsed ? null : (
                <div
                    role="separator"
                    aria-label={`Resize ${props.title}`}
                    aria-orientation="horizontal"
                    tabIndex={0}
                    title={`Resize ${props.title}`}
                    onPointerDown={resize.handleResizeStart}
                    onPointerMove={resize.handleResizeMove}
                    onPointerUp={resize.handleResizeEnd}
                    onPointerCancel={resize.handleResizeEnd}
                    onKeyDown={resize.handleResizeKeyDown}
                    className={`absolute inset-x-0 top-0 z-20 h-2 touch-none cursor-row-resize transition-colors focus:outline-none focus-visible:bg-blue-400/40 ${
                        resize.isResizing
                            ? "bg-blue-400/40"
                            : "hover:bg-blue-400/25"
                    }`}
                />
            )}
            <div className="flex min-h-0 max-w-full flex-1 flex-col px-4 py-3">
                <div
                    ref={resize.headerRef}
                    className="flex shrink-0 flex-wrap items-center gap-3"
                >
                    <div className="flex min-w-0 items-center gap-3">
                        {props.icon ? (
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-800 text-slate-300">
                                {props.icon}
                            </div>
                        ) : null}
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-sm font-semibold text-slate-100">
                                    {props.title}
                                </h2>
                                {props.badge}
                            </div>
                            <p className="truncate text-xs text-slate-500">
                                {props.description}
                            </p>
                        </div>
                    </div>
                    {props.actionsAlignment === "start" ? (
                        <div className="flex min-w-0 items-center">
                            {props.actions}
                        </div>
                    ) : null}
                    <div className="ml-auto flex min-w-0 items-center gap-1">
                        {props.actionsAlignment === "start"
                            ? null
                            : props.actions}
                        <div className="mx-1 h-5 w-px bg-slate-800" />
                        <button
                            type="button"
                            aria-label={toggleLabel}
                            title={toggleLabel}
                            aria-expanded={!isCollapsed}
                            onClick={() => setIsCollapsed(!isCollapsed)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                        >
                            {isCollapsed ? (
                                <ChevronUp className="h-4 w-4" />
                            ) : (
                                <ChevronDown className="h-4 w-4" />
                            )}
                        </button>
                    </div>
                </div>

                {props.keepChildrenMounted ? (
                    <div
                        hidden={isCollapsed}
                        aria-hidden={isCollapsed}
                        className="mt-3 min-h-0 flex-1 overflow-auto border-t border-slate-800 pt-3"
                    >
                        {props.children}
                    </div>
                ) : isCollapsed ? null : (
                    <div className="mt-3 min-h-0 flex-1 overflow-auto border-t border-slate-800 pt-3">
                        {props.children}
                    </div>
                )}
            </div>
        </section>
    );
}

/** Manages pointer and keyboard resizing without coupling layout mechanics to panel content. */
function useBottomPanelResize(props: {
    isCollapsed: boolean;
    defaultExpandedHeight?: number;
}) {
    const [expandedHeight, setExpandedHeight] = React.useState<number | null>(
        props.defaultExpandedHeight ?? null,
    );
    const [isResizing, setIsResizing] = React.useState(false);
    const panelRef = React.useRef<HTMLElement | null>(null);
    const headerRef = React.useRef<HTMLDivElement | null>(null);
    const resizeRef = React.useRef<{
        pointerId: number;
        startY: number;
        startHeight: number;
        minHeight: number;
        maxHeight: number;
    } | null>(null);

    /** Bounds resizing to the header and the space above the panel's fixed bottom edge. */
    const getHeightBounds = () => {
        const panel = panelRef.current;
        const header = headerRef.current;
        if (!panel || !header) {
            return null;
        }

        const panelRect = panel.getBoundingClientRect();
        const parentTop = panel.parentElement?.getBoundingClientRect().top ?? 0;
        return {
            currentHeight: panelRect.height,
            minHeight: header.getBoundingClientRect().height + 48,
            maxHeight: Math.max(panelRect.height, panelRect.bottom - parentTop),
        };
    };

    /** Starts top-edge dragging so upward movement gives the panel more room. */
    const handleResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
        if (props.isCollapsed || event.button !== 0) {
            return;
        }
        const bounds = getHeightBounds();
        if (!bounds) {
            return;
        }

        resizeRef.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startHeight: bounds.currentHeight,
            minHeight: bounds.minHeight,
            maxHeight: bounds.maxHeight,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsResizing(true);
        event.preventDefault();
    };

    /** Applies a drag while keeping the panel within its measured layout bounds. */
    const handleResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const activeResize = resizeRef.current;
        if (!activeResize || activeResize.pointerId !== event.pointerId) {
            return;
        }

        setExpandedHeight(
            Math.min(
                activeResize.maxHeight,
                Math.max(
                    activeResize.minHeight,
                    activeResize.startHeight +
                        activeResize.startY -
                        event.clientY,
                ),
            ),
        );
    };

    /** Ends pointer capture without changing the size selected by the user. */
    const handleResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
        if (resizeRef.current?.pointerId !== event.pointerId) {
            return;
        }

        resizeRef.current = null;
        setIsResizing(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    /** Gives keyboard users the same directional resizing as top-edge dragging. */
    const handleResizeKeyDown = (
        event: React.KeyboardEvent<HTMLDivElement>,
    ) => {
        if (
            props.isCollapsed ||
            (event.key !== "ArrowUp" && event.key !== "ArrowDown")
        ) {
            return;
        }
        const bounds = getHeightBounds();
        if (!bounds) {
            return;
        }

        const currentHeight = expandedHeight ?? bounds.currentHeight;
        const delta = event.key === "ArrowUp" ? 24 : -24;
        setExpandedHeight(
            Math.min(
                bounds.maxHeight,
                Math.max(bounds.minHeight, currentHeight + delta),
            ),
        );
        event.preventDefault();
    };

    return {
        expandedHeight,
        isResizing,
        panelRef,
        headerRef,
        handleResizeStart,
        handleResizeMove,
        handleResizeEnd,
        handleResizeKeyDown,
    };
}
