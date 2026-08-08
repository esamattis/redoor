import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "jotai";
import { RouterProvider, createRouter } from "@tanstack/react-router";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

import "./styles.css";
import { ApiClient } from "@/api-client";

// The API lives on the same origin as the page: the redoor binary
// embeds the UI alongside the API on a single port, and during local
// `vite dev` the Vite proxy in `vite.config.ts` forwards `/api` and
// `/ws` to the redoor server. Either way, using the page's origin
// keeps the client configuration trivial.
export const api = new ApiClient(window.location.origin);

// Create a new router instance
const router = createRouter({
    routeTree,
    context: {
        api,
    },
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultStructuralSharing: true,
    defaultPreloadStaleTime: 0,
});

api.setUnauthorizedHandler(() => {
    if (window.location.pathname === "/login") {
        return;
    }
    const returnPath = `${window.location.pathname}${window.location.search}`;
    const search = new URLSearchParams({ redirect: returnPath });
    window.location.replace(`/login?${search.toString()}`);
});

// Register the router instance for type safety
declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}

// Render the app
const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <StrictMode>
            <Provider>
                <RouterProvider router={router} />
            </Provider>
        </StrictMode>,
    );
}
