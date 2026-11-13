import { expect, test } from "vitest";

import {
    commitDeviceOrder,
    defaultUserState,
    getOpenFileParentLabels,
    getStaleOpenFiles,
    openFileAtLine,
    reorderBookmarks,
    reorderOpenFiles,
    resolveDeviceOrder,
    setOpenFileLine,
    stampUntouchedOpenFiles,
    TOUCH_REFRESH_MS,
    touchOpenFiles,
    userStateSchema,
    type Bookmark,
    type OpenFile,
} from "#ui/user-state";

/** Supplies metadata so movement tests also exercise object preservation. */
function openEntry(agentId: string, name: string): OpenFile {
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
    // A document without a device order keeps the empty default instead of failing to load.
    expect(missing.deviceOrder).toEqual([]);
    // Saved documents from before the device filter must continue to show all devices.
    expect(missing.showOnlyConnectedDevices).toBe(false);
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

test("reorders open files and one bookmark scope against the latest arrays", () => {
    const files = [
        openEntry("a", "one"),
        openEntry("b", "two"),
        openEntry("a", "three"),
    ];

    const movedFiles = reorderOpenFiles(files, {
        activeId: "a:/three",
        overId: "a:/one",
    });

    expect(movedFiles.map((file) => file.name)).toEqual([
        "three",
        "one",
        "two",
    ]);
    expect(movedFiles[1]).toBe(files[0]);

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

test("a stale open file move cannot restore a closed file or discard a new one", () => {
    const current = [
        openEntry("a", "one"),
        openEntry("a", "three"),
        openEntry("b", "fresh"),
    ];

    expect(
        reorderOpenFiles(current, {
            activeId: "a:/two",
            overId: "a:/one",
        }),
    ).toBe(current);
    expect(
        reorderOpenFiles(current, {
            activeId: "a:/three",
            overId: "a:/one",
        }).map((file) => file.name),
    ).toEqual(["three", "one", "fresh"]);
});

test("opens a file at a line without moving an already open file", () => {
    const files = [openEntry("a", "one"), openEntry("a", "two")];
    const reveal = { line: 42, id: "r1" };

    const appended = openFileAtLine(files, openEntry("b", "three"), reveal);
    // A newly opened file goes last, carrying the line to show when it is visited.
    expect(appended.map((file) => file.name)).toEqual(["one", "two", "three"]);
    expect(appended[2]?.reveal).toEqual(reveal);

    const moved = openFileAtLine(files, openEntry("a", "one"), reveal);
    // An open file keeps its place and only gets the new line.
    expect(moved.map((file) => file.name)).toEqual(["one", "two"]);
    expect(moved[0]?.reveal).toEqual(reveal);
    // The shown caret line moves at once, confirming the click before the file is visited.
    expect(moved[0]?.line).toBe(42);
    expect(appended[2]?.line).toBe(42);
    // The other files are untouched, so React keeps their rows.
    expect(moved[1]).toBe(files[1]);

    // Without a line, opening an open file changes nothing, so no settings write follows.
    expect(openFileAtLine(files, openEntry("a", "two"), undefined)).toBe(files);
});

test("records an open file's caret line without rewriting an unchanged list", () => {
    const files = [openEntry("a", "one"), openEntry("a", "two")];

    const moved = setOpenFileLine(files, {
        key: "a:/two",
        line: 7,
        appliedReveal: null,
    });

    // Only the file whose buffer was written gets the line.
    expect(moved[1]?.line).toBe(7);
    // The other rows keep their objects, so React keeps them.
    expect(moved[0]).toBe(files[0]);

    // The same line again keeps the list, so a write within a line sends no settings write.
    expect(
        setOpenFileLine(moved, { key: "a:/two", line: 7, appliedReveal: null }),
    ).toBe(moved);
    // A buffer of a file no longer open changes nothing.
    expect(
        setOpenFileLine(files, {
            key: "a:/gone",
            line: 3,
            appliedReveal: null,
        }),
    ).toBe(files);
});

test("a caret written before a line request is shown keeps the requested line", () => {
    const requested = openFileAtLine(
        [{ ...openEntry("a", "one"), line: 5 }],
        openEntry("a", "one"),
        { line: 42, id: "r2" },
    );

    // A write still carrying the old caret must not undo a request the file has not shown.
    expect(
        setOpenFileLine(requested, {
            key: "a:/one",
            line: 5,
            appliedReveal: "r1",
        }),
    ).toBe(requested);

    const shown = setOpenFileLine(requested, {
        key: "a:/one",
        line: 43,
        appliedReveal: "r2",
    });

    // Once the request is applied, the caret is followed again.
    expect(shown[0]?.line).toBe(43);
});

test("a malformed line request keeps the open file", () => {
    const parsed = userStateSchema.parse({
        openFiles: [{ ...openEntry("a", "one"), reveal: { line: "x" } }],
    });

    // Only the line is lost; dropping the whole list would close every open file.
    expect(parsed.openFiles).toEqual([openEntry("a", "one")]);
});

/** Builds an open file at a path, named after its last segment like the editor does. */
function openFileAt(path: string, agentId = "agent"): OpenFile {
    return {
        agentId,
        path,
        name: path.split("/").at(-1) ?? path,
        agentName: agentId,
    };
}

test("labels same-named open files with the fewest parents that tell them apart", () => {
    const files = [
        openFileAt("/repo/.agents/skills/open-pr/SKILL.md"),
        openFileAt("/repo/.agents/skills/code-review/SKILL.md"),
        openFileAt("/repo/README.md"),
    ];

    const labels = getOpenFileParentLabels(files);

    // One parent already differs, so deeper directories would only add noise.
    expect(labels.get("agent:/repo/.agents/skills/open-pr/SKILL.md")).toBe(
        "open-pr",
    );
    expect(labels.get("agent:/repo/.agents/skills/code-review/SKILL.md")).toBe(
        "code-review",
    );
    // A unique name needs no parents.
    expect(labels.has("agent:/repo/README.md")).toBe(false);
});

test("adds parents until same-named files whose nearest directories match differ", () => {
    const labels = getOpenFileParentLabels([
        openFileAt("/a/src/index.ts"),
        openFileAt("/b/src/index.ts"),
        openFileAt("/b/lib/index.ts"),
    ]);

    // Both share `src`, so each needs the directory above it as well.
    expect(labels.get("agent:/a/src/index.ts")).toBe("a/src");
    expect(labels.get("agent:/b/src/index.ts")).toBe("b/src");
    // `lib` alone is already unique among the three.
    expect(labels.get("agent:/b/lib/index.ts")).toBe("lib");
});

test("shows every parent of a file whose path is a suffix of another", () => {
    const labels = getOpenFileParentLabels([
        openFileAt("/src/index.ts"),
        openFileAt("/app/src/index.ts"),
    ]);

    // The shorter path runs out of parents, so it shows all it has.
    expect(labels.get("agent:/src/index.ts")).toBe("src");
    expect(labels.get("agent:/app/src/index.ts")).toBe("app/src");
});

test("leaves the same path on two devices to the device name", () => {
    const labels = getOpenFileParentLabels([
        openFileAt("/etc/hosts", "one"),
        openFileAt("/etc/hosts", "two"),
    ]);

    // Directories cannot tell identical paths apart; the row shows the device instead.
    expect(labels.size).toBe(0);
});

const HOUR_MS = 60 * 60 * 1000;

test("finds open files untouched for longer than the auto-close delay", () => {
    const now = 100 * HOUR_MS;
    const fresh = { ...openEntry("a", "fresh"), touchedAt: now - HOUR_MS };
    const stale = { ...openEntry("a", "stale"), touchedAt: now - 25 * HOUR_MS };
    const unknown = openEntry("a", "unknown");

    const state = {
        openFiles: [fresh, stale, unknown],
        autoCloseOpenFiles: true,
        autoCloseOpenFilesAfterHours: 24,
    };

    // Only the file past the delay is stale; one without a touch time waits to be stamped.
    expect(getStaleOpenFiles(state, now)).toEqual([stale]);
    // A shorter delay catches the recently touched file too.
    expect(
        getStaleOpenFiles({ ...state, autoCloseOpenFilesAfterHours: 1 }, now),
    ).toEqual([stale]);
    expect(
        getStaleOpenFiles(
            { ...state, autoCloseOpenFilesAfterHours: 1 },
            now + 1,
        ),
    ).toEqual([fresh, stale]);
    // Turning auto-close off keeps every file open.
    expect(
        getStaleOpenFiles({ ...state, autoCloseOpenFiles: false }, now),
    ).toEqual([]);
});

test("stamps and touches open files without rewriting unchanged lists", () => {
    const files = [
        { ...openEntry("a", "one"), touchedAt: 1 },
        openEntry("a", "two"),
    ];

    const stamped = stampUntouchedOpenFiles(files, 50);
    // Files from before touch times were recorded start their delay now.
    expect(stamped[1]?.touchedAt).toBe(50);
    // A file that already has a touch time keeps it.
    expect(stamped[0]).toBe(files[0]);
    // A fully stamped list is returned as is, so the sweep sends no settings write.
    expect(stampUntouchedOpenFiles(stamped, 60)).toBe(stamped);

    const touched = touchOpenFiles(stamped, new Set(["a:/one"]), 70);
    // Showing or leaving a file restarts its delay.
    expect(touched[0]?.touchedAt).toBe(70);
    // A key that is no longer open does not bring the file back or rewrite the list.
    expect(touchOpenFiles(stamped, new Set(["a:/gone"]), 70)).toBe(stamped);
});

test("a caret report refreshes an old touch time even on the same line", () => {
    const files = [{ ...openEntry("a", "one"), line: 3, touchedAt: 0 }];

    // A recent touch on the same line sends no settings write while typing.
    expect(
        setOpenFileLine(
            files,
            { key: "a:/one", line: 3, appliedReveal: null },
            TOUCH_REFRESH_MS - 1,
        ),
    ).toBe(files);

    // Editing a file for longer than the refresh interval keeps it from looking untouched.
    const refreshed = setOpenFileLine(
        files,
        { key: "a:/one", line: 3, appliedReveal: null },
        TOUCH_REFRESH_MS,
    );

    expect(refreshed[0]?.touchedAt).toBe(TOUCH_REFRESH_MS);
});
