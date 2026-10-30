import { expect, test } from "vitest";
import type { LsEntry } from "#bindings/LsEntry";
import type { GitDirectoryEntriesResponse } from "#bindings/GitDirectoryEntriesResponse";
import { compareFileEntries, type FileSort } from "./utils";
import { gitColumnData, gitRankByName } from "./git-status-column";

/** A listing entry that only differs by name, so only the Git state can order it. */
function entry(name: string): LsEntry {
    return {
        name,
        type: "file",
        size: 1,
        owner: null,
        group: null,
        uid: 0,
        gid: 0,
        modified_at: 0,
    };
}

/** Sorts `names` the way the file list does for `sort` with the given Git answer. */
function sortedNames(
    names: string[],
    sort: FileSort,
    response: GitDirectoryEntriesResponse | undefined,
): string[] {
    const rank = gitRankByName(gitColumnData(response, false));

    return names
        .map(entry)
        .sort((left, right) =>
            compareFileEntries(left, right, { sort, gitRank: rank }),
        )
        .map((sorted) => sorted.name);
}

const ascending: FileSort = { column: "git", direction: "ascending" };

/** One entry in every state the column distinguishes. */
const response: GitDirectoryEntriesResponse = {
    status: "entries",
    entries: [
        { name: "ignored.log", state: { type: "ignored" } },
        { name: "new.txt", state: { type: "untracked" } },
        {
            name: "src",
            state: {
                type: "contains_changes",
                most_severe: "changed",
                changed: 1,
                untracked: 0,
                conflicted: 0,
                truncated: false,
            },
        },
        {
            name: "renamed.txt",
            state: {
                type: "changed",
                index_state: "renamed",
                worktree_state: "unmodified",
                conflicted: false,
                original_path: "/repo/old.txt",
            },
        },
        {
            name: "edited.txt",
            state: {
                type: "changed",
                index_state: "unmodified",
                worktree_state: "modified",
                conflicted: false,
                original_path: null,
            },
        },
        {
            name: "merge.txt",
            state: {
                type: "changed",
                index_state: "unmodified",
                worktree_state: "modified",
                conflicted: true,
                original_path: null,
            },
        },
    ],
};

const names = [
    "clean.txt",
    "edited.txt",
    "ignored.log",
    "merge.txt",
    "new.txt",
    "renamed.txt",
    "src",
];

test("the Git sort puts what needs attention first and ignored entries last", () => {
    // Conflicts lead, then the entries' own changes in name order, then directories holding
    // changes, new files, clean files, and ignored files at the end.
    expect(sortedNames(names, ascending, response)).toEqual([
        "merge.txt",
        "edited.txt",
        "renamed.txt",
        "src",
        "new.txt",
        "clean.txt",
        "ignored.log",
    ]);
    // The descending order is the exact reverse, like every other column.
    expect(
        sortedNames(
            names,
            { column: "git", direction: "descending" },
            response,
        ),
    ).toEqual(
        [
            "merge.txt",
            "edited.txt",
            "renamed.txt",
            "src",
            "new.txt",
            "clean.txt",
            "ignored.log",
        ].reverse(),
    );
});

test("the Git sort keeps the name order until the status is known", () => {
    // While loading, rows must not jump around before there is anything to sort by.
    expect(sortedNames(names, ascending, undefined)).toEqual(names);
    // A walk the agent stopped gives nothing to sort by either.
    expect(sortedNames(names, ascending, { status: "timed_out" })).toEqual(
        names,
    );
});
