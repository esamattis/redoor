/** Identifies a completed move without capturing indexes that can go stale mid-gesture. */
export type ItemMove = {
    activeId: string;
    overId: string;
};

/** Selects one subsequence so unrelated entries can keep their original slots. */
export type KeyedScope<T> = {
    keyOf: (item: T) => string;
    inScope: (item: T) => boolean;
};

/**
 * Moves one item by stable key.
 * Returns the same array when the gesture is a no-op so callers can skip persistence.
 * Insertion uses the target's pre-removal index: upward lands before it, downward after it.
 */
export function moveKeyedItems<T>(
    items: T[],
    keyOf: (item: T) => string,
    move: ItemMove,
): T[] {
    const from = items.findIndex((item) => keyOf(item) === move.activeId);
    const to = items.findIndex((item) => keyOf(item) === move.overId);
    if (from < 0 || to < 0 || from === to) {
        return items;
    }
    const next = items.slice();
    const moved = next.splice(from, 1)[0];
    if (moved === undefined) {
        return items;
    }
    next.splice(to, 0, moved);
    return next;
}

/**
 * Reorders one filtered subsequence and writes it back into that scope's original slots.
 * Other entries stay put, so a per-device move cannot replace the global array.
 */
export function moveKeyedSubsequence<T>(
    items: T[],
    scope: KeyedScope<T>,
    move: ItemMove,
): T[] {
    const selected = items.filter((item) => scope.inScope(item));
    const moved = moveKeyedItems(selected, scope.keyOf, move);
    if (moved === selected) {
        return items;
    }
    let index = 0;
    return items.map((item) => {
        if (!scope.inScope(item)) {
            return item;
        }
        const replacement = moved[index];
        index += 1;
        return replacement ?? item;
    });
}
