import * as React from "react";
import { getRouteApi } from "@tanstack/react-router";
import {
    queryOptions,
    useQuery,
    useQueryClient,
    type QueryClient,
} from "@tanstack/react-query";
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
});

export type OpenFile = z.infer<typeof openFileSchema>;

/** Known UI preferences; extra server keys are ignored until they have a schema. */
export const userStateSchema = z.object({
    showHiddenFiles: z.boolean().catch(true),
    theme: z.enum(["system", "dark", "light"]).catch("system"),
    bookmarks: z.array(bookmarkSchema).catch([]),
    openFiles: z.array(openFileSchema).catch([]),
    vimMode: z.boolean().catch(false),
    wrapEditorLines: z.boolean().catch(false),
    recursiveSearchTimeoutSeconds: z.number().int().min(1).max(60).catch(5),
    recursiveSearchIncludeHidden: z.boolean().catch(false),
    recursiveSearchRespectGitignore: z.boolean().catch(true),
    deviceOrder: z.array(z.string()).catch([]),
    showOnlyConnectedDevices: z.boolean().catch(false),
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
export function openFile(openFiles: OpenFile[], file: OpenFile) {
    if (isFileOpen(openFiles, file)) {
        return openFiles;
    }

    return [...openFiles, file];
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
    if (reveal === undefined) {
        return openFile(openFiles, file);
    }

    if (!isFileOpen(openFiles, file)) {
        return [...openFiles, { ...file, reveal, line: reveal.line }];
    }

    const targetKey = getOpenFileKey(file);

    return openFiles.map((entry) =>
        getOpenFileKey(entry) === targetKey
            ? { ...entry, reveal, line: reveal.line }
            : entry,
    );
}

/**
 * Records where an open file's caret is, as its buffer is written. An unchanged line keeps
 * the same list, so moving within a line or retyping it sends no settings write. While a
 * line request the buffer has not applied is pending, the caret has not gone there yet, so
 * the requested line stays listed.
 */
export function setOpenFileLine(openFiles: OpenFile[], caret: CaretReport) {
    const target = openFiles.find((file) => getOpenFileKey(file) === caret.key);

    if (
        target === undefined ||
        target.line === caret.line ||
        (target.reveal !== undefined &&
            target.reveal.id !== caret.appliedReveal)
    ) {
        return openFiles;
    }

    return openFiles.map((file) =>
        file === target ? { ...file, line: caret.line } : file,
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

/** Shares open file order between the sidebar and the full-window editor strip. */
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

let persistPending = 0;

let persistChain: Promise<void> = Promise.resolve();

let persistError: string | null = null;

const persistErrorListeners = new Set<() => void>();

/** Lets window-focus refetch wait until an in-flight write has reached disk. */
export function isUserStatePersistPending() {
    return persistPending > 0;
}

function subscribePersistError(onStoreChange: () => void) {
    persistErrorListeners.add(onStoreChange);

    return () => {
        persistErrorListeners.delete(onStoreChange);
    };
}

function getPersistError() {
    return persistError;
}

function setPersistError(message: string | null) {
    persistError = message;

    for (const listener of persistErrorListeners) {
        listener();
    }
}

/** Surfaces the last failed write so the shell can show a non-blocking toast. */
export function useUserStatePersistError(): [string | null, () => void] {
    const message = React.useSyncExternalStore(
        subscribePersistError,
        getPersistError,
    );

    return [message, () => setPersistError(null)];
}

function persistErrorMessage(cause: unknown) {
    return getErrorMessage(cause, "Could not save settings");
}

/** Serializes writes so rapid updates converge on the last visible cache value. */
function persistLatestUserState(api: ApiClient, queryClient: QueryClient) {
    persistPending += 1;

    const run = persistChain.then(async () => {
        const state =
            queryClient.getQueryData<UserState>(queryKeys.userState()) ??
            defaultUserState;

        try {
            await api.updateUserState({ state });
            setPersistError(null);
        } catch (cause) {
            setPersistError(persistErrorMessage(cause));
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
    api: ApiClient,
    queryClient: QueryClient,
    update: UserState | UserStateUpdater,
) {
    const current =
        queryClient.getQueryData<UserState>(queryKeys.userState()) ??
        defaultUserState;

    const next = nextUserState(current, update);

    if (next === current) {
        return;
    }

    queryClient.setQueryData(queryKeys.userState(), next);
    persistLatestUserState(api, queryClient);
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
    const { data } = useQuery(userStateQueryOptions(api));
    const userState = data ?? defaultUserState;

    const setUserState = React.useCallback(
        (update: UserState | UserStateUpdater) =>
            updateUserState(api, queryClient, update),
        [api, queryClient],
    );

    return [userState, setUserState];
}
