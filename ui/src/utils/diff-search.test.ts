import { expect, test } from "vitest";
import { parseDiff } from "#ui/utils/diff-parse";
import {
    diffLineText,
    findDiffMatches,
    MAX_DIFF_SEARCH_MATCHES,
} from "#ui/utils/diff-search";

/** A whole-file patch of 20 numbered lines with line 10 edited, so it folds around the edit. */
function wholeFilePatch() {
    const lines = Array.from({ length: 20 }, (_, index) => index + 1);

    const body = lines
        .map((number) =>
            number === 10 ? "-line 10\n+edited 10" : ` line ${String(number)}`,
        )
        .join("\n");

    return `--- a/notes.txt
+++ b/notes.txt
@@ -1,20 +1,20 @@
${body}
`;
}

test("never searches the folded lines between hunks", () => {
    const diffFiles = parseDiff(wholeFilePatch(), { fullContext: true });

    const result = findDiffMatches([{ path: "/notes.txt", diffFiles }], "line");

    // Lines 2 and 20 sit in the folds around the edit. Folds are unchanged context, so only
    // the rows of the changed hunk may match, even though the patch carries every line.
    expect(
        result.matches.every(
            (match) => diffFiles[0]?.hunks[match.hunkIndex]?.type === "hunk",
        ),
    ).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
});

test("matches case-insensitively and reports offsets in the row's text", () => {
    const diffFiles = parseDiff(`--- a/app.ts
+++ b/app.ts
@@ -1,2 +1,2 @@
 const Value = 1;
 let value = Value;
`);

    const result = findDiffMatches([{ path: "/app.ts", diffFiles }], "VALUE");

    // Every spelling is found, at the offsets in each row the highlight ranges are built from.
    expect(
        result.matches.map((match) => [
            match.lineIndex,
            match.start,
            match.end,
        ]),
    ).toEqual([
        [0, 6, 11],
        [1, 4, 9],
        [1, 12, 17],
    ]);
});

test("searches a modified row as the text it shows", () => {
    const diffFiles = parseDiff(`--- a/app.ts
+++ b/app.ts
@@ -1,1 +1,1 @@
-const Value = 1;
+const value = 2;
`);

    const line = diffFiles[0]?.hunks[0]?.lines?.[0];

    const result = findDiffMatches([{ path: "/app.ts", diffFiles }], "Vvalue");

    // The row shows the removed and added characters side by side, so the search finds
    // what the reader sees, not the text of either side alone.
    expect(line === undefined ? null : diffLineText(line)).toBe(
        "const Vvalue = 12;",
    );
    expect(result.matches.map((match) => [match.start, match.end])).toEqual([
        [6, 12],
    ]);
});

test("treats the query as literal text", () => {
    const diffFiles = parseDiff(`--- a/app.ts
+++ b/app.ts
@@ -1,2 +1,2 @@
-call(a);
+call(b);
 cxll(c);
`);

    const result = findDiffMatches([{ path: "/app.ts", diffFiles }], "c.ll(");

    // Code is full of regex characters, so a dot must not match any character.
    expect(result.matches).toEqual([]);
});

test("stops at the match limit and says so", () => {
    const line = "a".repeat(MAX_DIFF_SEARCH_MATCHES + 5);

    const diffFiles = parseDiff(`--- a/big.txt
+++ b/big.txt
@@ -1,1 +1,1 @@
-${line}
+${line}b
`);

    const result = findDiffMatches([{ path: "/big.txt", diffFiles }], "a");

    // Collecting unbounded matches would build an unbounded number of highlight ranges.
    expect(result.matches).toHaveLength(MAX_DIFF_SEARCH_MATCHES);
    expect(result.truncated).toBe(true);
});
