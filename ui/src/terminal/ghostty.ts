type GhosttyModule = typeof import("ghostty-web");

let initialization: Promise<GhosttyModule> | null = null;

/** Lazily loads and initializes Ghostty only after the terminal is expanded. */
export function initializeGhostty(): Promise<GhosttyModule> {
    initialization ??= import("ghostty-web").then(async (ghostty) => {
        await ghostty.init();
        return ghostty;
    });
    return initialization;
}
