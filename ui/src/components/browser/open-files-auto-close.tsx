import * as React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useStore, type createStore } from "jotai";

import type { ApiClient } from "#ui/api-client";
import { isOpenFileShown } from "#ui/components/browser/open-file-actions";
import type { EditorWorkspace } from "#ui/editor/editor-workspace";
import { editorBufferQueryOptions } from "#ui/editor/stored-buffer";
import { queryKeys } from "#ui/queries";
import { useBrowserLocation } from "#ui/use-browser-location";
import {
    defaultUserState,
    getOpenFileKey,
    getStaleOpenFiles,
    stampUntouchedOpenFiles,
    touchOpenFiles,
    updateUserState,
    userStateQueryOptions,
    useUserState,
    waitForUserStatePersist,
    type OpenFile,
    type UserState,
} from "#ui/user-state";

const rootRouteApi = getRouteApi("__root__");

/**
 * How often stale open files are looked for. Staleness is measured in hours, so a few
 * minutes late is unnoticeable, and a sweep without stale files sends no request.
 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** What a sweep reads and writes; it runs from timers, outside React's render. */
type SweepContext = {
    api: ApiClient;
    queryClient: QueryClient;
    store: ReturnType<typeof createStore>;
    editor: EditorWorkspace;
};

/**
 * Tells whether an open file has unsaved changes. The stored copy is read even when this tab
 * holds a clean buffer, since another browser may have stored edits this tab has not picked
 * up. A failed read counts as dirty, because an automatic close must never be the one that
 * discards edits.
 */
async function hasUnsavedChanges(context: SweepContext, file: OpenFile) {
    const key = getOpenFileKey(file);

    if (context.editor.isDirty(key) === true) {
        return true;
    }

    try {
        const stored = await context.queryClient.fetchQuery(
            editorBufferQueryOptions(context.api, key),
        );

        return stored?.data.dirty === true;
    } catch {
        return true;
    }
}

/**
 * Closes the open files the user has not touched within their auto-close delay. Files with
 * unsaved changes and the file on screen stay, since closing them would lose work or pull
 * the page out from under the user. Staleness and dirtiness are checked again when the list
 * is written, so a file touched or edited while its stored buffer was read is kept.
 */
async function sweepStaleOpenFiles(
    context: SweepContext,
    shownKey: string | null,
) {
    // The cached list may be hours old in a tab left open, and a write replaces the whole
    // list, so it is read fresh first, after this tab's own writes so the read cannot
    // replace a change that is still being saved.
    await waitForUserStatePersist();
    await context.queryClient.fetchQuery({
        ...userStateQueryOptions(context.api),
        staleTime: 0,
    });

    const current = () =>
        context.queryClient.getQueryData<UserState>(queryKeys.userState()) ??
        defaultUserState;

    updateUserState(context, (state) => {
        const openFiles = stampUntouchedOpenFiles(state.openFiles);

        return openFiles === state.openFiles ? state : { ...state, openFiles };
    });

    const candidates = getStaleOpenFiles(current()).filter(
        (file) => getOpenFileKey(file) !== shownKey,
    );

    if (candidates.length === 0) {
        return;
    }

    const dirty = await Promise.all(
        candidates.map((file) => hasUnsavedChanges(context, file)),
    );

    const clean = new Set(
        candidates
            .filter((_, index) => dirty[index] === false)
            .map((file) => getOpenFileKey(file)),
    );

    const closed: string[] = [];

    updateUserState(context, (state) => {
        const stillStale = new Set(
            getStaleOpenFiles(state).map((file) => getOpenFileKey(file)),
        );

        const openFiles = state.openFiles.filter((file) => {
            const key = getOpenFileKey(file);

            const close =
                clean.has(key) &&
                stillStale.has(key) &&
                context.editor.isDirty(key) !== true;

            if (close) {
                closed.push(key);
            }

            return !close;
        });

        return closed.length === 0 ? state : { ...state, openFiles };
    });

    // The server deletes the closed files' buffers when it stores the new list.
    for (const key of closed) {
        context.editor.close(key);
        context.queryClient.removeQueries({
            queryKey: queryKeys.editorBuffer(key),
        });
    }
}

/**
 * Keeps open files from piling up: records when each is shown and left, and periodically
 * closes the ones untouched for longer than the user's auto-close delay. Mounted once in
 * the shell, so it runs on every page and only once per tab.
 */
export function useOpenFilesAutoClose() {
    const { api, editor } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const store = useStore();
    const [userState] = useUserState();
    const browser = useBrowserLocation();

    const shownFile = userState.openFiles.find((file) =>
        isOpenFileShown(browser, file),
    );

    const shownKey = shownFile === undefined ? null : getOpenFileKey(shownFile);

    // Read by the timer, which must not restart whenever the user moves between files.
    const shownKeyRef = React.useRef(shownKey);
    shownKeyRef.current = shownKey;

    // Showing a file and leaving it both count as touching it, so a file read for hours
    // without edits gets its full delay from the moment the user moves on.
    React.useEffect(() => {
        if (shownKey === null) {
            return;
        }

        const touch = () =>
            updateUserState({ api, queryClient, store }, (state) => {
                const openFiles = touchOpenFiles(
                    state.openFiles,
                    new Set([shownKey]),
                );

                return openFiles === state.openFiles
                    ? state
                    : { ...state, openFiles };
            });

        touch();

        return touch;
    }, [api, queryClient, store, shownKey]);

    const isEnabled = userState.autoCloseOpenFiles;
    const afterHours = userState.autoCloseOpenFilesAfterHours;

    // Sweeps at once, so a shortened delay or a returning user sees the effect without
    // waiting for the timer, and then on an interval for a tab left open.
    React.useEffect(() => {
        if (!isEnabled) {
            return;
        }

        const context = { api, queryClient, store, editor };
        let isRunning = false;

        const sweep = () => {
            if (isRunning) {
                return;
            }

            isRunning = true;

            // A failed read only skips this round; the next one tries again.
            void sweepStaleOpenFiles(context, shownKeyRef.current)
                .catch(() => undefined)
                .finally(() => {
                    isRunning = false;
                });
        };

        sweep();
        const timer = window.setInterval(sweep, SWEEP_INTERVAL_MS);

        return () => window.clearInterval(timer);
    }, [api, queryClient, store, editor, isEnabled, afterHours]);
}
