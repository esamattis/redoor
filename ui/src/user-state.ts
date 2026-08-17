import * as React from "react";
import { getRouteApi } from "@tanstack/react-router";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { ApiClient } from "#ui/api-client";
import { queryKeys } from "#ui/queries";

const rootRouteApi = getRouteApi("__root__");

/** One remembered path so the agent list can restore a specific file or directory. */
export const bookmarkSchema = z.object({
    agentId: z.string(),
    path: z.string(),
    name: z.string(),
    entryType: z.enum(["file", "directory"]),
});

export type Bookmark = z.infer<typeof bookmarkSchema>;

/** Known UI preferences; extra server keys are ignored until they have a schema. */
export const userStateSchema = z.object({
    showHiddenFiles: z.boolean().catch(true),
    theme: z.enum(["system", "dark", "light"]).catch("system"),
    bookmarks: z.array(bookmarkSchema).catch([]),
    vimMode: z.boolean().catch(false),
});

export type UserState = z.infer<typeof userStateSchema>;

export const defaultUserState: UserState = {
    showHiddenFiles: true,
    theme: "system",
    bookmarks: [],
    vimMode: false,
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
            queryClient.setQueryData(
                queryKeys.userState(),
                nextUserState(current, update),
            );
            persistLatestUserState(api, queryClient);
        },
        [api, queryClient],
    );

    return [userState, setUserState];
}
