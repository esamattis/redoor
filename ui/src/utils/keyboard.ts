/** Identifies text controls where application shortcuts must not intercept typing. */
export function isTextEntryElement(
    target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement {
    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
    );
}

/** Treats the terminal session as text entry so file-browser keys stay out of the shell. */
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

/** Escape must reach Vim instead of blurring, otherwise visual and insert modes cannot exit. */
export function isVimEditorTarget(target: EventTarget | null): boolean {
    return (
        target instanceof Element &&
        target.closest("[data-vim-mode='true']") !== null
    );
}

/**
 * Identifies Alt+letter chords used to escape the editor or terminal without
 * stealing Ctrl/Meta OS bindings or Shift-modified characters.
 */
export function isUnmodifiedAltKey(event: KeyboardEvent, key: string) {
    return (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        (event.key.toLowerCase() === key.toLowerCase() ||
            event.code === `Key${key.toUpperCase()}`)
    );
}

/**
 * Identifies targets that consume ordinary typing: text controls, the terminal and the
 * editor. Unmodified application shortcuts must stay out of them.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
    return (
        isTextEntryElement(target) ||
        isTerminalInputTarget(target) ||
        isEditorInputTarget(target)
    );
}

/**
 * Matches a key pressed without Ctrl, Alt or Meta, so browser and OS chords keep working.
 * Shift is rejected unless the shortcut explicitly tolerates it, because most shortcut keys
 * are lowercase letters whose Shift form is a different command.
 */
export function isPlainKey(
    event: KeyboardEvent,
    key: string,
    options?: { allowShift?: boolean },
): boolean {
    return (
        event.key === key &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (options?.allowShift === true || !event.shiftKey)
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
        isTypingTarget(event.target)
    );
}

/**
 * Apple keyboards label their modifiers ⌘ and ⌥ and the shortcuts use Command where
 * other systems use Ctrl, so shortcut hints must follow the user's platform to be right.
 */
export function isApplePlatform(): boolean {
    return (
        typeof navigator !== "undefined" &&
        /^(Mac|iPhone|iPad|iPod)/.test(navigator.platform)
    );
}

/**
 * A key chord described once and shown in each platform's own notation. `mod` is the
 * primary command modifier: Command on Apple platforms and Ctrl elsewhere.
 */
export type KeyChord = {
    key: string;
    mod?: boolean;
    alt?: boolean;
    shift?: boolean;
};

/**
 * Formats a chord the way the platform's own menus do: `⌥⇧⌘C` on Apple platforms, where
 * modifiers are symbols in a fixed order without separators, and `Ctrl+Shift+C` elsewhere.
 */
export function formatKeyChord(
    chord: KeyChord,
    applePlatform: boolean = isApplePlatform(),
): string {
    const key = chord.key.toUpperCase();

    if (applePlatform) {
        return `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.mod ? "⌘" : ""}${key}`;
    }

    return [
        chord.mod ? "Ctrl" : null,
        chord.alt ? "Alt" : null,
        chord.shift ? "Shift" : null,
        key,
    ]
        .filter((part) => part !== null)
        .join("+");
}
