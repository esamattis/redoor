import * as React from "react";
import { flushSync } from "react-dom";

type TailwindBreakpoint = "sm" | "md" | "lg" | "xl" | "2xl";

/**
 * Container sizes the JS hook may compare against. Tailwind only emits the theme variables
 * that styles use, so a size belongs here only while `@xl:`-style classes reference it.
 */
type TailwindContainerSize = "xl";

/** Reads a Tailwind theme breakpoint so JS media queries stay aligned with `sm:` classes. */
function belowBreakpointQuery(breakpoint: TailwindBreakpoint): string {
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(`--breakpoint-${breakpoint}`)
        .trim();

    return `(width < ${value})`;
}

/**
 * Tracks the viewport against a Tailwind breakpoint instead of a hardcoded pixel width. Only
 * shell decisions such as drawers and modal dialogs belong here; page content must follow
 * the content column with `useIsContentBelow`, since the side menus can make it narrow.
 */
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

/**
 * The `@container/main` element around the routed content and its top and bottom chrome.
 * JS layout decisions measure it so they switch together with the `@xl:` style classes.
 */
export const ContentContainerContext = React.createContext<HTMLElement | null>(
    null,
);

/** Pixel thresholds already read from the theme, keyed by container size token. */
const containerSizeCache = new Map<TailwindContainerSize, number>();

/**
 * Converts a Tailwind container size token to pixels. The theme stores rems, and the root
 * font size follows the reader's browser setting, so the conversion cannot be a constant.
 * The result is cached because every `useIsContentBelow` mount would otherwise force a style
 * recalculation; a changed browser font size is picked up on the next page load.
 */
function containerSizeInPixels(size: TailwindContainerSize): number {
    const cached = containerSizeCache.get(size);

    if (cached !== undefined) {
        return cached;
    }

    const root = getComputedStyle(document.documentElement);
    const value = root.getPropertyValue(`--container-${size}`).trim();

    const pixels = value.endsWith("rem")
        ? parseFloat(value) * parseFloat(root.fontSize)
        : parseFloat(value);

    containerSizeCache.set(size, pixels);

    return pixels;
}

/**
 * Tracks the content column against a Tailwind container size, matching the `@max-xl:`
 * style variants. Media queries cannot see the column, which shrinks when side menus are
 * shown on a small screen.
 */
export function useIsContentBelow(size: TailwindContainerSize): boolean {
    const container = React.useContext(ContentContainerContext);
    const [isBelow, setIsBelow] = React.useState(false);

    // A layout effect registers the observer before the first frame is painted.
    React.useLayoutEffect(() => {
        if (!container) {
            return;
        }

        const threshold = containerSizeInPixels(size);

        // The width comes from the observer entry instead of measuring the element, because
        // measuring during React's commit forces a synchronous layout for every mounted hook.
        // The first observation is delivered after layout but before paint, and flushSync
        // renders the result in that same frame, so wide controls never flash in a narrow column.
        const observer = new ResizeObserver((entries) => {
            const width = entries.at(-1)?.borderBoxSize[0]?.inlineSize;

            if (width !== undefined) {
                flushSync(() => setIsBelow(width < threshold));
            }
        });

        observer.observe(container);

        return () => observer.disconnect();
    }, [container, size]);

    return isBelow;
}
