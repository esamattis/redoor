import * as React from "react";

type TailwindBreakpoint = "sm" | "md" | "lg" | "xl" | "2xl";

/** Reads a Tailwind theme breakpoint so JS media queries stay aligned with `sm:` classes. */
function belowBreakpointQuery(breakpoint: TailwindBreakpoint): string {
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(`--breakpoint-${breakpoint}`)
        .trim();
    return `(width < ${value})`;
}

/** Tracks the viewport against a Tailwind breakpoint instead of a hardcoded pixel width. */
export function useIsBelowBreakpoint(breakpoint: TailwindBreakpoint): boolean {
    const [isBelow, setIsBelow] = React.useState(
        () => window.matchMedia(belowBreakpointQuery(breakpoint)).matches,
    );

    React.useEffect(() => {
        const media = window.matchMedia(belowBreakpointQuery(breakpoint));
        const update = () => {
            setIsBelow(media.matches);
        };
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, [breakpoint]);

    return isBelow;
}
