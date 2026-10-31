import { describe, expect, test } from "vitest";

import { passphraseProblem } from "#ui/vault/vault-keys";
import {
    PASSPHRASE_ALPHABET,
    generatePassphrase,
    generatedPassphraseBits,
    uniformIndex,
} from "#ui/vault/vault-passphrase";

/** Five dash-joined groups of five symbols from the unambiguous alphabet. */
const FORMAT = new RegExp(
    `^[${PASSPHRASE_ALPHABET}]{5}(-[${PASSPHRASE_ALPHABET}]{5}){4}$`,
);

describe("generated vault passphrases", () => {
    test("have the readable group format and only unambiguous symbols", () => {
        const passphrase = generatePassphrase();

        // Users read and type these by hand, so the shape must stay predictable.
        expect(passphrase).toMatch(FORMAT);
        // Look-alikes would make a hand-copied passphrase fail to unlock.
        expect(passphrase).not.toMatch(/[0o1l]/);
    });

    test("carry at least 100 bits of entropy", () => {
        // A leaked vault.json allows offline guessing, so the passphrase alone must hold.
        expect(generatedPassphraseBits()).toBeGreaterThanOrEqual(100);
        // The alphabet size the entropy assumes must not shrink unnoticed.
        expect(new Set(PASSPHRASE_ALPHABET).size).toBe(32);
    });

    test("always pass the passphrase rules and differ every time", () => {
        const generated = Array.from({ length: 200 }, () =>
            generatePassphrase(),
        );

        // The Generate button must never fill in a passphrase the form then refuses.
        expect(generated.filter((value) => passphraseProblem(value))).toEqual(
            [],
        );
        // Repeats would mean the generator is not drawing fresh randomness.
        expect(new Set(generated).size).toBe(generated.length);
    });

    test("rejects bytes that would bias the modulo", () => {
        const bytes = [255, 254, 7];
        let call = 0;

        const index = uniformIndex(3, (buffer) => {
            buffer[0] = bytes[call] ?? 0;
            call += 1;
        });

        // 255 is above the largest multiple of 3, so it is redrawn instead of folded in.
        expect(index).toBe(254 % 3);
        expect(call).toBe(2);
    });
});
