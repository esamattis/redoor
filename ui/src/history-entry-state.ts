/**
 * View state kept per browser history entry, so pressing back shows the view the reader
 * left: the same diffs expanded and the same filter, which the scroll position the router
 * restores depends on, since a list with other files expanded has another height.
 */
import React from "react";
import {
    useRouter,
    useRouterState,
    type ParsedLocation,
} from "@tanstack/react-router";

/**
 * Identifies the history entry of a location. It mirrors the router's
 * `defaultGetScrollRestorationKey`, which keys the restored scroll position the same way, so
 * view state and scroll come back together. `__TSR_key` is only read here, so a rename in
 * TanStack changes one line, and the `href` fallback then keeps state per URL instead.
 */
export function historyEntryKey(location: ParsedLocation) {
    return location.state.__TSR_key ?? location.href;
}

/** How many entries one store keeps, so a long session cannot grow it without bound. */
const MAX_ENTRIES = 100;

/**
 * Holds one kind of view state for every history entry and scope. It lives outside React
 * because opening a file unmounts the view, and the state must outlive that to be there when
 * the reader comes back. Only the most recently written entries are kept, since old entries
 * are rarely revisited.
 */
export class HistoryEntryStore<T> {
    private values = new Map<string, T>();

    /** A store of large values, such as search results, passes a smaller limit. */
    constructor(private readonly maxEntries = MAX_ENTRIES) {}

    get(key: string) {
        return this.values.get(key);
    }

    set(key: string, value: T) {
        // Re-inserting moves the key to the end, so the first key is always the oldest.
        this.values.delete(key);
        this.values.set(key, value);

        if (this.values.size > this.maxEntries) {
            const oldest = this.values.keys().next();

            if (oldest.done !== true) {
                this.values.delete(oldest.value);
            }
        }
    }
}

/** Which entry and scope a view's state is read from and written to. */
type Binding<T> = {
    entry: string;
    scope: string;
    /** The value to show while the store has nothing for this entry and scope yet. */
    seed: T;
    /** The resolved entry last seen, so only a later change of it moves the binding. */
    resolvedEntry: string | undefined;
};

/**
 * Like `useState`, but the value belongs to the history entry on screen and the given scope,
 * such as one directory's changes, and survives the view unmounting.
 *
 * The entry is taken from the router's latest location when the view mounts or its scope
 * changes, never from the live location: that changes as soon as a navigation starts, while
 * this view is still on screen, and would flash another entry's state before it unmounts.
 * A navigation that keeps the view mounted with the same scope, such as a replaced search
 * parameter, is followed once the router resolves it, and the state carries over to the new
 * entry, so the view does not change under the reader.
 *
 * `initial` receives the value of the previous scope when the scope changes, so state that
 * should follow the reader while browsing, such as a filter, can carry over.
 */
export function useHistoryEntryState<T>(options: {
    store: HistoryEntryStore<T>;
    scope: string;
    initial: (previous: T | undefined) => T;
}): [T, (change: (previous: T) => T) => void] {
    const router = useRouter();

    const resolvedEntry = useRouterState({
        select: (state) =>
            state.resolvedLocation === undefined
                ? undefined
                : historyEntryKey(state.resolvedLocation),
    });

    const [binding, setBinding] = React.useState<Binding<T>>(() => ({
        entry: historyEntryKey(router.latestLocation),
        scope: options.scope,
        seed: options.initial(undefined),
        resolvedEntry,
    }));

    // Writes go to the store, which React does not watch, so a write asks for a render.
    const [, rerender] = React.useReducer((count: number) => count + 1, 0);

    const valueOf = (next: Binding<T>) =>
        options.store.get(JSON.stringify([next.entry, next.scope])) ??
        next.seed;

    let current = binding;

    if (options.scope !== binding.scope) {
        current = {
            entry: historyEntryKey(router.latestLocation),
            scope: options.scope,
            seed: options.initial(valueOf(binding)),
            resolvedEntry,
        };
    } else if (resolvedEntry !== binding.resolvedEntry) {
        current = {
            ...binding,
            entry: resolvedEntry ?? binding.entry,
            seed: valueOf(binding),
            resolvedEntry,
        };
    }

    if (current !== binding) {
        // Adjusting state while rendering lets this render already use the new binding.
        setBinding(current);
    }

    const key = JSON.stringify([current.entry, current.scope]);
    const value = valueOf(current);

    // A seed carried over from another scope or entry is only in this render until stored,
    // and coming back to the entry must find it even if the reader never changes it.
    React.useEffect(() => {
        if (options.store.get(key) === undefined) {
            options.store.set(key, current.seed);
        }
    }, [options.store, key, current.seed]);

    // Stable while the entry and scope stay, so memoized children handed a callback built on
    // it, such as a diff list's per-file toggles, do not re-render on every unrelated update.
    const update = React.useCallback(
        (change: (previous: T) => T) => {
            options.store.set(
                key,
                change(options.store.get(key) ?? current.seed),
            );
            rerender();
        },
        [options.store, key, current.seed],
    );

    return [value, update];
}
