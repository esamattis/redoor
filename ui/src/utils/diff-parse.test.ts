import { expect, test } from "vitest";
import {
    countPatchLines,
    fileLines,
    isExpandable,
    lineSideText,
    parseDiff,
    type DiffHunk,
} from "#ui/utils/diff-parse";

/** Returns a file's hunks without skip blocks, failing loudly when the file is missing. */
function hunksOf(diff: string, fileIndex = 0): DiffHunk[] {
    const file = parseDiff(diff)[fileIndex];

    if (file === undefined) {
        throw new Error(`No file ${String(fileIndex)} in the diff`);
    }

    return file.hunks.filter((hunk) => hunk.type === "hunk");
}

test("pairs a similar deleted and inserted line into one modified row", () => {
    const lines = hunksOf(`--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const first = 1;
-const value = "old";
+const value = "new";
 const last = 3;
`)[0]?.lines;

    // The edit shows as one row so the reader sees what changed within the line.
    expect(lines?.map((line) => line.kind)).toEqual([
        "normal",
        "modified",
        "normal",
    ]);

    const modified = lines?.[1];

    // A modified row keeps both line numbers, so the new one can open the editor.
    expect(modified?.oldLineNumber).toBe(2);
    expect(modified?.newLineNumber).toBe(2);
    // The segments must rebuild each side exactly, or highlighting would be cut wrongly.
    expect(modified && lineSideText(modified, "old")).toBe(
        'const value = "old";',
    );
    expect(modified && lineSideText(modified, "new")).toBe(
        'const value = "new";',
    );
    // Only the changed word is marked.
    expect(
        modified?.segments.filter((segment) => segment.type !== "normal"),
    ).toEqual([
        { type: "delete", value: "old" },
        { type: "insert", value: "new" },
    ]);
});

test("keeps whitespace-only edits visible in a modified row", () => {
    const modified = hunksOf(`--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-a  b
+a b
`)[0]?.lines[0];

    // A plain word diff would call this line unchanged, hiding the edit entirely.
    expect(
        modified?.segments.some((segment) => segment.type !== "normal"),
    ).toBe(true);
    expect(modified && lineSideText(modified, "old")).toBe("a  b");
    expect(modified && lineSideText(modified, "new")).toBe("a b");
});

test("leaves dissimilar lines as separate deletes and inserts", () => {
    const lines = hunksOf(`--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-completely different text
+nothing alike here at all!
`)[0]?.lines;

    // Pairing unrelated lines would produce an unreadable inline diff.
    expect(lines?.map((line) => line.kind)).toEqual(["delete", "insert"]);
});

test("lists every line separately when merging is turned off", () => {
    const file = parseDiff(
        `--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-value = 1
+value = 2
`,
        { mergeModifiedLines: false },
    )[0];

    const hunk = file?.hunks[0];

    // The classic view must stay available for readers who prefer -/+ rows.
    expect(
        hunk?.type === "hunk" ? hunk.lines.map((line) => line.kind) : [],
    ).toEqual(["delete", "insert"]);
});

test("marks the changed words of similar lines shown separately", () => {
    const hunk = parseDiff(
        `--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,3 @@
-await expect(separate).toBe(false);
-something removed entirely
+await expect(inline).toBe(false);
+nothing alike here at all!
`,
        { mergeModifiedLines: false },
    )[0]?.hunks[0];

    const lines = hunk?.type === "hunk" ? hunk.lines : [];

    // Similar lines keep their own -/+ rows in patch order instead of merging.
    expect(lines.map((line) => line.kind)).toEqual([
        "delete",
        "delete",
        "insert",
        "insert",
    ]);
    // Each row holds only its own side, so only the replaced word stands out.
    expect(lines[0]?.segments).toEqual([
        { value: "await expect(", type: "normal" },
        { value: "separate", type: "delete" },
        { value: ").toBe(false);", type: "normal" },
    ]);
    expect(lines[2]?.segments).toEqual([
        { value: "await expect(", type: "normal" },
        { value: "inline", type: "insert" },
        { value: ").toBe(false);", type: "normal" },
    ]);
    // Unrelated lines stay unmarked, since a word diff of them would be noise.
    expect(lines[1]?.segments).toEqual([
        { value: "something removed entirely", type: "normal" },
    ]);
    expect(lines[3]?.segments).toEqual([
        { value: "nothing alike here at all!", type: "normal" },
    ]);
});

test("reads added and deleted files written without /dev/null", () => {
    const added = parseDiff(`--- a/new.txt
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
`)[0];

    const deleted = parseDiff(`--- a/old.txt
+++ b/old.txt
@@ -1,2 +0,0 @@
-one
-two
`)[0];

    // The similar crate marks empty sides only through a zero-length hunk side.
    expect(added?.type).toBe("add");
    expect(added?.newPath).toBe("new.txt");
    // No skip block may precede a hunk that starts at the top of an empty file.
    expect(added?.hunks.map((hunk) => hunk.type)).toEqual(["hunk"]);
    expect(deleted?.type).toBe("delete");
    expect(
        deleted?.hunks[0]?.type === "hunk"
            ? deleted.hunks[0].lines.map((line) => line.kind)
            : [],
    ).toEqual(["delete", "delete"]);
});

test("marks the line Git reports without a trailing newline", () => {
    const lines = hunksOf(`--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
`)[0]?.lines;

    // The marker belongs to the deleted line, which is the only one missing a newline.
    expect(lines?.map((line) => [line.kind, line.missingNewline])).toEqual([
        ["delete", true],
        ["insert", false],
    ]);
});

