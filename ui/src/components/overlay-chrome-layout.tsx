import * as React from "react";
import { useTouchChromeVisibility } from "#ui/utils/use-touch-chrome-visibility";

/** Overlays transient chrome while measured scroll padding keeps both endpoints unobstructed. */
export function OverlayChromeLayout(props: {
    topChrome: React.ReactNode;
    bottomChrome: React.ReactNode;
    isBottomChromeFullWindow: boolean;
    children: React.ReactNode;
}) {
    const touchChrome = useTouchChromeVisibility();

    return (
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div
                ref={touchChrome.topChromeRef}
                className="touch-hide-top-shell absolute inset-x-0 top-0 z-20 translate-y-0 transition-transform duration-200 ease-out motion-reduce:transition-none"
            >
                {props.topChrome}
            </div>
            <main
                ref={touchChrome.scrollAreaRef}
                onTouchStart={touchChrome.onTouchStart}
                onTouchMove={touchChrome.onTouchMove}
                onTouchEnd={touchChrome.onTouchEnd}
                onTouchCancel={touchChrome.onTouchCancel}
                onScroll={touchChrome.onScroll}
                className="overlay-chrome-scroll-area absolute inset-0 overflow-auto"
            >
                {props.children}
            </main>
            <div
                ref={touchChrome.bottomChromeRef}
                className={`touch-hide-bottom-stack flex flex-col transition-transform duration-200 ease-out motion-reduce:transition-none ${props.isBottomChromeFullWindow ? "fixed inset-0 z-[60]" : "absolute inset-x-0 bottom-0 z-20 translate-y-0"}`}
            >
                {props.bottomChrome}
            </div>
        </div>
    );
}
