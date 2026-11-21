import React from "react";
import { atom, useSetAtom, useStore } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { RegisteredRouter } from "@tanstack/react-router";
import { queryKeys } from "#ui/queries";
import { invalidateDeviceViews } from "#ui/use-active-agent";

/** Names the file shown in the editor. */
type EditorRefreshState = {
    agentId: string;
    path: string;
};

/**
 * Holds the editor that is open, so refresh triggers fired from anywhere (window focus,
 * leaving the terminal, the More menu) know which file's device text to refetch.
 * It is an atom rather than a module variable, so it belongs to the store the application
 * renders with and every test gets a fresh one.
 */
const editorRefreshStateAtom = atom<EditorRefreshState | null>(null);

/**
 * Lets the mounted editor opt into shared browser reload triggers without a second listener.
 * Its device text is refetched even with unsaved edits: the editor never lets device text
 * replace them, and needs the fresh text to warn that the device changed.
 */
export function useEditorRefreshRegistration(state: EditorRefreshState) {
    const setEditorState = useSetAtom(editorRefreshStateAtom);

    React.useEffect(() => {
        setEditorState({
            agentId: state.agentId,
            path: state.path,
        });

        return () =>
            // Only clear our own registration, in case another editor has already replaced it.
            setEditorState((current) =>
                current?.agentId === state.agentId &&
                current.path === state.path
                    ? null
                    : current,
            );
    }, [setEditorState, state.agentId, state.path]);
}

/**
 * Reloads the route, whose loader refetches the listing and metadata, plus the agent's git
 * state and the editor's device text. Automatic triggers and the More menu share this. The
 * editor decides what device text may do to its buffer, so unsaved edits are never replaced. The route is reloaded
 * because the query cache cannot tell whether the entry at this URL changed kind, such as a
 * missing path that now exists.
 */
async function refreshBrowserPath(options: {
    router: RegisteredRouter;
    queryClient: QueryClient;
    agentId: string;
    editor: EditorRefreshState | null;
}) {
    const fileContent =
        options.editor === null
            ? undefined
            : { agentId: options.editor.agentId, path: options.editor.path };

    // Pull editor bytes before invalidate so a remount cannot drop an inactive refetch.
    if (fileContent) {
        await options.queryClient.refetchQueries(
            {
                queryKey: queryKeys.fileContent(
                    fileContent.agentId,
                    fileContent.path,
                ),
                type: "all",
            },
            {
                // CodeMirror focus can request the same bytes during tab restoration.
                cancelRefetch: false,
            },
        );
    }

    // Git state can change outside redoor without changing the directory listing, and only
    // the loader's own queries are refetched by the route reload below.
    await options.queryClient.invalidateQueries(
        {
            queryKey: queryKeys.git(options.agentId),
        },
        {
            // Creating a file navigates while this refresh may already be in flight.
            cancelRefetch: false,
        },
    );
    await invalidateDeviceViews(options.router);
}

/** Serializes browser reload triggers so one focus transition cannot duplicate requests. */
export function useRefreshBrowserPath(agentId: string) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const store = useStore();
    const refreshPromiseRef = React.useRef<Promise<void> | null>(null);

    return React.useCallback(() => {
        if (refreshPromiseRef.current) {
            return refreshPromiseRef.current;
        }

        const refreshPromise = refreshBrowserPath({
            router,
            queryClient,
            agentId,
            editor: store.get(editorRefreshStateAtom),
        }).finally(() => {
            if (refreshPromiseRef.current === refreshPromise) {
                refreshPromiseRef.current = null;
            }
        });

        refreshPromiseRef.current = refreshPromise;

        return refreshPromise;
    }, [agentId, queryClient, router, store]);
}

/** Reloads the browser after returning to the window or leaving a terminal. */
export function useBrowserRefreshTriggers(agentId: string) {
    const refreshBrowser = useRefreshBrowserPath(agentId);

    React.useEffect(() => {
        const refresh = () => {
            if (document.visibilityState === "hidden") {
                return;
            }

            void refreshBrowser();
        };

        /** Ignores focus movement inside the terminal while catching exits to adjacent controls. */
        const refreshAfterTerminalBlur = (event: FocusEvent) => {
            const target = event.target;

            if (!(target instanceof Element)) {
                return;
            }

            const terminal = target.closest("[data-terminal-input]");

            if (!terminal) {
                return;
            }

            const nextTarget = event.relatedTarget;

            if (nextTarget instanceof Node && terminal.contains(nextTarget)) {
                return;
            }

            refresh();
        };

        window.addEventListener("focus", refresh);
        window.addEventListener("visibilitychange", refresh);
        document.addEventListener("focusout", refreshAfterTerminalBlur);

        return () => {
            window.removeEventListener("focus", refresh);
            window.removeEventListener("visibilitychange", refresh);
            document.removeEventListener("focusout", refreshAfterTerminalBlur);
        };
    }, [refreshBrowser]);
}
