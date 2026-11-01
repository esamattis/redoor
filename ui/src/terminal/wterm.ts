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

/**
 * Loads the renderer modules once without sharing mutable terminal state across tabs.
 *
 * A failed load is forgotten so the next terminal tries again, instead of every terminal
 * failing until the page is reloaded by hand.
 */
function loadWTermModules(): Promise<WTermModules> {
    if (moduleLoad) return moduleLoad;

    const load = Promise.all([
        import("@wterm/dom"),
        import("@wterm/ghostty"),
    ]).then(([dom, ghostty]) => ({
        WTerm: dom.WTerm,
        GhosttyCore: ghostty.GhosttyCore,
    }));

    moduleLoad = load;
    // The caller still sees the rejection; this only clears the cache for the next one.
    load.catch(() => {
        if (moduleLoad === load) moduleLoad = null;
    });

    return load;
}

/**
 * Resolves once no ancestor of the host is animating, such as the bottom drawer growing to
 * its height as it opens. The size wterm measures at init is the size the tab attaches to
 * its server session with, so measuring mid-animation would resize the shared shell through
 * sizes nobody looks at: a full-screen app redraws for each of them, the server's screen
 * mirror crops its screen to them, and an app that ends up back at its old size never
 * repaints the cropped rows.
 *
 * Animations run on the document timeline, so this does not depend on timers or frames.
 * A host that is not animating resolves at once.
 */
async function waitForAncestorAnimations(host: HTMLElement): Promise<void> {
    for (;;) {
        const running: Animation[] = [];

        for (
            let element = host.parentElement;
            element !== null;
            element = element.parentElement
        ) {
            for (const animation of element.getAnimations()) {
                // An endless animation would never settle and does not move the layout.
                if (
                    animation.playState === "running" &&
                    animation.effect?.getComputedTiming().endTime !== Infinity
                ) {
                    running.push(animation);
                }
            }
        }

        if (running.length === 0) {
            return;
        }

        // A cancelled animation rejects; it stopped moving either way. Another may start
        // meanwhile, such as the drawer turning around, so the ancestors are checked again.
        await Promise.allSettled(
            running.map((animation) => animation.finished),
        );
    }
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
    await waitForAncestorAnimations(options.host);

    const core = await modules.GhosttyCore.load({
        imageStorageLimit: 0,
        scrollbackLimit: 5000,
    });

    // No explicit cols and rows: wterm only measures the host on init when they are left
    // out, and otherwise starts at 80x24 until its resize observer catches up. A restored tab
    // attaches right after init, so it would join its session at 80x24.
    const terminal = new modules.WTerm(options.host, {
        autoResize: true,
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
