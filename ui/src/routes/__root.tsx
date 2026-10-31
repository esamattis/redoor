import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";

import type { ApiClient } from "#ui/api-client";
import type { TerminalSessions } from "#ui/terminal/terminal-sessions";
import type { UploadQueue } from "#ui/upload-queue";
import type { EditorWorkspace } from "#ui/editor/editor-workspace";
import type { VaultSession } from "#ui/vault/vault-session";

interface AppRouterContext {
    api: ApiClient;
    queryClient: QueryClient;
    /** Owns every terminal shell, so tabs outlive routes and components. */
    terminals: TerminalSessions;
    /** Owns the upload queue, so uploads continue while the user navigates. */
    uploads: UploadQueue;
    /** Owns the single editor view and open files' buffers, so they outlive the editor route. */
    editor: EditorWorkspace;
    /** Holds the unlocked vault keys of this tab, shared with the other tabs. */
    vault: VaultSession;
}

/**
 * Provides the router context and developer tools to every page. The authenticated shell
 * lives in the `_app` layout route, so public pages such as the login form are not wrapped
 * by it.
 */
export const Route = createRootRouteWithContext<AppRouterContext>()({
    component: RootRoute,
});

/** Renders the matched page next to the devtools, which are useful on every page. */
function RootRoute() {
    return (
        <>
            <Outlet />
            <TanStackDevtools
                config={{
                    position: "bottom-right",
                }}
                plugins={[
                    {
                        name: "Tanstack Router",
                        render: <TanStackRouterDevtoolsPanel />,
                    },
                ]}
            />
        </>
    );
}
