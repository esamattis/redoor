import { expect, test } from "vitest";

import {
    commitDeviceOrder,
    defaultUserState,
    reorderBookmarks,
    reorderPinnedFiles,
    resolveDeviceOrder,
    userStateSchema,
    type Bookmark,
    type PinnedFile,
} from "#ui/user-state";

/** Supplies metadata so movement tests also exercise object preservation. */
function pin(agentId: string, name: string): PinnedFile {
    return { agentId, path: `/${name}`, name, agentName: agentId };
}

/** Gives each device a distinct path to prove that scoped moves retain ownership. */
function bookmark(agentId: string, name: string): Bookmark {
    return {
        agentId,
        path: `/${agentId}/${name}`,
        name,
        entryType: "file",
    };
}

test("old and malformed documents fall back without dropping other defaults", () => {
    const missing = userStateSchema.parse({ showHiddenFiles: false });
    // Older accounts have no device order and must not be rewritten on load.
    expect(missing.deviceOrder).toEqual([]);
    expect(missing.showHiddenFiles).toBe(false);
    expect(missing.theme).toBe(defaultUserState.theme);

    expect(userStateSchema.parse({ deviceOrder: "nope" }).deviceOrder).toEqual(
        [],
    );
    expect(
        userStateSchema.parse({ deviceOrder: [1, "a"] }).deviceOrder,
    ).toEqual([]);
    expect(userStateSchema.safeParse({}).success).toBe(true);
});

test("resolves device order from saved ids, then unsaved inventory order", () => {
    expect(resolveDeviceOrder([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(
        resolveDeviceOrder(["b", "b", "missing", "a"], ["a", "b", "c"]),
    ).toEqual(["b", "a", "c"]);
    // A returning id uses its remembered slot instead of appending as new.
    expect(
        resolveDeviceOrder(["a", "missing", "b"], ["a", "b", "missing"]),
    ).toEqual(["a", "missing", "b"]);
});

test("keeps unavailable device ids when the visible order changes", () => {
    const saved = ["a", "missing", "b"];
    const next = commitDeviceOrder(saved, ["a", "b", "c"], {
        activeId: "c",
        overId: "a",
    });

    // The missing device stays between the moved visible ids.
    expect(next).toEqual(["c", "missing", "a", "b"]);
    expect(resolveDeviceOrder(next, ["a", "b", "c"])).toEqual(["c", "a", "b"]);
});

test("does not normalize device order when the gesture changes nothing", () => {
    const saved = ["a", "missing"];

    expect(
        commitDeviceOrder(saved, ["a", "b", "c"], {
            activeId: "a",
            overId: "a",
        }),
    ).toBe(saved);
    expect(
        commitDeviceOrder(saved, ["a", "b"], {
            activeId: "gone",
            overId: "a",
        }),
    ).toBe(saved);
    expect(
        commitDeviceOrder([], ["only"], { activeId: "only", overId: "only" }),
    ).toEqual([]);
});

test("renames do not affect id-based device placement", () => {
    const saved = ["beta", "alpha"];
    // Display names are not part of the key, so a rename keeps the saved slots.
    expect(resolveDeviceOrder(saved, ["alpha", "beta"])).toEqual([
        "beta",
        "alpha",
    ]);
});

test("reorders pins and one bookmark scope against the latest arrays", () => {
    const pins = [pin("a", "one"), pin("b", "two"), pin("a", "three")];
    const movedPins = reorderPinnedFiles(pins, {
        activeId: "a:/three",
        overId: "a:/one",
    });
    expect(movedPins.map((file) => file.name)).toEqual(["three", "one", "two"]);
    expect(movedPins[1]).toBe(pins[0]);

    const bookmarks = [
        bookmark("a", "a1"),
        bookmark("b", "b1"),
        bookmark("a", "a2"),
        bookmark("b", "b2"),
        bookmark("a", "a3"),
    ];
    const moved = reorderBookmarks(bookmarks, "a", {
        activeId: "a:/a/a3",
        overId: "a:/a/a1",
    });
    expect(moved.map((entry) => entry.name)).toEqual([
        "a3",
        "b1",
        "a1",
        "b2",
        "a2",
    ]);
    // Equal names on another device stay in their slots.
    expect(
        moved
            .filter((entry) => entry.agentId === "b")
            .map((entry) => entry.path),
    ).toEqual(["/b/b1", "/b/b2"]);
});

test("a stale pin move cannot restore a removed pin or discard a new one", () => {
    const current = [pin("a", "one"), pin("a", "three"), pin("b", "fresh")];

    expect(
        reorderPinnedFiles(current, {
            activeId: "a:/two",
            overId: "a:/one",
        }),
    ).toBe(current);
    expect(
        reorderPinnedFiles(current, {
            activeId: "a:/three",
            overId: "a:/one",
        }).map((file) => file.name),
    ).toEqual(["three", "one", "fresh"]);
});
