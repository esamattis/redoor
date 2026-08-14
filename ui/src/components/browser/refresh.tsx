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
 * Lets the mounted editor opt into the shared tab-focus reload without a second listener.
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
 * Reloads ls/metadata, and the editor buffer only when the textarea is still clean.
 * Window focus and the More menu share this so dirty edits are never overwritten.
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
    await options.router.invalidate();
}

/** Reloads the current browser listing when the tab becomes visible again. */
export function useRefreshBrowserOnWindowFocus() {
    const router = useRouter();
    const queryClient = useQueryClient();

    React.useEffect(() => {
        let refreshing = false;
        const refresh = () => {
            if (document.visibilityState === "hidden" || refreshing) {
                return;
            }
            refreshing = true;
            void refreshBrowserPath({
                router,
                queryClient,
            }).finally(() => {
                refreshing = false;
            });
        };
        window.addEventListener("focus", refresh);
        window.addEventListener("visibilitychange", refresh);
        return () => {
            window.removeEventListener("focus", refresh);
            window.removeEventListener("visibilitychange", refresh);
        };
    }, [queryClient, router]);
}
