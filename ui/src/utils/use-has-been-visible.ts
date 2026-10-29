import { type RefObject, useEffect, useState } from "react";

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
            { rootMargin },
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, [ref, rootMargin, visible]);

    return visible;
}
