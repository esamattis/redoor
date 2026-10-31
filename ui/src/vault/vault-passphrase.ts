/**
 * Generated passphrases for the vault. A passphrase is the user's recovery path when
 * passkeys are lost, so the generated one has to resist offline guessing of a leaked
 * `vault.json` on its own and still be easy to read, type and store.
 */

/**
 * Lowercase letters and digits without the look-alikes 0/o and 1/l, so a passphrase copied
 * by hand from paper or a screen cannot be misread. 32 symbols give 5 bits each.
 */
export const PASSPHRASE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** Five groups of five: 125 bits, comfortably above the 100-bit target. */
export const PASSPHRASE_GROUPS = 5;

/** Five symbols per group stay easy to read and type in one glance. */
export const PASSPHRASE_GROUP_LENGTH = 5;

/** Fills a buffer with random bytes; injectable so tests can force rejections. */
export type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => void;

/** The platform's cryptographically secure generator. */
function secureRandom(bytes: Uint8Array<ArrayBuffer>): void {
    crypto.getRandomValues(bytes);
}

/**
 * A uniform index below `size` from random bytes. Bytes at or above the largest multiple of
 * `size` are rejected and drawn again, because folding them in with a modulo would make the
 * first symbols more likely than the rest.
 */
export function uniformIndex(size: number, random: RandomSource): number {
    if (size < 1 || size > 256) {
        throw new RangeError("The alphabet must have 1 to 256 symbols");
    }

    const limit = 256 - (256 % size);
    const byte = new Uint8Array(1);

    for (;;) {
        random(byte);

        const value = byte[0] ?? 0;

        if (value < limit) {
            return value % size;
        }
    }
}

/** The entropy of a generated passphrase in bits. */
export function generatedPassphraseBits(): number {
    return (
        PASSPHRASE_GROUPS *
        PASSPHRASE_GROUP_LENGTH *
        Math.log2(PASSPHRASE_ALPHABET.length)
    );
}

/**
 * A new random passphrase such as `k7m2q-x9frt-...`: groups joined with "-", so it can be
 * read aloud or typed in chunks. No word list is bundled, which keeps the UI small.
 */
export function generatePassphrase(
    random: RandomSource = secureRandom,
): string {
    const groups: string[] = [];

    for (let group = 0; group < PASSPHRASE_GROUPS; group++) {
        let chunk = "";

        for (let index = 0; index < PASSPHRASE_GROUP_LENGTH; index++) {
            chunk +=
                PASSPHRASE_ALPHABET[
                    uniformIndex(PASSPHRASE_ALPHABET.length, random)
                ];
        }

        groups.push(chunk);
    }

    return groups.join("-");
}
