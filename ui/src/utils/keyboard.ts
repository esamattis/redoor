/** Identifies text controls where application shortcuts must not intercept typing. */
export function isTextEntryElement(
    target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement {
    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
    );
}

/** Keeps unmodified application shortcuts separate from browser and text-editing keys. */
export function shouldIgnoreKeyboardShortcut(
    event: KeyboardEvent,
    options?: { shift?: boolean },
) {
    return (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (options?.shift === true && event.shiftKey) ||
        isTextEntryElement(event.target)
    );
}
