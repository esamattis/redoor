import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { fileURLToPath, URL } from "node:url";

// https://vitejs.dev/config/
export default defineConfig({
    build: {
        // Ghostty is a user-triggered lazy chunk; its terminal runtime is
        // intentionally larger than Vite's generic application-chunk limit.
        chunkSizeWarningLimit: 700,
    },
    plugins: [
        devtools(),
        tanstackRouter({
            target: "react",
            autoCodeSplitting: false,
        }),
        viteReact(),
        tailwindcss(),
    ],
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    server: {
        port: 4000,
        host: "0.0.0.0",
        allowedHosts: ["devbox.local.esamatti.fi"],
        // During local development the redoor API runs on port 3000 while
        // the Vite dev server runs here on port 4000. Proxy the API and
        // websocket routes so the browser can keep using the same origin
        // as the page (matching the embedded production setup).
        proxy: {
            "/api": {
                target: "http://127.0.0.1:3000",
                // Preserve the browser-facing Host so terminal Origin validation
                // sees the same authority on both sides of the dev proxy.
                changeOrigin: false,
                ws: true,
            },
            "/ws": {
                target: "ws://127.0.0.1:3000",
                ws: true,
            },
        },
    },
});
