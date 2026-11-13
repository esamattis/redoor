import * as React from "react";
import { getRouteApi } from "@tanstack/react-router";
import {
    queryOptions,
    useQuery,
    useQueryClient,
    type QueryClient,
} from "@tanstack/react-query";
import { atom, useStore, type createStore } from "jotai";
import { z } from "zod";
import type { ApiClient } from "#ui/api-client";
import type { CaretReport } from "#ui/editor/editor-workspace";
import { queryKeys } from "#ui/queries";
import { getErrorMessage } from "#ui/utils/error";
import {
    moveKeyedItems,
    moveKeyedSubsequence,
    type ItemMove,
} from "#ui/utils/reorder";

const rootRouteApi = getRouteApi("__root__");

/** One remembered path so the agent list can restore a specific file or directory. */
export const bookmarkSchema = z.object({
    agentId: z.string(),
    path: z.string(),
    name: z.string(),
    entryType: z.enum(["file", "directory"]),
});

export type Bookmark = z.infer<typeof bookmarkSchema>;

/**
 * A line to select and center the next time an open file is shown, set when the file is
 * opened from a diff or search result without going to it. `id` tells a new request apart
 * from one already applied: the file's buffer remembers the applied id, so the line is
 * shown once, on whichever computer shows the file first, and never again after that.
 */
export const openFileRevealSchema = z.object({
    line: z.number().int().min(1),
    id: z.string(),
});

export type OpenFileReveal = z.infer<typeof openFileRevealSchema>;

/**
 * One open editor file, listed in the left menu so it can be reopened without browsing. Its
 * buffer (unsaved text, caret, undo history) is kept on the server while it stays open.
 */
export const openFileSchema = z.object({
    agentId: z.string(),
    path: z.string(),
    name: z.string(),
    agentName: z.string(),
    /**
     * The caret line, so the menu can show where the file was left without loading its
     * buffer, which may be megabytes. It follows the buffer's writes and a line request.
     */
    line: z.number().int().min(1).optional().catch(undefined),
    // A malformed request only loses the line, never the open file itself.
    reveal: openFileRevealSchema.optional().catch(undefined),
    /**
     * When the file was last opened, shown, left or edited, in epoch milliseconds, so files
     * the user has stopped working on can be closed automatically. Files opened before this
     * was recorded have none until the auto-close sweep stamps them.
     */
    touchedAt: z.number().optional().catch(undefined),
});

export type OpenFile = z.infer<typeof openFileSchema>;

/**
 * Terminal tab order and the active tab, by server session id, so a reload restores the
 * tabs as the user arranged them. Ids of sessions that no longer exist are ignored.
 */
export const terminalTabsSchema = z.object({
    order: z.array(z.string()).catch([]),
    active: z.string().nullable().catch(null),
});

export type TerminalTabs = z.infer<typeof terminalTabsSchema>;

/** Shortest auto-close delay, so a file is never closed while the user steps away briefly. */
export const MIN_AUTO_CLOSE_HOURS = 1;

/** Longest auto-close delay; anyone wanting more can turn auto-close off instead. */
export const MAX_AUTO_CLOSE_HOURS = 24 * 365;

/**
 * How stale an open file's `touchedAt` may get before a caret report refreshes it. Buffer
 * writes come with every debounced edit, so refreshing on each would turn typing into a
 * stream of settings writes; minutes are far finer than any auto-close delay.
 */
export const TOUCH_REFRESH_MS = 10 * 60 * 1000;

/** Known UI preferences; extra server keys are ignored until they have a schema. */
export const userStateSchema = z.object({
    showHiddenFiles: z.boolean().catch(true),
    theme: z.enum(["system", "dark", "light"]).catch("system"),
    bookmarks: z.array(bookmarkSchema).catch([]),
    openFiles: z.array(openFileSchema).catch([]),
    vimMode: z.boolean().catch(false),
    autoCloseOpenFiles: z.boolean().catch(true),
    autoCloseOpenFilesAfterHours: z
        .number()
        .int()
        .min(MIN_AUTO_CLOSE_HOURS)
        .max(MAX_AUTO_CLOSE_HOURS)
        .catch(24),
    wrapEditorLines: z.boolean().catch(false),
    recursiveSearchTimeoutSeconds: z.number().int().min(1).max(60).catch(5),
    recursiveSearchIncludeHidden: z.boolean().catch(false),
    recursiveSearchRespectGitignore: z.boolean().catch(true),
    deviceOrder: z.array(z.string()).catch([]),
    showOnlyConnectedDevices: z.boolean().catch(false),
    terminalTabs: terminalTabsSchema.catch({ order: [], active: null }),
});

