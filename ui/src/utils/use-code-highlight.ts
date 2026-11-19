import * as React from "react";
import type { Language, LanguageDescription } from "@codemirror/language";
import type * as CodeHighlight from "#ui/utils/code-highlight";

/*
 * The React side of read-only highlighting, without CodeMirror itself. The highlighter and
 * its grammars are loaded on first use, so views that only sometimes show code, such as
 * diffs, do not put CodeMirror's parsers into the bundle every page downloads. Code renders
 * as plain text until they have loaded.
 */

/** What to highlight with: a grammar that may still have to load, or none. */
export type HighlightLanguageSource = LanguageDescription | null;

/** The highlighter module once loaded, so later renders get it synchronously. */
let codeHighlight: typeof CodeHighlight | null = null;

let codeHighlightLoad: Promise<void> | null = null;

/** Starts loading the highlighter once and tells the subscriber when it has arrived. */
function subscribeToCodeHighlight(onLoaded: () => void) {
    if (codeHighlight !== null) {
        return () => {};
    }

    const load = (codeHighlightLoad ??= import("#ui/utils/code-highlight").then(
        (module) => {
            codeHighlight = module;
        },
        () => {
            // Forgotten, so the next view tries again; the code stays plain meanwhile.
            codeHighlightLoad = null;
        },
    ));

    let active = true;

    void load.then(() => {
        if (active) {
            onLoaded();
        }
    });

    return () => {
        active = false;
    };
}

/** Reads the loaded highlighter, for `useSyncExternalStore`. */
function codeHighlightSnapshot() {
    return codeHighlight;
}

/**
 * The highlighter module, or null while it loads. Picking a grammar needs CodeMirror's
 * language data, so callers ask the module for one once it is here.
 */
export function useCodeHighlight(): typeof CodeHighlight | null {
    return React.useSyncExternalStore(
        subscribeToCodeHighlight,
        codeHighlightSnapshot,
        codeHighlightSnapshot,
    );
}

/** One load per grammar, shared by every component waiting for it. */
const loads = new Map<LanguageDescription, Promise<void>>();

/** Starts loading a grammar once; a failed load leaves the code plain rather than broken. */
function loadDescription(description: LanguageDescription): Promise<void> {
    const existing = loads.get(description);

    if (existing !== undefined) {
        return existing;
    }

    const load = description.load().then(
        () => undefined,
        () => undefined,
    );

    loads.set(description, load);

    return load;
}

/**
 * Loads a source's grammar, resolving to null when there is none or it failed to load, so
 * tests can highlight without the render-then-update dance components go through.
 */
export async function loadHighlightLanguage(
    source: HighlightLanguageSource,
): Promise<Language | null> {
    if (source === null) {
        return null;
    }

    await loadDescription(source);

    return readyLanguage(source);
}

/** The grammar of a source if it is ready, otherwise null. */
function readyLanguage(source: HighlightLanguageSource): Language | null {
    return source?.support?.language ?? null;
}

/**
 * Resolves a grammar for rendering. A grammar that has to load renders as plain text first
 * and re-renders once loaded, without suspending, so the code is readable immediately.
 */
export function useLoadedLanguage(
    source: HighlightLanguageSource,
): Language | null {
    const subscribe = React.useCallback(
        (onLoaded: () => void) => {
            if (source === null || source.support !== undefined) {
                return () => {};
            }

            let active = true;

            void loadDescription(source).then(() => {
                if (active) {
                    onLoaded();
                }
            });

            return () => {
                active = false;
            };
        },
        [source],
    );

    const snapshot = () => readyLanguage(source);

    return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}
