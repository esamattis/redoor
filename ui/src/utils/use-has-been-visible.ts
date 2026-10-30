import { type RefObject, useEffect, useState } from "react";

/**
 * The app's scroll area around an element, or null for the window. Content scrolls inside that
 * area, and an observer rooted at the window would clip at its edges, so the margin would
 * never reach the rows just below it. It is found by the attribute the router restores its
 * scroll position by, because reading styles or sizes to find a scrolling ancestor would force
 * a layout for every element that mounts, which made expanding a long diff list crawl.
 */
function scrollArea(element: Element): Element | null {
    return element.closest("[data-scroll-restoration-id]");
}

/**
 * Tells whether an element has come near the visible part of its scroll container, and
 * stays true afterwards. Rows use it to defer work, such as walking a checkout, until
 * someone could see the result, and keep it once started so scrolling back and forth does
 * not cancel and restart it. The margin starts the work a little before the row scrolls in.
 */
export function useHasBeenVisible(
    ref: RefObject<Element | null>,
    rootMargin = "200px",
): boolean {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const element = ref.current;

        if (visible || element === null) {
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setVisible(true);
                }
            },
            { root: scrollArea(element), rootMargin },
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, [ref, rootMargin, visible]);

    return visible;
}
