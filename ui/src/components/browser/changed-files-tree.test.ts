import { expect, test } from "vitest";
import { buildChangedFilesTree } from "./changed-files-tree";

/** Builds an outline file from its repository-relative path. */
function file(relativePath: string) {
    return { path: `/repo/${relativePath}`, relativePath, change: null };
}

/** Reduces rows to indented labels, so the expected tree reads like the side menu. */
function outline(rows: ReturnType<typeof buildChangedFilesTree>) {
    return rows.map(
        (row) =>
            `${" ".repeat(row.depth)}${row.label}${row.kind === "directory" ? "/" : ""}`,
    );
}

test("nests files under their directories with directories first", () => {
    const rows = buildChangedFilesTree(
        [
            file("README.md"),
            file("src/my-test/helpers.ts"),
            file("src/server.ts"),
            file("src/server.test.ts"),
        ],
        new Set(),
    );

    // Directories lead their level and files keep the diff's order.
    expect(outline(rows)).toEqual([
        "src/",
        " my-test/",
        "  helpers.ts",
        " server.ts",
        " server.test.ts",
        "README.md",
    ]);
});

test("merges directories that hold only one directory into one row", () => {
    const rows = buildChangedFilesTree(
        [file("crates/core/src/lib.rs"), file("crates/core/src/log.rs")],
        new Set(),
    );

    // A chain of lone directories would waste a row and an indent per level.
    expect(outline(rows)).toEqual(["crates/core/src/", " lib.rs", " log.rs"]);
});

test("leaves out the rows under a folded directory", () => {
    const rows = buildChangedFilesTree(
        [file("src/my-test/helpers.ts"), file("src/server.ts")],
        new Set(["src/my-test"]),
    );

    // The folded directory itself stays so it can be unfolded again.
    expect(outline(rows)).toEqual(["src/", " my-test/", " server.ts"]);
    expect(rows[1]).toMatchObject({ path: "src/my-test", isFolded: true });
});

test("keeps a folded directory folded when filtering merges it into a chain", () => {
    // A filter left only helpers.ts, so src now holds nothing but my-test.
    const rows = buildChangedFilesTree(
        [file("src/my-test/helpers.ts")],
        new Set(["src"]),
    );

    // The merged row stands for the folded src, so it must hide the filtered file too.
    expect(outline(rows)).toEqual(["src/my-test/"]);
    expect(rows[0]).toMatchObject({
        chainPaths: ["src", "src/my-test"],
        isFolded: true,
    });
});
