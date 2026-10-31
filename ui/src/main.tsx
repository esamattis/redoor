import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { Provider, createStore } from "jotai";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

import "./styles.css";
import { ApiClient } from "#ui/api-client";
import { RouteError } from "#ui/components/route-error";
import { ShortcutRegistry, ShortcutRegistryContext } from "#ui/shortcuts";
import { TerminalSessions } from "#ui/terminal/terminal-sessions";
import { findCachedAgent, invalidateAllAgentData } from "#ui/queries";
import { UploadQueue } from "#ui/upload-queue";
import { EditorWorkspace } from "#ui/editor/editor-workspace";
import { VaultSession } from "#ui/vault/vault-session";
import { setOpenFileLine, updateUserState } from "#ui/user-state";

// The API lives on the same origin as the page: the redoor binary
// embeds the UI alongside the API on a single port, and during local
// `vite dev` the Vite proxy in `vite.config.ts` forwards `/api` and
// `/ws` to the redoor server. Either way, using the page's origin
// keeps the client configuration trivial.
export const api = new ApiClient(window.location.origin);

export const queryClient = new QueryClient();

// The store is created here, rather than by the Provider, so the terminal owner can read the
// drawer atoms and reveal the drawer without going through a component.
const store = createStore();

// Terminal tabs are a page-lifetime resource that views the server's terminal sessions: the
// tabs outlive routes and the drawer, and the shells outlive the page, so a reload restores
// them from the server.
const terminals = new TerminalSessions({ queryClient, store, api });

// Uploads outlive the page being browsed, so the queue lives with the application and only
// the views that enqueue into it or show it subscribe.
const uploads = new UploadQueue({
    queryClient,
    resolveAgent: (agentId) => findCachedAgent(queryClient, api, agentId),
    // Declared below; only called once an encrypted upload starts.
    resolveVault: () =>
        vault.requestUnlock("Uploading encrypted files needs the vault key"),
    onSettled: () => {
        void invalidateAllAgentData(queryClient);
    },
    unloadTarget: window,
});

// Open files keep their editor buffers (caret, scroll, undo history, unsaved text) while the
// user moves between pages, and one CodeMirror view serves them all for the page's lifetime.
// The open files list mirrors each caret line, so the menu can show it.
const editor = new EditorWorkspace(api, queryClient, (caret) => {
    updateUserState({ api, queryClient, store }, (current) => {
        const openFiles = setOpenFileLine(current.openFiles, caret);

        return openFiles === current.openFiles
            ? current
            : { ...current, openFiles };
    });
});

editor.start(window);

// The vault's lock state belongs to the page, not a route: an unlock in one place must serve
// the editor, uploads and downloads alike, and kept or shared keys are restored once here.
const vault = new VaultSession();

void vault.start(async () => {
    const status = await api.getVault();

    return status.vault?.current_key_id ?? null;
});

// One registry owns every window-level shortcut, so the order in which commands claim a key
// is decided by explicit priority instead of by whichever component registered first.
const shortcuts = new ShortcutRegistry(window);

// Create a new router instance
const router = createRouter({
    routeTree,
    context: {
        api,
        queryClient,
        terminals,
        uploads,
        editor,
        vault,
    },
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultStructuralSharing: true,
    defaultPreloadStaleTime: 0,
    // Replaces TanStack's bare "Something went wrong!" panel with themed details.
    defaultErrorComponent: RouteError,
});

// Any 401 means the session ended, so reload into the login form with the current URL as the
// return path. The reload also drops cached server state that belongs to the old session.
api.setUnauthorizedHandler(() => {
    // The login form's own requests answer 401 for wrong credentials, which must not loop.
    if (router.matchRoute({ to: "/login" })) {
        return;
    }

    const returnPath = `${window.location.pathname}${window.location.search}`;

    window.location.replace(
        router.buildLocation({
            to: "/login",
            search: { redirect: returnPath },
        }).href,
    );
});

// Register the router instance for type safety
declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}

// Links built from a device record its id, so the device route can tell a deliberate choice
// of a device from navigation inside the page that is open (see `deviceRoute`).
declare module "@tanstack/history" {
    interface HistoryState {
        deviceId?: string;
    }
}

// Render the app
const rootElement = document.getElementById("app");

if (rootElement && !rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <StrictMode>
            <Provider store={store}>
                <ShortcutRegistryContext value={shortcuts}>
                    <QueryClientProvider client={queryClient}>
                        <RouterProvider router={router} />
                    </QueryClientProvider>
                </ShortcutRegistryContext>
            </Provider>
        </StrictMode>,
    );
}
