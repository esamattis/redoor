import { expect, test } from "vitest";
import { EditorState, Text } from "@codemirror/state";

import {
    baseFromText,
    hashText,
    isDirtyAgainst,
    minimalChange,
    reconcileDeviceContent,
} from "./buffer-sync";

/** Builds a document from a string, splitting lines the way the editor does. */
function text(content: string): Text {
    return Text.of(content.split(/\r\n?|\n/));
}

test("device text equal to the base leaves any buffer alone", () => {
    const base = baseFromText(text("original"));

    // Nothing changed on the device, so neither a clean nor a dirty buffer needs work.
    expect(
        reconcileDeviceContent(text("original"), base, text("original")),
    ).toEqual({
        kind: "unchanged",
    });
    expect(
        reconcileDeviceContent(text("edited"), base, text("original")),
    ).toEqual({
        kind: "unchanged",
    });
});

test("a clean buffer takes device changes and a dirty one only reports a conflict", () => {
    const base = baseFromText(text("one\ntwo\nthree"));

    const clean = reconcileDeviceContent(
        text("one\ntwo\nthree"),
        base,
        text("one\nTWO\nthree"),
    );

    // Clean buffers follow the device so the editor shows what is on disk.
    expect(clean.kind).toBe("apply");

    // The browser always wins for a dirty buffer, so the device text must not be applied.
    expect(
        reconcileDeviceContent(
            text("one\nmine\nthree"),
            base,
            text("one\nTWO\nthree"),
        ),
    ).toEqual({ kind: "conflict" });

    // Edits that already match the device need no warning; they become the clean base.
    expect(reconcileDeviceContent(text("same"), base, text("same"))).toEqual({
        kind: "adopt",
    });
});

test("a base known only by hash still tells clean, dirty and changed apart", () => {
    const original = text("restored base");
    const base = { text: null, hash: hashText(original) };

    // After a reload only the hash is stored, yet an untouched device must match it.
    expect(reconcileDeviceContent(text("edited"), base, original)).toEqual({
        kind: "unchanged",
    });
    // Edited text is dirty against the hash.
    expect(isDirtyAgainst(text("edited"), base)).toBe(true);
    // The base text itself is clean against the hash.
    expect(isDirtyAgainst(original, base)).toBe(false);
    // A changed device under edits is a conflict even without the base text.
    expect(
        reconcileDeviceContent(text("edited"), base, text("device")),
    ).toEqual({
        kind: "conflict",
    });
    // A clean restored buffer follows a changed device.
    expect(reconcileDeviceContent(original, base, text("device")).kind).toBe(
        "apply",
    );
});

test("the minimal change only replaces the differing middle", () => {
    const before = text("keep start CHANGE keep end");
    const after = text("keep start new text keep end");

    // Positions outside the edit must map to themselves, so the caret stays put.
    expect(minimalChange(before, after)).toEqual({
        from: 11,
        to: 17,
        insert: "new text",
    });

    const state = EditorState.create({ doc: before.toString() });

    const applied = state.update({
        changes: minimalChange(before, after),
    }).state;

    // Applying the change yields exactly the device text.
    expect(applied.doc.toString()).toBe(after.toString());
});

test("hashes differ for different text and match for equal text", () => {
    // Equal documents must hash equally so a reload can recognize its base.
    expect(hashText(text("a\nb"))).toBe(hashText(text("a\nb")));
    // A one-character edit must change the hash, or a dirty buffer would look clean.
    expect(hashText(text("a\nb"))).not.toBe(hashText(text("a\nc")));
});
