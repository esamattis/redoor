import { atomWithStorage, createJSONStorage } from "jotai/utils";

/**
 * Creates a Jotai atom that restores JSON state immediately so navigation does
 * not render with a temporary default value before storage is consulted.
 */
function atomWithBrowserStorage<Value>(
    key: string,
    initialValue: Value,
    getStorage: () => Storage,
) {
    return atomWithStorage(
        key,
        initialValue,
        createJSONStorage<Value>(getStorage),
        { getOnInit: true },
    );
}

/** Survives reloads and new tabs so long-lived navigation memory stays shared. */
export function atomWithLocalStorage<Value>(key: string, initialValue: Value) {
    return atomWithBrowserStorage(key, initialValue, () => window.localStorage);
}

/** Stays on this tab only so a layout experiment does not leak into other sessions. */
export function atomWithSessionStorage<Value>(
    key: string,
    initialValue: Value,
) {
    return atomWithBrowserStorage(
        key,
        initialValue,
        () => window.sessionStorage,
    );
}
