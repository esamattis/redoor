import { expect, test } from "vitest";
import {
    GIT_GUTTER_EMPTY,
    GIT_GUTTER_HIDDEN,
    gitGutterSource,
    gitLineMarks,
    lineHunks,
    splitLines,
    type GitLineBases,
} from "./git-gutter";

/** Bases with nothing staged, as the agent sends for an unstaged edit. */
function unstagedBases(index: string): GitLineBases {
    return { index: splitLines(index), staged: [] };
}

/** Bases with HEAD and the index differing, prepared the way the editor prepares them. */
function stagedBases(head: string, index: string): GitLineBases {
    const source = gitGutterSource({
        status: "bases",
        index,
        head: { type: "text", content: head },
    });

    if (source.kind !== "bases") {
        throw new Error("expected bases");
    }

    return source.bases;
}

test("line hunks pair removed and added runs and skip the common head and tail", () => {
    // A replaced line is one hunk with both sides, which the gutter shows as modified.
    expect(lineHunks(["a", "b", "c"], ["a", "x", "c"])).toEqual([
        { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
    ]);
    // Separate edits stay separate hunks, so unchanged lines between them stay unmarked.
    expect(
        lineHunks(["a", "b", "c", "d", "e"], ["a", "B", "c", "d", "E", "f"]),
    ).toEqual([
        { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
        { oldStart: 4, oldCount: 1, newStart: 4, newCount: 2 },
    ]);
    // Equal lists have no hunks at all.
    expect(lineHunks(["a"], ["a"])).toEqual([]);
});

test("unstaged changes mark added, modified and deleted lines of the buffer", () => {
    const bases = unstagedBases("one\ntwo\nthree\nfour\n");

    const marks = gitLineMarks(
        splitLines("one\nTWO\nthree\nnew\nfour\n"),
        bases,
    );

    // A replaced line is modified and an inserted one added, both not staged yet.
    expect(marks).toEqual([
        { line: 1, change: "modified", staged: false },
        { line: 3, change: "added", staged: false },
    ]);

    // Deleted lines have no line of their own, so the following line carries the mark.
    expect(gitLineMarks(splitLines("one\nfour\n"), bases)).toEqual([
        { line: 1, change: "deleted_above", staged: false },
    ]);

    // Lines deleted after the last line mark the last line from below.
    expect(gitLineMarks(["one"], unstagedBases("one\ntwo"))).toEqual([
        { line: 0, change: "deleted_below", staged: false },
    ]);
});

test("an untracked file has every line added", () => {
    const source = gitGutterSource({
        status: "bases",
        index: null,
        head: { type: "same_as_index" },
    });

    if (source.kind !== "bases") {
        throw new Error("expected bases");
    }

    // Without an index entry nothing of the file is known to Git yet.
    expect(gitLineMarks(["a", "b"], source.bases)).toEqual([
        { line: 0, change: "added", staged: false },
        { line: 1, change: "added", staged: false },
    ]);
});

test("staged changes are carried onto the buffer lines that still show them", () => {
    const bases = stagedBases("a\nb\nc\nd\n", "a\nB\nc\nd\nstaged\n");

    // With the buffer equal to the index, only the staged marks remain.
    expect(gitLineMarks(splitLines("a\nB\nc\nd\nstaged\n"), bases)).toEqual([
        { line: 1, change: "modified", staged: true },
        { line: 4, change: "added", staged: true },
    ]);

    // Lines inserted in the buffer above shift the staged marks down with their lines.
    expect(
        gitLineMarks(splitLines("top\na\nB\nc\nd\nstaged\n"), bases),
    ).toEqual([
        { line: 0, change: "added", staged: false },
        { line: 2, change: "modified", staged: true },
        { line: 5, change: "added", staged: true },
    ]);

    // A staged line edited again shows its unstaged change, which needs attention first.
    expect(gitLineMarks(splitLines("a\nBB\nc\nd\nstaged\n"), bases)).toEqual([
        { line: 1, change: "modified", staged: false },
        { line: 4, change: "added", staged: true },
    ]);
});

test("a staged deletion marks the line after it", () => {
    const bases = stagedBases("a\nb\nc\n", "a\nc\n");

    // The removal of "b" is staged, so "c" carries a staged deletion mark.
    expect(gitLineMarks(splitLines("a\nc\n"), bases)).toEqual([
        { line: 1, change: "deleted_above", staged: true },
    ]);
});

test("answers without comparable text hide the gutter or leave it empty", () => {
    // Outside a repository or for ignored files there is no gutter at all.
    expect(gitGutterSource({ status: "outside_worktree" })).toBe(
        GIT_GUTTER_HIDDEN,
    );
    expect(gitGutterSource({ status: "ignored" })).toBe(GIT_GUTTER_HIDDEN);
    // A repository file that cannot be compared keeps its gutter, so the text never shifts.
    expect(gitGutterSource({ status: "conflicted" })).toBe(GIT_GUTTER_EMPTY);
    expect(gitGutterSource({ status: "too_large" })).toBe(GIT_GUTTER_EMPTY);
});
