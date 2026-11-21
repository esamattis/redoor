import * as React from "react";
import { ContentContainerContext } from "#ui/utils/use-breakpoint";
import { useTouchChromeVisibility } from "#ui/utils/use-touch-chrome-visibility";

/** Overlays transient chrome while measured scroll padding keeps both endpoints unobstructed. */
export function OverlayChromeLayout(props: {
    topChrome: React.ReactNode;
    bottomChrome: React.ReactNode;
    isBottomChromeFullWindow: boolean;
    children: React.ReactNode;
}) {
    const touchChrome = useTouchChromeVisibility();
    const { topChromeRef, scrollAreaRef, bottomChromeRef } = touchChrome;

    // State rather than a ref, so hooks measuring the column subscribe once it mounts.
    const [contentContainer, setContentContainer] =
        React.useState<HTMLDivElement | null>(null);

    return (
        <ContentContainerContext value={contentContainer}>
            {/* Content responds to this column instead of the viewport, because persistent
                side menus can leave it phone-narrow on a wide screen. The chrome shares it so
                the toolbars and the drawer switch layouts together with the page. */}
            <div
                ref={setContentContainer}
                className="@container/main group/editor-layout relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            >
                <div
                    ref={topChromeRef}
                    className="touch-hide-top-shell absolute inset-x-0 top-0 z-20 translate-y-0 transition-transform duration-200 ease-out motion-reduce:transition-none"
                >
                    {props.topChrome}
                </div>
                {/* The router restores this scroll position on back and forward. The id names it
                stably; otherwise the router finds it by its position among its siblings. */}
                <main
                    ref={scrollAreaRef}
                    data-scroll-restoration-id="app-main"
                    onTouchStart={touchChrome.onTouchStart}
                    onTouchMove={touchChrome.onTouchMove}
                    onTouchEnd={touchChrome.onTouchEnd}
                    onTouchCancel={touchChrome.onTouchCancel}
                    onScroll={touchChrome.onScroll}
                    className="overlay-chrome-scroll-area absolute inset-0 overflow-auto"
                >
                    {props.children}
                </main>
                {/* Keep tools above the full-window editor, but below modal dialogs. */}
                <div
                    ref={bottomChromeRef}
                    className={`touch-hide-bottom-stack z-[65] flex flex-col transition-transform duration-200 ease-out motion-reduce:transition-none ${props.isBottomChromeFullWindow ? "fixed inset-0" : "absolute inset-x-0 bottom-0 translate-y-0 group-has-[[data-editor-full-window=true]]/editor-layout:fixed"}`}
                >
                    {props.bottomChrome}
                </div>
            </div>
        </ContentContainerContext>
    );
}
