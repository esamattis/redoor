import * as React from "react";
import { getRouteApi } from "@tanstack/react-router";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { ApiClient } from "#ui/api-client";
import { queryKeys } from "#ui/queries";
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

/** One editor file kept in the left menu so it can be reopened without browsing. */
export const pinnedFileSchema = z.object({
    agentId: z.string(),
    path: z.string(),
    name: z.string(),
    agentName: z.string(),
});

export type PinnedFile = z.infer<typeof pinnedFileSchema>;

/** Known UI preferences; extra server keys are ignored until they have a schema. */
export const userStateSchema = z.object({
    showHiddenFiles: z.boolean().catch(true),
    theme: z.enum(["system", "dark", "light"]).catch("system"),
    bookmarks: z.array(bookmarkSchema).catch([]),
    pinnedFiles: z.array(pinnedFileSchema).catch([]),
    vimMode: z.boolean().catch(false),
    wrapEditorLines: z.boolean().catch(false),
    recursiveSearchTimeoutSeconds: z.number().int().min(1).max(60).catch(5),
    recursiveSearchIncludeHidden: z.boolean().catch(false),
    recursiveSearchRespectGitignore: z.boolean().catch(true),
    deviceOrder: z.array(z.string()).catch([]),
});

export type UserState = z.infer<typeof userStateSchema>;

export const defaultUserState: UserState = {
    showHiddenFiles: true,
    theme: "system",
    bookmarks: [],
    pinnedFiles: [],
    vimMode: false,
    wrapEditorLines: false,
    recursiveSearchTimeoutSeconds: 5,
    recursiveSearchIncludeHidden: false,
    recursiveSearchRespectGitignore: true,
    deviceOrder: [],
};

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

/** Identifies one pinned file so the same path cannot be stored twice. */
export function getPinnedFileKey(file: Pick<PinnedFile, "agentId" | "path">) {
    return `${file.agentId}:${file.path}`;
}

/** Lets the editor button and the left menu share one membership check. */
export function isFilePinned(
    pinnedFiles: PinnedFile[],
    target: Pick<PinnedFile, "agentId" | "path">,
) {
    const targetKey = getPinnedFileKey(target);
    return pinnedFiles.some((file) => getPinnedFileKey(file) === targetKey);
}

/**
 * Appends a new pin so later pins stay below earlier ones.
 * Re-pinning an existing path keeps its place instead of jumping to the bottom.
 */
export function pinFile(pinnedFiles: PinnedFile[], file: PinnedFile) {
    if (isFilePinned(pinnedFiles, file)) {
        return pinnedFiles;
    }
    return [...pinnedFiles, file];
}

/** Drops one pin without reordering the files that remain. */
export function unpinFile(
    pinnedFiles: PinnedFile[],
    target: Pick<PinnedFile, "agentId" | "path">,
) {
    const targetKey = getPinnedFileKey(target);
    return pinnedFiles.filter((file) => getPinnedFileKey(file) !== targetKey);
}

/** Shares pin order between the sidebar and the full-window editor strip. */
export function reorderPinnedFiles(pinnedFiles: PinnedFile[], move: ItemMove) {
    return moveKeyedItems(pinnedFiles, getPinnedFileKey, move);
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
    if (cause instanceof Error && cause.message.length > 0) {
        return cause.message;
    }
    return "Could not save settings";
}

/** Serializes writes so rapid updates converge on the last visible cache value. */
function persistLatestUserState(
    api: ApiClient,
    queryClient: ReturnType<typeof useQueryClient>,
) {
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
        (update: UserState | UserStateUpdater) => {
            const current =
                queryClient.getQueryData<UserState>(queryKeys.userState()) ??
                defaultUserState;
            const next = nextUserState(current, update);
            if (next === current) {
                return;
            }
            queryClient.setQueryData(queryKeys.userState(), next);
            persistLatestUserState(api, queryClient);
        },
        [api, queryClient],
    );

    return [userState, setUserState];
}
