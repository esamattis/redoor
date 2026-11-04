import { describe, expect, test } from "vitest";
import type { LsEntry } from "#bindings/LsEntry";
import { describeDestinationEntries } from "#ui/destination-plan";
import {
    createUploadItems,
    planUploadRows,
    resolveUpload,
    type UploadDraftItem,
} from "#ui/upload-plan";

/** Makes a destination listing entry; only the name and type matter for planning. */
function entry(name: string, type: "file" | "directory" = "file"): LsEntry {
    return {
        name,
        type,
        size: 0,
        owner: null,
        group: null,
        uid: 0,
        gid: 0,
        modified_at: 0,
    };
}

/** Makes the items of one picked selection from relative paths. */
function picked(...paths: string[]): UploadDraftItem[] {
    return createUploadItems({
        origin: "picked",
        files: paths.map((relativePath) => ({
            file: new File(["x"], "x"),
            relativePath,
        })),
    });
}

/** Makes one pasted text item, whose name redoor made up. */
function pastedText(name = "pasted-text.txt"): UploadDraftItem[] {
    return createUploadItems({
        origin: "pasted",
        hasGeneratedName: true,
        pastedText: "hello",
        files: [{ file: new File(["hello"], name), relativePath: name }],
    });
}

describe("createUploadItems", () => {
    test("groups a directory tree into one item", () => {
        const items = createUploadItems({
            origin: "dropped",
            files: [
                { file: new File(["a"], "a"), relativePath: "photos/a.jpg" },
                { file: new File(["b"], "b"), relativePath: "notes.txt" },
            ],
            directories: ["photos", "photos/empty"],
        });

        // Only top-level names can collide in the destination, so a tree is one row.
        expect(
            items.map((item) => [item.name, item.entryType, item.files.length]),
        ).toEqual([
            ["photos", "directory", 1],
            ["notes.txt", "file", 1],
        ]);
    });

    test("refuses paths that escape the destination", () => {
        // A `..` path could write outside the chosen directory, so it never reaches the dialog.
        expect(() => picked("../outside.txt")).toThrow("Invalid upload path");
    });
});

