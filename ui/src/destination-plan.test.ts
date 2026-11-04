import { describe, expect, test } from "vitest";
import {
    type DestinationItem,
    type DestinationNames,
    getSharedResolution,
    planDestinationNames,
    resolveAllConflicts,
} from "#ui/destination-plan";

/** A destination holding the given files and directories. */
function destination(
    files: string[],
    directories: string[] = [],
): DestinationNames {
    return {
        names: new Set([...files, ...directories]),
        directoryNames: new Set(directories),
    };
}

/** A file item whose key is its name, which is unique in these tests. */
function file(name: string, extra: Partial<DestinationItem> = {}) {
    return { key: name, name, entryType: "file" as const, ...extra };
}

describe("planDestinationNames", () => {
    test("keeps the own name of an item already at its destination", () => {
        const [row] = planDestinationNames({
            items: [file("notes.txt", { isAtDestination: true })],
            destination: destination(["notes.txt"]),
            choices: {},
        });

        // Copying a file onto itself is refused by the server, which says why; offering to
        // replace it or quietly renaming it would hide that.
        expect(row?.conflict).toBeNull();
        expect(row?.finalName).toBe("notes.txt");
        expect(row?.error).toBeNull();
    });

    test("sends the chosen policy only for conflicts", () => {
        const rows = planDestinationNames({
            items: [file("a.txt"), file("b.txt")],
            destination: destination(["a.txt"]),
            choices: { "a.txt": { resolution: "override" } },
        });

        // A replaced item carries the replace policy, while a new item must never overwrite.
        expect(rows.map((row) => row.onExisting)).toEqual([
            "override",
            "error",
        ]);
    });
});

describe("conflict bulk choice", () => {
    test("applies Merge where possible and Replace elsewhere", () => {
        const rows = planDestinationNames({
            items: [
                file("notes.txt"),
                { key: "photos", name: "photos", entryType: "directory" },
                file("free.txt"),
            ],
            destination: destination(["notes.txt"], ["photos"]),
            choices: {},
        });

        // "Merge directories and replace files" replaces a file that has nothing to merge
        // into, and leaves items without a conflict alone.
        expect(resolveAllConflicts(rows, "merge")).toEqual({
            "notes.txt": "override",
            photos: "merge",
        });
    });

    test("reports a shared choice only when every conflict agrees", () => {
        const items = [file("a.txt"), file("b.txt")];
        const existing = destination(["a.txt", "b.txt"]);

        const same = planDestinationNames({
            items,
            destination: existing,
            choices: {},
        });

        const mixed = planDestinationNames({
            items,
            destination: existing,
            choices: { "b.txt": { resolution: "override" } },
        });

        // The bulk select shows the common choice, or asks to choose for each item.
        expect(getSharedResolution(same)).toBe("rename");
        expect(getSharedResolution(mixed)).toBeNull();
    });
});