export type UserState = z.infer<typeof userStateSchema>;

/**
 * Derived from the schema's `.catch()` fallbacks, so a default can only be declared in one place
 * and a new preference cannot be forgotten here.
 */
export const defaultUserState: UserState = userStateSchema.parse({});

/** Identifies one bookmarked path so the same file cannot be stored twice. */
export function getBookmarkKey(bookmark: Pick<Bookmark, "agentId" | "path">) {
    return `${bookmark.agentId}:${bookmark.path}`;
}

/** Lets menus and the agent list share one membership check. */
export function isPathBookmarked(
    bookmarks: Bookmark[],
    target: Pick<Bookmark, "agentId" | "path">,
) {
    const targetKey = getBookmarkKey(target);

    return bookmarks.some((bookmark) => getBookmarkKey(bookmark) === targetKey);
}

/**
 * Identifies one open file so the same path cannot be listed twice. It is also the key of
 * the file's editor buffer, which the server derives the same way from the open files list.
 */
export function getOpenFileKey(file: Pick<OpenFile, "agentId" | "path">) {
    return `${file.agentId}:${file.path}`;
}

/** Lets the editor button and the left menu share one membership check. */
export function isFileOpen(
    openFiles: OpenFile[],
    target: Pick<OpenFile, "agentId" | "path">,
) {
    const targetKey = getOpenFileKey(target);

    return openFiles.some((file) => getOpenFileKey(file) === targetKey);
}

/**
 * Appends a newly opened file so later files stay below earlier ones.
 * Opening a file that is already open keeps its place instead of jumping to the bottom.
 */
export function openFile(
    openFiles: OpenFile[],
    file: OpenFile,
    now = Date.now(),
) {
    if (isFileOpen(openFiles, file)) {
        return openFiles;
    }

    return [...openFiles, { ...file, touchedAt: now }];
}

/**
 * Opens a file without going to it, from a diff or search result. With a line, the file is
 * also asked to show that line the next time it is shown; an already open file keeps its
 * place in the list and only gets the new line, since the user asked to look there now. The
 * shown caret line moves along at once, so the menu confirms the click before any visit.
 */
export function openFileAtLine(
    openFiles: OpenFile[],
    file: OpenFile,
    reveal: OpenFileReveal | undefined,
) {
    const now = Date.now();

    if (reveal === undefined) {
        return openFile(openFiles, file, now);
    }

    if (!isFileOpen(openFiles, file)) {
        return [
            ...openFiles,
            { ...file, reveal, line: reveal.line, touchedAt: now },
        ];
    }

    const targetKey = getOpenFileKey(file);

    return openFiles.map((entry) =>
        getOpenFileKey(entry) === targetKey
            ? { ...entry, reveal, line: reveal.line, touchedAt: now }
            : entry,
    );
}

/**
 * Records where an open file's caret is, as its buffer is written, and that the file was
 * touched, since a buffer is only written when the user edits or scrolls it. An unchanged
 * line with a recent touch keeps the same list, so moving within a line or retyping it
 * sends no settings write. While a line request the buffer has not applied is pending, the
 * caret has not gone there yet, so the requested line stays listed.
 */
export function setOpenFileLine(
    openFiles: OpenFile[],
    caret: CaretReport,
    now = Date.now(),
) {
    const target = openFiles.find((file) => getOpenFileKey(file) === caret.key);

    if (
        target === undefined ||
        (target.reveal !== undefined &&
            target.reveal.id !== caret.appliedReveal)
    ) {
        return openFiles;
    }

    const isTouchFresh =
        target.touchedAt !== undefined &&
        now - target.touchedAt < TOUCH_REFRESH_MS;

    if (target.line === caret.line && isTouchFresh) {
        return openFiles;
    }

    return openFiles.map((file) =>
        file === target ? { ...file, line: caret.line, touchedAt: now } : file,
    );
}

/**
 * Marks open files as touched now, when one is shown or left. Unknown keys are ignored, so a
 * file closed meanwhile is not brought back, and an untouched list keeps its identity.
 */
export function touchOpenFiles(
    openFiles: OpenFile[],
    keys: ReadonlySet<string>,
    now = Date.now(),
) {
    if (!openFiles.some((file) => keys.has(getOpenFileKey(file)))) {
        return openFiles;
    }

    return openFiles.map((file) =>
        keys.has(getOpenFileKey(file)) ? { ...file, touchedAt: now } : file,
    );
}

/**
 * The open files untouched for longer than the user's auto-close delay, which the sweep
 * closes unless they have unsaved changes or are on screen. Files without a touch time are
 * not stale: the sweep stamps them first, so they get the full delay from then on.
 */
