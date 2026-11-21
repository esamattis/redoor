import * as React from "react";
import { useRouterState } from "@tanstack/react-router";

/**
 * Shows a thin progress bar for slow navigations. It waits 250ms so quick route changes
 * do not flash it.
 */
export function RouteLoadingIndicator() {
    const isLoading = useRouterState({
        select: (state) => state.status === "pending",
    });

    const [delayedVisible, setDelayedVisible] = React.useState(false);

    React.useEffect(() => {
        if (!isLoading) {
            return;
        }

        const showTimer = window.setTimeout(() => {
            setDelayedVisible(true);
        }, 250);

        return () => {
            window.clearTimeout(showTimer);
            setDelayedVisible(false);
        };
    }, [isLoading]);

    const isVisible = isLoading && delayedVisible;

    return (
        <div
            aria-hidden={!isVisible}
            className={`pointer-events-none fixed inset-x-0 top-0 z-50 h-1 overflow-hidden transition-opacity duration-150 ${
                isVisible ? "opacity-100" : "opacity-0"
            }`}
        >
            <div className="route-loading-progress-bar h-full w-full bg-blue-500/10">
                <div className="route-loading-progress-bar__indicator h-full bg-blue-400" />
            </div>
        </div>
    );
}