describe("planUploadRows", () => {
    test("asks about a picked item whose name exists and suggests a free name", () => {
        const items = picked("notes.txt");

        const [row] = planUploadRows({
            items,
            destination: describeDestinationEntries([entry("notes.txt")]),
            choices: {},
        });

        // The user chose this name, so they are asked whether to replace the existing item.
        expect(row?.conflict).toEqual({
            existingName: "notes.txt",
            canMerge: false,
        });
        // Rename is the safe default and starts from a name that is free.
        expect(row?.resolution).toBe("rename");
        expect(row?.finalName).toBe("notes_2.txt");
        expect(row?.error).toBeNull();
    });

    test("keeps the own name when replacing", () => {
        const items = picked("notes.txt");
        const key = items[0]?.key ?? "";

        const [row] = planUploadRows({
            items,
            destination: describeDestinationEntries([entry("notes.txt")]),
            choices: { [key]: { resolution: "override" } },
        });

        // Replace must land on the existing item, so the name cannot drift to a suggestion.
        expect(row?.finalName).toBe("notes.txt");
        expect(row?.error).toBeNull();
    });

    test("offers merge only when a directory meets a directory", () => {
        const items = picked("photos/a.jpg");

        const [onDirectory] = planUploadRows({
            items,
            destination: describeDestinationEntries([
                entry("photos", "directory"),
            ]),
            choices: {},
        });

        const [onFile] = planUploadRows({
            items,
            destination: describeDestinationEntries([entry("photos")]),
            choices: { [items[0]?.key ?? ""]: { resolution: "merge" } },
        });

        // Merging only differs from replacing when both sides are directories.
        expect(onDirectory?.conflict?.canMerge).toBe(true);
        expect(onFile?.conflict?.canMerge).toBe(false);
        // A hidden Merge choice falls back to Rename instead of being submitted.
        expect(onFile?.resolution).toBe("rename");
    });

    test("gives a generated name a free one without asking", () => {
        const [row] = planUploadRows({
            items: pastedText(),
            destination: describeDestinationEntries([entry("pasted-text.txt")]),
            choices: {},
        });

        // The user never chose pasted-text.txt, so replacing the existing file is not offered.
        expect(row?.conflict).toBeNull();
        expect(row?.finalName).toBe("pasted-text_2.txt");
    });

    test("checks names against the encrypted name", () => {
        const items = picked("secret.env");
        const key = items[0]?.key ?? "";

        const [row] = planUploadRows({
            items,
            destination: describeDestinationEntries([entry("secret.env")]),
            choices: { [key]: { encrypt: true } },
        });

        // Encrypting writes secret.env.redoorencrypted, which does not collide with secret.env.
        expect(row?.conflict).toBeNull();
        expect(row?.finalName).toBe("secret.env.redoorencrypted");
    });

    test("rejects a typed name that is taken or invalid", () => {
        const items = [...picked("a.txt"), ...picked("b.txt")];
        const [first, second] = items;

        const rows = planUploadRows({
            items,
            destination: describeDestinationEntries([entry("existing.txt")]),
            choices: {
                [first?.key ?? ""]: { name: "existing.txt" },
                [second?.key ?? ""]: { name: "dir/b.txt" },
            },
        });

        // A typed name must not land on an existing item without the user choosing Replace.
        expect(rows[0]?.error).toBe(
            "existing.txt already exists in this directory",
        );
        // Separators would place the file in another directory.
        expect(rows[1]?.error).toBe(
            "File name must be a single path component",
        );
    });

    test("renames a later item that repeats an earlier name and frees it on removal", () => {
        const first = pastedText();
        const second = pastedText();

        const both = planUploadRows({
            items: [...first, ...second],
            destination: describeDestinationEntries([]),
            choices: {},
        });

        // Two pastes would otherwise write the same file twice.
        expect(both.map((row) => row.finalName)).toEqual([
            "pasted-text.txt",
            "pasted-text_2.txt",
        ]);

        const afterRemoval = planUploadRows({
            items: second,
            destination: describeDestinationEntries([]),
            choices: {},
        });

        // Removing the first row frees its name, so the suggestion follows instead of staying stale.
        expect(afterRemoval[0]?.finalName).toBe("pasted-text.txt");
    });
});

describe("resolveUpload", () => {
    test("moves a renamed, encrypted directory and suffixes each file", () => {
        const items = createUploadItems({
            origin: "dropped",
            files: [
                { file: new File(["a"], "a"), relativePath: "photos/a.jpg" },
            ],
            directories: ["photos", "photos/empty"],
        });

        const key = items[0]?.key ?? "";

        const rows = planUploadRows({
            items,
            destination: describeDestinationEntries([
                entry("photos", "directory"),
            ]),
            choices: { [key]: { name: "pics", encrypt: true } },
        });

        const resolved = resolveUpload(rows);

        // Every file is encrypted on its own, so each gets the vault suffix under the new name.
        expect(
            resolved.files.map((file) => [
                file.relativePath,
                file.encrypt,
                file.onExisting,
            ]),
        ).toEqual([["pics/a.jpg.redoorencrypted", true, "error"]]);
        // Empty directories move along with the rename.
        expect(resolved.directories).toEqual(["pics", "pics/empty"]);
        expect(resolved.replacedDirectoryNames).toEqual([]);
    });

    test("sends the chosen policy and lists directories to clear for Replace", () => {
        const items = picked("photos/a.jpg");
        const key = items[0]?.key ?? "";

        const rows = planUploadRows({
            items,
            destination: describeDestinationEntries([
                entry("photos", "directory"),
            ]),
            choices: { [key]: { resolution: "override" } },
        });

        const resolved = resolveUpload(rows);

        // The server needs the explicit policy, since it never replaces by default.
        expect(resolved.files[0]?.onExisting).toBe("override");
        // Uploads write file by file, so the old directory must be cleared first.
        expect(resolved.replacedDirectoryNames).toEqual(["photos"]);
    });
});
