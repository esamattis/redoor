import * as React from "react";
import { useAtom } from "jotai";

import { sidebarFilesSplitAtom } from "#ui/side-menu-state";
import { cn } from "#ui/utils/cn";
import { shouldIgnoreKeyboardShortcut } from "#ui/utils/keyboard";

/** Smallest and largest share of the column the open files can be dragged to. */
const minFilesSplitPercent = 10;

const maxFilesSplitPercent = 90;

/**
 * Drives the split between the open files and the changed files. The split is stored as a
 * share of the column rather than pixels, so it still fits when the window height changes.
 */
export function useSidebarFilesSplit() {
    const [percent, setPercent] = useAtom(sidebarFilesSplitAtom);
    const [isResizing, setIsResizing] = React.useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const openFilesRef = React.useRef<HTMLDivElement>(null);

    const drag = React.useRef<{
        pointerId: number;
        startY: number;
        startPercent: number;
    } | null>(null);

    /** Measures the current share so dragging from the automatic size does not jump. */
    const measurePercent = () => {
        const container = containerRef.current?.clientHeight ?? 0;
        const openFiles = openFilesRef.current?.offsetHeight ?? 0;

        return container > 0 ? (openFiles / container) * 100 : 50;
    };

    /** Keeps both lists visible whatever the pointer or keyboard asks for. */
    const update = (next: number) => {
        setPercent(
            Math.round(
                Math.max(
                    minFilesSplitPercent,
                    Math.min(maxFilesSplitPercent, next),
                ),
            ),
        );
    };

    /** Captures the pointer so the drag continues after leaving the thin handle. */
    const handleStart = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || drag.current) {
            return;
        }

        drag.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startPercent: measurePercent(),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus();
        setIsResizing(true);
        event.preventDefault();
    };

    /** Converts the pointer travel into a share of the column's height. */
    const handleMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const active = drag.current;
        const height = containerRef.current?.clientHeight ?? 0;

        if (active?.pointerId === event.pointerId && height > 0) {
            update(
                active.startPercent +
                    ((event.clientY - active.startY) / height) * 100,
            );
        }
    };

    /** Clears drag feedback even when the browser cancels the capture. */
    const handleEnd = (event: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId !== event.pointerId) {
            return;
        }

        drag.current = null;
        setIsResizing(false);

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    /** Lets a focused separator move the split without a pointer. */
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (
            shouldIgnoreKeyboardShortcut(event.nativeEvent, { shift: true }) ||
            (event.key !== "ArrowUp" && event.key !== "ArrowDown")
        ) {
            return;
        }

        event.preventDefault();
        update(
            (percent ?? measurePercent()) +
                (event.key === "ArrowDown" ? 5 : -5),
        );
    };

    return {
        percent,
        isResizing,
        containerRef,
        openFilesRef,
        handleStart,
        handleMove,
        handleEnd,
        handleKeyDown,
        /** Goes back to sizing the open files by their rows. */
        reset: () => setPercent(null),
    };
}

/**
 * The drag border between the open files and the changed files. Double-clicking it returns
 * to the automatic size, so a dragged split is never stuck.
 */
export function SidebarFilesSplitHandle(props: {
    split: ReturnType<typeof useSidebarFilesSplit>;
    /** Phones get a taller grip, because a finger needs a bigger target than a pointer. */
    isCompact: boolean;
}) {
    const split = props.split;

    return (
        <div
            role="separator"
            aria-label="Resize open files"
            aria-orientation="horizontal"
            aria-description="Drag or use the up and down arrow keys to resize, double-click to fit the open files"
            aria-valuemin={minFilesSplitPercent}
            aria-valuemax={maxFilesSplitPercent}
            aria-valuenow={split.percent ?? undefined}
            tabIndex={0}
            onPointerDown={split.handleStart}
            onPointerMove={split.handleMove}
            onPointerUp={split.handleEnd}
            onPointerCancel={split.handleEnd}
            onLostPointerCapture={split.handleEnd}
            onKeyDown={split.handleKeyDown}
            onDoubleClick={split.reset}
            className={cn(
                "group flex shrink-0 touch-none cursor-row-resize items-center select-none focus:outline-none",
                props.isCompact ? "h-6" : "h-3",
            )}
        >
            <span
                aria-hidden="true"
                className={cn(
                    "h-px w-full bg-slate-700/60 group-hover:h-0.5 group-hover:bg-blue-400/50 group-focus-visible:h-0.5 group-focus-visible:bg-blue-400/70",
                    split.isResizing && "h-0.5 bg-blue-400/70",
                )}
            />
        </div>
    );
}
