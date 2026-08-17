import * as React from "react";

/** Follows ThemeManager's document class so editors switch without duplicating OS resolution. */
export function useResolvedTheme(): "dark" | "light" {
    return React.useSyncExternalStore(
        (onStoreChange) => {
            const observer = new MutationObserver(onStoreChange);
            observer.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ["class", "data-theme"],
            });
            return () => observer.disconnect();
        },
        () =>
            document.documentElement.dataset.theme === "light"
                ? "light"
                : "dark",
        () => "dark",
    );
}
