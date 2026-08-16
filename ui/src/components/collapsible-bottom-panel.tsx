import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { BottomDrawerTabId } from "#ui/bottom-drawer-state";

/** Describes one mounted pane and its compact representation in the drawer tab strip. */
export type BottomDrawerTab = {
    id: BottomDrawerTabId;
    label: string;
    icon?: React.ReactNode;
    badge?: React.ReactNode;
    content: React.ReactNode;
};

/** Keeps persistent tools in one resizable drawer without unmounting inactive panes. */
export function TabbedBottomDrawer(props: {
    tabs: BottomDrawerTab[];
    activeTab: BottomDrawerTabId;
    isCollapsed: boolean;
    onActiveTabChange: (tab: BottomDrawerTabId) => void;
    onCollapsedChange: (isCollapsed: boolean) => void;
}) {
    const resize = useBottomPanelResize({
        isCollapsed: props.isCollapsed,
        defaultExpandedHeight: 400,
    });
    const toggleLabel = props.isCollapsed
        ? "Expand bottom drawer"
        : "Minimize bottom drawer";

    /** Activates a primary pane and reveals the drawer after a direct tab click. */
    const activateTab = (tab: BottomDrawerTabId) => {
        props.onActiveTabChange(tab);
        props.onCollapsedChange(false);
    };

    /** Gives the primary tab strip conventional horizontal arrow navigation. */
    const handleTabKeyDown = (
        event: React.KeyboardEvent<HTMLButtonElement>,
        tabIndex: number,
    ) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
            return;
        }
        const offset = event.key === "ArrowRight" ? 1 : -1;
        const nextIndex =
            (tabIndex + offset + props.tabs.length) % props.tabs.length;
        const nextTab = props.tabs[nextIndex];
        if (!nextTab) {
            return;
        }
        activateTab(nextTab.id);
        document.getElementById(`bottom-drawer-tab-${nextTab.id}`)?.focus();
        event.preventDefault();
    };

    return (
        <div
            data-collapsed={props.isCollapsed}
            className="relative z-10 h-[49px] shrink-0"
        >
            <section
                ref={resize.panelRef}
                style={
                    !props.isCollapsed && resize.expandedHeight !== null
                        ? { height: resize.expandedHeight }
                        : undefined
                }
                aria-label="Application tools"
                data-overlay-bottom-panel=""
                className="absolute inset-x-0 bottom-0 flex min-h-0 flex-col overflow-hidden border-t border-slate-800 bg-[#11141b]/95 shadow-[0_-10px_30px_-12px_rgba(0,0,0,0.6)] backdrop-blur supports-backdrop-filter:bg-[#11141b]/80"
            >
                {props.isCollapsed ? null : (
                    <div
                        role="separator"
                        aria-label="Resize bottom drawer"
                        aria-orientation="horizontal"
                        tabIndex={0}
                        title="Resize bottom drawer"
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
                <div
                    className={`flex min-h-0 max-w-full flex-col px-2 sm:px-4 ${props.isCollapsed ? "py-1.5" : "flex-1 py-2"}`}
                >
                    <div
                        ref={resize.headerRef}
                        className="flex min-w-0 shrink-0 items-center gap-1"
                    >
                        <div
                            role="tablist"
                            aria-label="Application tools"
                            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain"
                        >
                            {props.tabs.map((tab, tabIndex) => {
                                const isActive = tab.id === props.activeTab;
                                return (
                                    <button
                                        key={tab.id}
                                        id={`bottom-drawer-tab-${tab.id}`}
                                        type="button"
                                        role="tab"
                                        aria-selected={isActive}
                                        aria-controls={`bottom-drawer-panel-${tab.id}`}
                                        tabIndex={isActive ? 0 : -1}
                                        onClick={() => activateTab(tab.id)}
                                        onKeyDown={(event) =>
                                            handleTabKeyDown(event, tabIndex)
                                        }
                                        className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs font-medium transition-colors sm:px-3 ${
                                            isActive
                                                ? "bg-slate-800 text-slate-100"
                                                : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                                        }`}
                                    >
                                        {tab.icon}
                                        <span>{tab.label}</span>
                                        {tab.badge ? (
                                            <span className="max-w-32 truncate rounded bg-slate-950/60 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-400 sm:max-w-48">
                                                {tab.badge}
                                            </span>
                                        ) : null}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <div className="mx-1 h-5 w-px bg-slate-800" />
                            <button
                                type="button"
                                aria-label={toggleLabel}
                                title={toggleLabel}
                                aria-expanded={!props.isCollapsed}
                                onClick={() =>
                                    props.onCollapsedChange(!props.isCollapsed)
                                }
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                            >
                                {props.isCollapsed ? (
                                    <ChevronUp className="h-4 w-4" />
                                ) : (
                                    <ChevronDown className="h-4 w-4" />
                                )}
                            </button>
                        </div>
                    </div>

                    <div
                        hidden={props.isCollapsed}
                        aria-hidden={props.isCollapsed}
                        className="mt-2 min-h-0 flex-1 overflow-hidden border-t border-slate-800 pt-2"
                    >
                        {props.tabs.map((tab) => {
                            const isActive = tab.id === props.activeTab;
                            return (
                                <div
                                    key={tab.id}
                                    id={`bottom-drawer-panel-${tab.id}`}
                                    role="tabpanel"
                                    aria-labelledby={`bottom-drawer-tab-${tab.id}`}
                                    hidden={!isActive}
                                    aria-hidden={!isActive}
                                    className="h-full min-h-0"
                                >
                                    {tab.content}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </section>
        </div>
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
        return {
            currentHeight: panelRect.height,
            minHeight: header.getBoundingClientRect().height + 48,
            maxHeight: Math.max(panelRect.height, window.innerHeight * 0.85),
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
