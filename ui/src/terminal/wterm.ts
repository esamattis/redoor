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
export type CreateWTermOptions = {
    host: HTMLDivElement;
    onData: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    onClipboardWrite: (text: string) => void;
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

/** Lets macOS layouts commit Option text instead of wterm encoding it as Escape-prefixed input. */
function preserveOptionText(event: KeyboardEvent, terminal: WTerm): void {
    if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === "Dead" || Array.from(event.key).length === 1)
    ) {
        // Keep the native default action so input/composition events deliver the resolved text.
        // Capture on the textarea itself because wterm's listener is on the same element.
        event.stopImmediatePropagation();

        if (event.type === "keydown") {
            // wterm only moves its textarea to the cursor on focus, so after output scrolls it
            // sits far up in scrollback and the native insertion scrolls the viewport there.
            // Focusing again repositions it at the prompt before the browser inserts the text.
            terminal.focus();
        }
    }
}

/** Creates one initialized DOM renderer and its dedicated Ghostty-backed core. */
/** The part of wterm a tab uses, so a test can stand in for it without the wasm core. */
export type TerminalEmulator = Pick<
    WTerm,
    | "cols"
    | "rows"
    | "bridge"
    | "write"
    | "focus"
    | "destroy"
    | "getSelectionText"
>;

/** The part of the Ghostty core a tab uses. */
export type EmulatorCore = Pick<GhosttyCore, "dispose">;

/**
 * How a tab gets its emulator. Injected, so tests of tab bookkeeping can run without the
 * wasm core and a real layout.
 */
export type CreateEmulator = (
    options: CreateWTermOptions,
) => Promise<{ terminal: TerminalEmulator; core: EmulatorCore }>;

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
        onClipboardWrite: options.onClipboardWrite,
    });

    try {
        await terminal.init();

        if (navigator.platform.startsWith("Mac")) {
            const input = options.host.querySelector("textarea");

            const handleOptionKey = (event: KeyboardEvent) =>
                preserveOptionText(event, terminal);

            // These listeners live on wterm's textarea and are released with it on teardown.
            input?.addEventListener("keydown", handleOptionKey, true);
            input?.addEventListener("keyup", handleOptionKey, true);
        }

        return { terminal, core };
    } catch (error) {
        terminal.destroy();
        core.dispose();
        throw error;
    }
}
