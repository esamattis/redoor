import type { ChangeSpec, Text } from "@codemirror/state";

/**
 * What the editor must do with a buffer once the device reports its current content. The
 * browser always wins for a dirty buffer, so device text is only applied to clean buffers and
 * otherwise merely reported as a conflict.
 */
export type DeviceContentAction =
    /** The device still holds what the buffer was based on, so nothing changed underneath. */
    | { kind: "unchanged" }
    /** The buffer is clean, so the device text replaces it through these minimal changes. */
    | { kind: "apply"; changes: ChangeSpec }
    /** The unsaved text already equals the device text, so it becomes the new clean base. */
    | { kind: "adopt" }
    /** The device changed under unsaved browser edits, which must not be overwritten. */
    | { kind: "conflict" };

/**
 * The device text a buffer was loaded from or last saved as. A buffer restored from the
 * server only knows the hash, since storing the text again would double every payload; the
 * text is filled in once the device is seen to still hold it.
 */
export type BufferBase = {
    text: Text | null;
    hash: string;
};

/**
 * A fast 53-bit string hash (cyrb53). It only has to tell whether a document equals the one
 * a buffer was based on, not resist tampering, and it must be synchronous for keystrokes.
 */
export function hashText(text: Text): string {
    const content = text.toString();
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;

    for (let index = 0; index < content.length; index += 1) {
        const code = content.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }

    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    return `${content.length.toString(36)}-${(h2 >>> 0).toString(36)}-${(h1 >>> 0).toString(36)}`;
}

/** Creates the base of a buffer whose device text is known. */
export function baseFromText(text: Text): BufferBase {
    return { text, hash: hashText(text) };
}

/** Whether the document differs from what the device held when the buffer was based on it. */
export function isDirtyAgainst(doc: Text, base: BufferBase): boolean {
    return base.text === null
        ? hashText(doc) !== base.hash
        : !doc.eq(base.text);
}

/**
 * Decides how device content reaches a buffer. `doc` is the buffer's current text and
 * `base` the device text it was based on, so `doc != base` means unsaved edits.
 */
export function reconcileDeviceContent(
    doc: Text,
    base: BufferBase,
    device: Text,
): DeviceContentAction {
    const deviceMatchesBase =
        base.text === null
            ? hashText(device) === base.hash
            : device.eq(base.text);

    if (deviceMatchesBase) {
        return { kind: "unchanged" };
    }

    if (doc.eq(device)) {
        return { kind: "adopt" };
    }

    if (!isDirtyAgainst(doc, base)) {
        return { kind: "apply", changes: minimalChange(doc, device) };
    }

    return { kind: "conflict" };
}

/**
 * Replaces only the differing middle of a document, so the caret, selection and scroll
 * position outside an external edit stay where the user left them, instead of the whole
 * document being swapped and every position collapsing to the start.
 */
export function minimalChange(from: Text, to: Text): ChangeSpec {
    const before = from.toString();
    const after = to.toString();
    const shortest = Math.min(before.length, after.length);
    let prefix = 0;

    while (
        prefix < shortest &&
        before.charCodeAt(prefix) === after.charCodeAt(prefix)
    ) {
        prefix += 1;
    }

    let suffix = 0;

    while (
        suffix < shortest - prefix &&
        before.charCodeAt(before.length - 1 - suffix) ===
            after.charCodeAt(after.length - 1 - suffix)
    ) {
        suffix += 1;
    }

    return {
        from: prefix,
        to: before.length - suffix,
        insert: after.slice(prefix, after.length - suffix),
    };
}
