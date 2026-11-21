// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";

import { ShortcutRegistry, shortcutPriority } from "#ui/shortcuts";
import type { ShortcutBinding } from "#ui/shortcuts";

/** Builds a binding for one key with sensible defaults, so each test states only what matters. */
function binding(
    name: string,
    key: string,
    overrides: Partial<ShortcutBinding> & Pick<ShortcutBinding, "run">,
): ShortcutBinding {
    return {
        name,
        phase: "bubble",
        priority: shortcutPriority.view,
        match: (event) => event.key === key,
        ...overrides,
    };
}

/** Presses a key on an element the way the browser would, through the real window listeners. */
function press(target: Element, key: string): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
    });

    target.dispatchEvent(event);

    return event;
}

/** Makes a handler that notes it ran, which is how the tests observe who got the key. */
function record(calls: string[], name: string) {
    return () => {
        calls.push(name);
    };
}

const cleanups: Array<() => void> = [];

/** Registers and remembers the removal so a failing test cannot leak bindings into the next. */
function register(registry: ShortcutRegistry, shortcut: ShortcutBinding) {
    cleanups.push(registry.register(shortcut));
}

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }

    document.body.replaceChildren();
});

describe("ShortcutRegistry priority and consumption", () => {
    test("offers a key to the highest priority first and stops at the first claimant", () => {
        const registry = new ShortcutRegistry(window);
        const calls: string[] = [];

        register(
            registry,
            binding("view", "x", {
                priority: shortcutPriority.view,
                run: record(calls, "view"),
            }),
        );

        register(
            registry,
            binding("modal", "x", {
                priority: shortcutPriority.modal,
                run: record(calls, "modal"),
            }),
        );

        press(document.body, "x");

        // The modal layer outranks the page, so the page never sees the claimed key.
        expect(calls).toEqual(["modal"]);
    });

    test("falls through to the next binding when one declines", () => {
        const registry = new ShortcutRegistry(window);
        const calls: string[] = [];

        register(
            registry,
            binding("declines", "x", {
                priority: shortcutPriority.editor,
                run: () => {
                    calls.push("declines");

                    return false;
                },
            }),
        );

        register(
            registry,
            binding("accepts", "x", { run: record(calls, "accepts") }),
        );

        const event = press(document.body, "x");

        // A declining binding did not handle the key, so it must neither block nor cancel it.
        expect(calls).toEqual(["declines", "accepts"]);
        // The accepting binding claimed the key, which cancels the browser default.
        expect(event.defaultPrevented).toBe(true);
    });

    test("breaks ties between equal priorities by registration order", () => {
        const registry = new ShortcutRegistry(window);
        const calls: string[] = [];

        register(
            registry,
            binding("first", "x", { run: record(calls, "first") }),
        );

        register(
            registry,
            binding("second", "x", { run: record(calls, "second") }),
        );

        press(document.body, "x");

        // Equal tiers keep the order they were registered in, so the outcome is deterministic.
        expect(calls).toEqual(["first"]);
    });

    test("a key claimed in capture is not offered again in bubble", () => {
        const registry = new ShortcutRegistry(window);
        const calls: string[] = [];

        register(
            registry,
            binding("capture", "x", {
                phase: "capture",
                run: record(calls, "capture"),
            }),
        );

        register(
            registry,
            binding("bubble", "x", { run: record(calls, "bubble") }),
        );

        press(document.body, "x");

        // One press has one winner across both phases, even when the first only prevents default.
        expect(calls).toEqual(["capture"]);
    });

    test("an observer sees keys that another binding then claims", () => {
        const registry = new ShortcutRegistry(window);
        const calls: string[] = [];

        register(
            registry,
            binding("claimant", "x", {
                priority: shortcutPriority.app,
                run: record(calls, "claimant"),
            }),
        );

        register(
            registry,
            binding("observer", "x", {
                priority: shortcutPriority.observer,
                run: () => {
                    calls.push("observer");

                    return false;
                },
            }),
        );

        press(document.body, "x");

        // Observers sit above every claimant, so they cannot be starved by a binding that wins.
        expect(calls).toEqual(["observer", "claimant"]);
    });
});

describe("ShortcutRegistry effects and filtering", () => {
    test("prevent keeps propagating, swallow stops it, shield keeps the default action", () => {
        const registry = new ShortcutRegistry(window);

        for (const [key, effect] of [
            ["p", "prevent"],
            ["w", "swallow"],
            ["s", "shield"],
        ] as const) {
            register(
                registry,
                binding(effect, key, {
                    // Capture, because only there can a binding hide the key from the page.
                    phase: "capture",
                    effect,
                    run: () => true,
                }),
            );
        }

        const seenByPage: string[] = [];

        document.body.addEventListener("keydown", (event) =>
            seenByPage.push(event.key),
        );

        const prevent = press(document.body, "p");
        const swallow = press(document.body, "w");
        const shield = press(document.body, "s");

        // Prevent cancels the default and still lets the focused element's handlers run.
        expect(prevent.defaultPrevented).toBe(true);
        // Swallow cancels the default and hides the key from everything beneath.
        expect(swallow.defaultPrevented).toBe(true);
        // Shield hides the key but leaves the browser's own behaviour, such as a Ctrl chord.
        expect(shield.defaultPrevented).toBe(false);
        // Only the key that was swallowed or shielded is missing from the page's own listener.
        expect(seenByPage).toEqual(["p"]);
    });

    test("skipTypingTargets keeps a binding out of text controls, the editor and the terminal", () => {
        const registry = new ShortcutRegistry(window);
        const calls: string[] = [];

        register(
            registry,
            binding("plain", "x", {
                skipTypingTargets: true,
                run: record(calls, "plain"),
            }),
        );

        const input = document.createElement("input");
        const terminal = document.createElement("div");
        terminal.setAttribute("data-terminal-input", "");
        const editor = document.createElement("div");
        editor.setAttribute("data-file-editor", "");
        const plain = document.createElement("button");
        document.body.append(input, terminal, editor, plain);

        press(input, "x");
        press(terminal, "x");
        press(editor, "x");
        // Typing into a control must never trigger a single-key command.
        expect(calls).toEqual([]);

        press(plain, "x");
        // Outside typing targets the same key does run the command.
        expect(calls).toEqual(["plain"]);
    });
});

describe("ShortcutRegistry lifetime", () => {
    test("listens only while something is registered", () => {
        const registry = new ShortcutRegistry(window);
        const calls: string[] = [];

        const unregister = registry.register(
            binding("temporary", "x", { run: record(calls, "temporary") }),
        );

        press(document.body, "x");
        unregister();
        press(document.body, "x");

        // After removal the key goes unclaimed, so the binding must not run a second time.
        expect(calls).toEqual(["temporary"]);
    });

    test("an unregistered registry leaves no window listener behind", () => {
        const added: string[] = [];
        const removed: string[] = [];
        const target = new EventTarget();
        const addEventListener = target.addEventListener.bind(target);
        const removeEventListener = target.removeEventListener.bind(target);

        target.addEventListener = (type, listener, options) => {
            added.push(type);
            addEventListener(type, listener, options);
        };

        target.removeEventListener = (type, listener, options) => {
            removed.push(type);
            removeEventListener(type, listener, options);
        };

        const registry = new ShortcutRegistry(target);

        registry.register(binding("one", "x", { run: () => true }))();

        // One capture and one bubble listener serve every binding, and both are released.
        expect(added).toEqual(["keydown", "keydown"]);
        expect(removed).toEqual(["keydown", "keydown"]);
    });
});
