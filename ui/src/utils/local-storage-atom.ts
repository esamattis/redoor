import { atomWithStorage, createJSONStorage } from "jotai/utils";

/**
 * Creates a Jotai atom that restores JSON state immediately so navigation does
 * not render with a temporary default value before localStorage is consulted.
 */
export function atomWithLocalStorage<Value>(key: string, initialValue: Value) {
    return atomWithStorage(
        key,
        initialValue,
        createJSONStorage<Value>(() => window.localStorage),
        { getOnInit: true },
    );
}
