import React from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { queryKeys } from "#ui/queries";

type BrowserRouter = {
    invalidate: () => Promise<void>;
};

type EditorRefreshState = {
    agentId: string;
    path: string;
    isDirty: boolean;
};

let editorRefreshState: EditorRefreshState | null = null;

/**
 * Lets the mounted editor opt into shared browser reload triggers without a second listener.
 * Dirty buffers stay out of the refetch so unsaved text cannot be overwritten.
 */
export function useEditorRefreshRegistration(state: EditorRefreshState) {
    editorRefreshState = state;
    React.useEffect(() => {
        return () => {
            if (
                editorRefreshState?.agentId === state.agentId &&
                editorRefreshState.path === state.path
            ) {
                editorRefreshState = null;
            }
        };
    }, [state.agentId, state.path]);
}

/**
 * Reloads ls/metadata, and the editor buffer only when the editor is still clean.
 * Automatic triggers and the More menu share this so dirty edits are never overwritten.
 */
export async function refreshBrowserPath(options: {
    router: BrowserRouter;
    queryClient: QueryClient;
    fileContent?: { agentId: string; path: string };
    isEditorDirty?: boolean;
}) {
    const fileContent =
        options.fileContent ??
        (editorRefreshState === null
            ? undefined
            : {
                  agentId: editorRefreshState.agentId,
                  path: editorRefreshState.path,
              });
    const isEditorDirty =
        options.isEditorDirty ?? editorRefreshState?.isDirty === true;

    // Pull editor bytes before invalidate so a remount cannot drop an inactive refetch.
    if (fileContent && !isEditorDirty) {
        await options.queryClient.refetchQueries({
            queryKey: queryKeys.fileContent(
                fileContent.agentId,
                fileContent.path,
            ),
            type: "all",
        });
    }
    // Git state can change outside redoor without changing the directory listing.
    await options.queryClient.invalidateQueries({
        queryKey: queryKeys.git(),
    });
    await options.router.invalidate();
}

/** Serializes browser reload triggers so one focus transition cannot duplicate requests. */
export function useRefreshBrowserPath() {
    const router = useRouter();
    const queryClient = useQueryClient();
    const refreshPromiseRef = React.useRef<Promise<void> | null>(null);

    return React.useCallback(() => {
        if (refreshPromiseRef.current) {
            return refreshPromiseRef.current;
        }
        const refreshPromise = refreshBrowserPath({
            router,
            queryClient,
        }).finally(() => {
            if (refreshPromiseRef.current === refreshPromise) {
                refreshPromiseRef.current = null;
            }
        });
        refreshPromiseRef.current = refreshPromise;
        return refreshPromise;
    }, [queryClient, router]);
}

/** Reloads the browser after returning to the window or leaving a terminal. */
export function useBrowserRefreshTriggers() {
    const refreshBrowser = useRefreshBrowserPath();

    React.useEffect(() => {
        const refresh = () => {
            if (document.visibilityState === "hidden") {
                return;
            }
            void refreshBrowser();
        };
        /** Ignores focus movement inside Ghostty while catching exits to editor or shell controls. */
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