export function getStaleOpenFiles(
    userState: Pick<
        UserState,
        "openFiles" | "autoCloseOpenFiles" | "autoCloseOpenFilesAfterHours"
    >,
    now = Date.now(),
): OpenFile[] {
    if (!userState.autoCloseOpenFiles) {
        return [];
    }

    const maxAgeMs = userState.autoCloseOpenFilesAfterHours * 60 * 60 * 1000;

    return userState.openFiles.filter(
        (file) =>
            file.touchedAt !== undefined && now - file.touchedAt > maxAgeMs,
    );
}

/** Gives files opened before touch times were recorded one now, so their delay can start. */
export function stampUntouchedOpenFiles(
    openFiles: OpenFile[],
    now = Date.now(),
) {
    if (openFiles.every((file) => file.touchedAt !== undefined)) {
        return openFiles;
    }

    return openFiles.map((file) =>
        file.touchedAt === undefined ? { ...file, touchedAt: now } : file,
    );
}

/** Drops one open file without reordering the files that remain. */
export function closeFile(
    openFiles: OpenFile[],
    target: Pick<OpenFile, "agentId" | "path">,
) {
    const targetKey = getOpenFileKey(target);

    return openFiles.filter((file) => getOpenFileKey(file) !== targetKey);
}

/** Shares open file order between the sidebar and the menu drawer over the editor. */
export function reorderOpenFiles(openFiles: OpenFile[], move: ItemMove) {
    return moveKeyedItems(openFiles, getOpenFileKey, move);
}

/**
 * Reorders one device's bookmarks inside the global list.
 * Other devices keep their slots so a local drag cannot transfer ownership.
 */
export function reorderBookmarks(
    bookmarks: Bookmark[],
    agentId: string,
    move: ItemMove,
) {
    return moveKeyedSubsequence(
        bookmarks,
        {
            keyOf: getBookmarkKey,
            inScope: (bookmark) => bookmark.agentId === agentId,
        },
        move,
    );
}

/** Drops repeated saved ids so the first remembered placement wins. */
function dedupeIds(ids: string[]) {
    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const id of ids) {
        if (seen.has(id)) {
            continue;
        }

        seen.add(id);
        ordered.push(id);
    }

    return ordered;
}

/**
 * Shows saved devices first, then inventory devices that have no saved slot.
 * Unavailable ids stay out of the render list without being forgotten by a later move.
 */
export function resolveDeviceOrder(savedIds: string[], inventoryIds: string[]) {
    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const id of dedupeIds(savedIds)) {
        seen.add(id);

        if (inventoryIds.includes(id)) {
            ordered.push(id);
        }
    }

    for (const id of inventoryIds) {
        if (seen.has(id)) {
            continue;
        }

        seen.add(id);
        ordered.push(id);
    }

    return ordered;
}

/**
 * Records a visible device move without normalizing a cancelled gesture.
 * Unavailable ids stay in their saved slots so a returning device keeps its place.
 */
export function commitDeviceOrder(
    savedIds: string[],
    inventoryIds: string[],
    move: ItemMove,
) {
    if (
        !inventoryIds.includes(move.activeId) ||
        !inventoryIds.includes(move.overId)
    ) {
        return savedIds;
    }

    const complete = dedupeIds(savedIds);

    for (const id of inventoryIds) {
        if (!complete.includes(id)) {
            complete.push(id);
        }
    }

    const inventory = new Set(inventoryIds);

    const next = moveKeyedSubsequence(
        complete,
        {
            keyOf: (id) => id,
            inScope: (id) => inventory.has(id),
        },
        move,
    );

    if (next === complete) {
        return savedIds;
    }

    return next;
}

/** Bookmarking is a toggle so the same menu item can add or remove. */
export function toggleBookmark(bookmarks: Bookmark[], bookmark: Bookmark) {
    if (isPathBookmarked(bookmarks, bookmark)) {
        const targetKey = getBookmarkKey(bookmark);

        return bookmarks.filter((entry) => getBookmarkKey(entry) !== targetKey);
    }

    return [...bookmarks, bookmark];
}

type UserStateUpdater = (prev: UserState) => UserState;

/**
 * What a settings write needs: the API to send it, the query cache it reads the latest value
 * from, and the jotai store to report a failure in. Writes also run outside React, so they
 * cannot reach these through hooks.
 */
type UserStateWriter = {
    api: ApiClient;
    queryClient: QueryClient;
    store: ReturnType<typeof createStore>;
};

let persistPending = 0;

let persistChain: Promise<void> = Promise.resolve();

/**
 * The last failed settings write, so the shell can show a non-blocking toast. Writes run
 * outside React, which is why the writers are handed the application's jotai store.
 */
