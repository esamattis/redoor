import { describe, expect, test } from "vitest";

import { formatKeyChord } from "./keyboard";

describe("formatKeyChord", () => {
    test("uses Ctrl and plus-joined words outside Apple platforms", () => {
        // Linux and Windows menus spell modifiers out in Ctrl, Alt, Shift order.
        expect(
            formatKeyChord({ mod: true, shift: true, key: "c" }, false),
        ).toBe("Ctrl+Shift+C");
        // An Alt chord must not gain a Ctrl it does not need.
        expect(formatKeyChord({ alt: true, key: "c" }, false)).toBe("Alt+C");
    });

    test("uses Command and Option symbols on Apple platforms", () => {
        // macOS menus map the primary modifier to Command and print symbols unseparated.
        expect(formatKeyChord({ mod: true, key: "x" }, true)).toBe("⌘X");
        // Symbols follow the macOS order Option, Shift, Command.
        expect(
            formatKeyChord(
                { mod: true, alt: true, shift: true, key: "c" },
                true,
            ),
        ).toBe("⌥⇧⌘C");
    });
});
