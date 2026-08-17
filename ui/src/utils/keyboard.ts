/** Identifies text controls where application shortcuts must not intercept typing. */
export function isTextEntryElement(
    target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement {
    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
    );
}

/** Treats the Ghostty session as text entry so file-browser keys stay out of the shell. */
export function isTerminalInputTarget(target: EventTarget | null): boolean {
    return (
        target instanceof Element &&
        target.closest("[data-terminal-input]") !== null
    );
}

/** Treats CodeMirror as text entry so Backspace cannot leave the page and drop a draft. */
export function isEditorInputTarget(target: EventTarget | null): boolean {
    return (
        target instanceof Element &&
        target.closest("[data-file-editor]") !== null
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
        isTextEntryElement(event.target) ||
        isTerminalInputTarget(event.target) ||
        isEditorInputTarget(event.target)
    );
}