export const userStatePersistErrorAtom = atom<string | null>(null);

/** Lets window-focus refetch wait until an in-flight write has reached disk. */
export function isUserStatePersistPending() {
    return persistPending > 0;
}

/**
 * Resolves once every queued settings write has finished, including writes queued while
 * waiting, so a fresh read afterwards cannot replace a change that has not been saved yet.
 */
export async function waitForUserStatePersist() {
    while (persistPending > 0) {
        await persistChain;
    }
}

function persistErrorMessage(cause: unknown) {
    return getErrorMessage(cause, "Could not save settings");
}

/** Serializes writes so rapid updates converge on the last visible cache value. */
function persistLatestUserState(writer: UserStateWriter) {
    persistPending += 1;

    const run = persistChain.then(async () => {
        const state =
            writer.queryClient.getQueryData<UserState>(queryKeys.userState()) ??
            defaultUserState;

        try {
            await writer.api.updateUserState({ state });
            writer.store.set(userStatePersistErrorAtom, null);
        } catch (cause) {
            writer.store.set(
                userStatePersistErrorAtom,
                persistErrorMessage(cause),
            );
        }
    });

    persistChain = run.catch(() => undefined);
    void run.finally(() => {
        persistPending -= 1;
    });
}

/** Shares validated preferences between the root loader and interactive updates. */
export function userStateQueryOptions(api: ApiClient) {
    return queryOptions({
        queryKey: queryKeys.userState(),
        queryFn: async () => {
            const response = await api.getUserState();
            const parsed = userStateSchema.safeParse(response.state);

            if (!parsed.success) {
                return defaultUserState;
            }

            return parsed.data;
        },
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: () =>
            isUserStatePersistPending() ? false : "always",
    });
}

function nextUserState(
    current: UserState,
    update: UserState | UserStateUpdater,
) {
    if (update instanceof Function) {
        return update(current);
    }

    return update;
}

/**
 * Paints a change at once and writes it in the background. Code outside React, such as the
 * editor workspace recording caret lines, updates the settings through this too, so its
 * writes are serialized with the ones made from components.
 */
export function updateUserState(
    writer: UserStateWriter,
    update: UserState | UserStateUpdater,
) {
    const current =
        writer.queryClient.getQueryData<UserState>(queryKeys.userState()) ??
        defaultUserState;

    const next = nextUserState(current, update);

    if (next === current) {
        return;
    }

    writer.queryClient.setQueryData(queryKeys.userState(), next);
    persistLatestUserState(writer);
}

/**
 * Mirrors useState so toggles paint immediately while the server write stays in the background.
 */
export function useUserState(): [
    UserState,
    (update: UserState | UserStateUpdater) => void,
] {
    const { api } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const store = useStore();
    const { data } = useQuery(userStateQueryOptions(api));
    const userState = data ?? defaultUserState;

    const setUserState = React.useCallback(
        (update: UserState | UserStateUpdater) =>
            updateUserState({ api, queryClient, store }, update),
        [api, queryClient, store],
    );

    return [userState, setUserState];
}

/**
 * Finds, for open files that share a name, the fewest parent directories that tell them
 * apart, so the open files list does not show several identical `SKILL.md` rows. Files with
 * a unique name get no entry. The same path on two devices cannot be told apart by its
 * directories, so those copies are left to the device name the row already shows.
 */
export function getOpenFileParentLabels(
    openFiles: readonly OpenFile[],
): Map<string, string> {
    const labels = new Map<string, string>();
    const pathsByName = new Map<string, Set<string>>();

    for (const file of openFiles) {
        const paths = pathsByName.get(file.name) ?? new Set<string>();
        paths.add(file.path);
        pathsByName.set(file.name, paths);
    }

    for (const file of openFiles) {
        const others = [...(pathsByName.get(file.name) ?? [])].flatMap(
            (path) => (path === file.path ? [] : [getParentSegments(path)]),
        );

        if (others.length === 0) {
            continue;
        }

        const parents = getParentSegments(file.path);

        // Grows the shown suffix of parents until no other path ends with the same one.
        for (let count = 1; count <= parents.length; count += 1) {
            const suffix = parents.slice(-count);

            const isShared = others.some(
                (other) =>
                    other.length >= count &&
                    other
                        .slice(-count)
                        .every((segment, index) => segment === suffix[index]),
            );

            if (!isShared || count === parents.length) {
                labels.set(getOpenFileKey(file), suffix.join("/"));
                break;
            }
        }
    }

    return labels;
}

/** Splits a path into its directory names, without the file name or empty segments. */
function getParentSegments(path: string): string[] {
    return path
        .split("/")
        .filter((segment) => segment !== "")
        .slice(0, -1);
}