test("reads several files, Git headers, renames, and binary files", () => {
    const files = parseDiff(`diff --git a/one.ts b/one.ts
index 1111111..2222222 100644
--- a/one.ts
+++ b/one.ts
@@ -1 +1 @@
-a
+b
diff --git a/old name.ts b/new name.ts
similarity index 100%
rename from old name.ts
rename to new name.ts
diff --git a/image.png b/image.png
new file mode 100644
Binary files /dev/null and b/image.png differ
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
`);

    // Every file of a multi-file patch keeps its own name and kind of change.
    expect(
        files.map((file) => [
            file.type,
            file.oldPath,
            file.newPath,
            file.isBinary,
        ]),
    ).toEqual([
        ["modify", "one.ts", "one.ts", false],
        ["rename", "old name.ts", "new name.ts", false],
        ["add", "image.png", "image.png", true],
        ["delete", "gone.ts", null, false],
    ]);
});

test("keeps absolute Sync paths and marks skipped lines between hunks", () => {
    const file = parseDiff(`--- /home/left.txt
+++ /srv/right.txt
@@ -1,2 +1,2 @@
-left
+right
 same
@@ -10,2 +10,2 @@ section name
 same
-x
+y
`)[0];

    // Absolute paths must not lose their leading characters to Git prefix stripping.
    expect(file?.oldPath).toBe("/home/left.txt");
    expect(file?.newPath).toBe("/srv/right.txt");
    // The gap between hunks is announced with the section Git printed for it.
    expect(file?.hunks[1]).toEqual({
        type: "skip",
        count: 7,
        content: "section name",
        // A default-context patch does not carry the skipped lines, so they cannot expand.
        lines: null,
    });
});

test("does not mistake content lines for file headers", () => {
    const lines = hunksOf(`--- a/x.md
+++ b/x.md
@@ -1,2 +1,2 @@
--- removed rule
+++ added rule
 tail
`)[0]?.lines;

    // Within a hunk's counted lines, "--- " and "+++ " are content, not a new file.
    expect(
        lines?.map((line) =>
            lineSideText(line, line.kind === "delete" ? "old" : "new"),
        ),
    ).toEqual(["-- removed rule", "++ added rule", "tail"]);
});

/** Writes a whole-file patch of numbered lines with the given new-side replacements. */
function wholeFilePatch(lineCount: number, changed: number[]): string {
    const body = Array.from({ length: lineCount }, (_, index) => {
        const line = index + 1;

        return changed.includes(line)
            ? `-line ${String(line)}\n+line ${String(line)} edited`
            : ` line ${String(line)}`;
    });

    return `--- a/file.txt
+++ b/file.txt
@@ -1,${String(lineCount)} +1,${String(lineCount)} @@
${body.join("\n")}
`;
}

test("folds a whole-file patch to default context with expandable gaps", () => {
    const file = parseDiff(wholeFilePatch(40, [10, 30]), {
        fullContext: true,
    })[0];

    // Unchanged stretches fold like a default-context patch: before, between and after.
    expect(
        file?.hunks.map((hunk) =>
            hunk.type === "skip" ? `skip ${String(hunk.count)}` : hunk.header,
        ),
    ).toEqual([
        "skip 6",
        "@@ -7,7 +7,7 @@",
        "skip 13",
        "@@ -27,7 +27,7 @@",
        "skip 7",
    ]);

    // The folded rows carry their own numbers, so revealing them needs no request.
    const trailing = file?.hunks.at(-1);
    expect(
        trailing?.type === "skip"
            ? trailing.lines?.map((line) => line.newLineNumber)
            : null,
    ).toEqual([34, 35, 36, 37, 38, 39, 40]);
    // Every line of the file stays available for highlighting and line numbering, each
    // edit being one modified row.
    expect(file === undefined ? 0 : fileLines(file).length).toBe(40);
    // The view offers expansion only when the patch carried the folded lines.
    expect(file === undefined ? false : isExpandable(file)).toBe(true);
});

test("pairs edits within each folded hunk as a default-context patch would", () => {
    const hunks = parseDiff(wholeFilePatch(40, [10, 30]), {
        fullContext: true,
    })[0]?.hunks.filter((hunk) => hunk.type === "hunk");

    // Each edit stays one modified row inside its own hunk.
    expect(
        hunks?.map(
            (hunk) =>
                hunk.lines.filter((line) => line.kind === "modified").length,
        ),
    ).toEqual([1, 1]);
});

test("keeps single-line gaps visible instead of folding them", () => {
    // Lines 1 to 3 are context for line 5's change; line 4 alone would be folded.
    const file = parseDiff(wholeFilePatch(9, [5]), { fullContext: true })[0];

    // A one-line fold would take as much room as the line itself.
    expect(file?.hunks.map((hunk) => hunk.type)).toEqual(["hunk"]);
    // Nothing is folded, so there is nothing to expand.
    expect(file === undefined ? true : isExpandable(file)).toBe(false);
});

test("counts added and removed lines, reading a removed `---` line as content", () => {
    const counts = countPatchLines(`--- a/notes.md
+++ b/notes.md
@@ -1,4 +1,4 @@
 # Notes
---- old rule
+=== new rule
+one more
 end
-gone
`);

    // The `---- old rule` line sits inside the hunk, so it is a removal and not a file
    // header, which a plain prefix check would get wrong.
    expect(counts).toEqual({ added: 2, removed: 2 });
});
