import React from "react";
import { shouldIgnoreKeyboardShortcut } from "#ui/utils/keyboard";

/** Moves focus through the current ordered elements returned by a component. */
export function useArrayKeyboardFocus(
    getElements: () => HTMLElement[],
    enabled = true,
) {
    React.useEffect(() => {
        if (!enabled) {
            return;
        }

        /** Advances without wrapping so repeated keys remain at list boundaries. */
        const handleKeyDown = (event: KeyboardEvent) => {
            if (
                (event.key !== "j" && event.key !== "k") ||
                shouldIgnoreKeyboardShortcut(event, { shift: true })
            ) {
                return;
            }

            const elements = getElements();
            if (elements.length === 0) {
                return;
            }

            event.preventDefault();
            const focusedIndex = elements.findIndex(
                (element) => element === document.activeElement,
            );
            const nextIndex =
                event.key === "j"
                    ? Math.min(focusedIndex + 1, elements.length - 1)
                    : focusedIndex === -1
                      ? elements.length - 1
                      : Math.max(focusedIndex - 1, 0);
            elements[nextIndex]?.focus();
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [enabled, getElements]);
}
