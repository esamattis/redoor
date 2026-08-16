import * as React from "react";

/** Marks the application shell while a touch has become a deliberate scroll gesture. */
export function useTouchChromeVisibility() {
    const topChromeRef = React.useRef<HTMLDivElement | null>(null);
    const bottomChromeRef = React.useRef<HTMLDivElement | null>(null);
    const scrollAreaRef = React.useRef<HTMLElement | null>(null);
    const touchStartXRef = React.useRef<number | null>(null);
    const touchStartYRef = React.useRef<number | null>(null);
    const touchStartScrollTopRef = React.useRef<number | null>(null);
    const isTouchActiveRef = React.useRef(false);
    const isScrollingRef = React.useRef(false);
    const scrollStopTimerRef = React.useRef<number | null>(null);
    const restoreTimerRef = React.useRef<number | null>(null);

    React.useLayoutEffect(() => {
        const topChrome = topChromeRef.current;
        const bottomChrome = bottomChromeRef.current;
        const scrollArea = scrollAreaRef.current;
        if (!topChrome || !bottomChrome || !scrollArea) {
            return;
        }

        // The drawer slot stays compact; the absolutely positioned panel is what covers content when open.
        const bottomPanel = bottomChrome.querySelector<HTMLElement>(
            "[data-overlay-bottom-panel]",
        );
        // Keep endpoint space synchronized with overlay chrome as panels and responsive content resize.
        const updateScrollInsets = () => {
            scrollArea.style.setProperty(
                "--top-chrome-height",
                `${topChrome.offsetHeight}px`,
            );
            scrollArea.style.setProperty(
                "--bottom-chrome-height",
                `${(bottomPanel ?? bottomChrome).offsetHeight}px`,
            );
        };
        const resizeObserver = new ResizeObserver(updateScrollInsets);
        resizeObserver.observe(topChrome);
        resizeObserver.observe(bottomChrome);
        if (bottomPanel) {
            resizeObserver.observe(bottomPanel);
        }
        updateScrollInsets();
        return () => resizeObserver.disconnect();
    }, []);

    /** Replaces an older restore so momentum scrolling keeps chrome hidden. */
    const scheduleRestore = () => {
        if (restoreTimerRef.current !== null) {
            window.clearTimeout(restoreTimerRef.current);
        }
        restoreTimerRef.current = window.setTimeout(() => {
            document.documentElement.removeAttribute("data-touch-scrolling");
            touchStartScrollTopRef.current = null;
            restoreTimerRef.current = null;
        }, 100);
    };

    /** Starts restoration only after scroll events have stopped arriving. */
    const scheduleScrollStop = () => {
        if (scrollStopTimerRef.current !== null) {
            window.clearTimeout(scrollStopTimerRef.current);
        }
        scrollStopTimerRef.current = window.setTimeout(() => {
            isScrollingRef.current = false;
            scrollStopTimerRef.current = null;
            if (!isTouchActiveRef.current) {
                scheduleRestore();
            }
        }, 100);
    };

    /** Records the gesture origin without making ordinary taps move the chrome. */
    const handleTouchStart = (event: React.TouchEvent<HTMLElement>) => {
        if (restoreTimerRef.current !== null) {
            window.clearTimeout(restoreTimerRef.current);
            restoreTimerRef.current = null;
        }
        if (scrollStopTimerRef.current !== null) {
            window.clearTimeout(scrollStopTimerRef.current);
            scrollStopTimerRef.current = null;
        }
        isScrollingRef.current = false;
        isTouchActiveRef.current = true;
        touchStartXRef.current = event.touches[0]?.clientX ?? null;
        touchStartYRef.current = event.touches[0]?.clientY ?? null;
        touchStartScrollTopRef.current = event.currentTarget.scrollTop;
    };

    /** Hides chrome only for deliberate vertical gestures, not horizontal scrolling. */
    const handleTouchMove = (event: React.TouchEvent<HTMLElement>) => {
        const startX = touchStartXRef.current;
        const startY = touchStartYRef.current;
        const currentX = event.touches[0]?.clientX;
        const currentY = event.touches[0]?.clientY;
        if (
            startX !== null &&
            startY !== null &&
            currentX !== undefined &&
            currentY !== undefined &&
            Math.abs(currentY - startY) > 50 &&
            Math.abs(currentY - startY) > Math.abs(currentX - startX)
        ) {
            document.documentElement.setAttribute(
                "data-touch-scrolling",
                "true",
            );
        }
    };

    /** Uses actual displacement so fast swipes still hide chrome during momentum scrolling. */
    const handleScroll = (event: React.UIEvent<HTMLElement>) => {
        isScrollingRef.current = true;
        if (restoreTimerRef.current !== null) {
            window.clearTimeout(restoreTimerRef.current);
            restoreTimerRef.current = null;
        }
        scheduleScrollStop();

        const startScrollTop = touchStartScrollTopRef.current;
        if (
            startScrollTop === null ||
            Math.abs(event.currentTarget.scrollTop - startScrollTop) <= 50
        ) {
            return;
        }

        document.documentElement.setAttribute("data-touch-scrolling", "true");
    };

    /** Leaves content unobstructed briefly after scrolling or touch cancellation finishes. */
    const handleTouchEnd = () => {
        isTouchActiveRef.current = false;
        touchStartXRef.current = null;
        touchStartYRef.current = null;
        if (!isScrollingRef.current) {
            scheduleRestore();
        }
    };

    React.useEffect(() => {
        return () => {
            if (restoreTimerRef.current !== null) {
                window.clearTimeout(restoreTimerRef.current);
            }
            if (scrollStopTimerRef.current !== null) {
                window.clearTimeout(scrollStopTimerRef.current);
            }
            document.documentElement.removeAttribute("data-touch-scrolling");
        };
    }, []);

    return {
        topChromeRef,
        bottomChromeRef,
        scrollAreaRef,
        onTouchStart: handleTouchStart,
        onTouchMove: handleTouchMove,
        onTouchEnd: handleTouchEnd,
        onTouchCancel: handleTouchEnd,
        onScroll: handleScroll,
    };
}
