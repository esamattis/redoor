import { expect, test } from "vitest";
import {
    commitDiffRevision,
    displayRevision,
    revisionRange,
} from "./git-parts";

const commitId = "0123456789abcdef0123456789abcdef01234567";

test("splits plain and symmetric ranges at the first two dots", () => {
    // A single revision is not a range.
    expect(revisionRange("main")).toBeNull();
    // A plain range keeps both sides as typed.
    expect(revisionRange("main..HEAD")).toEqual({
        base: "main",
        head: "HEAD",
        separator: "..",
    });
    // The third dot belongs to the separator, not to the right side, or the agent would be
    // asked for a revision named ".HEAD".
    expect(revisionRange("refs/heads/main...HEAD")).toEqual({
        base: "refs/heads/main",
        head: "HEAD",
        separator: "...",
    });
});

test("keeps the separator when pinning and displaying a range", () => {
    // A symmetric diff must stay symmetric when pinned to the resolved commit, or the cached
    // diff would compare with main's tip instead of the merge base.
    expect(commitDiffRevision("main...HEAD", commitId)).toBe(
        `main...${commitId}`,
    );
    expect(commitDiffRevision("main..HEAD", commitId)).toBe(
        `main..${commitId}`,
    );
    // The banner drops the ref namespace on both sides and keeps the dots.
    expect(displayRevision("refs/heads/main...HEAD")).toBe("main...HEAD");
});
