import type { WTerm } from "@wterm/dom";
import type { GhosttyCore } from "@wterm/ghostty";

type WTermModules = {
    WTerm: typeof import("@wterm/dom").WTerm;
    GhosttyCore: typeof import("@wterm/ghostty").GhosttyCore;
};

/** Keeps code downloads shared while every tab receives an independent emulator core. */
let moduleLoad: Promise<WTermModules> | null = null;

/** Owns the two resources that wterm requires callers to dispose independently. */
export type WTermSession = {
    terminal: WTerm;
    core: GhosttyCore;
};

/** Describes the host and protocol callbacks needed to initialize one browser terminal. */
type CreateWTermOptions = {
    host: HTMLDivElement;
    onData: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
};

/** Loads the renderer modules once without sharing mutable terminal state across tabs. */
function loadWTermModules(): Promise<WTermModules> {
    moduleLoad ??= Promise.all([
        import("@wterm/dom"),
        import("@wterm/ghostty"),
    ]).then(([dom, ghostty]) => ({
        WTerm: dom.WTerm,
        GhosttyCore: ghostty.GhosttyCore,
    }));
    return moduleLoad;
}

/** Creates one initialized DOM renderer and its dedicated Ghostty-backed core. */
export async function createWTerm(
    options: CreateWTermOptions,
): Promise<WTermSession> {
    const modules = await loadWTermModules();
    const core = await modules.GhosttyCore.load({
        imageStorageLimit: 0,
        scrollbackLimit: 5000,
    });
    const terminal = new modules.WTerm(options.host, {
        autoResize: true,
        cols: 80,
        rows: 24,
        cursorBlink: true,
        core,
        onData: options.onData,
        onResize: options.onResize,
    });
    try {
        await terminal.init();
        return { terminal, core };
    } catch (error) {
        terminal.destroy();
        core.dispose();
        throw error;
    }
}
