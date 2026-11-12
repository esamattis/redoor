import { expect, test } from "vitest";
import {
    WORKTREE_REVISION,
    commitDiffRevision,
    commitsOnlyRevision,
    displayRevision,
    isWorktreeRange,
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

test("keeps the working tree side of a range unpinned and readable", () => {
    // The working tree has no commit, so pinning it to HEAD would cache a stale diff and
    // drop the uncommitted changes the range exists for.
    expect(commitDiffRevision(`main...${WORKTREE_REVISION}`, commitId)).toBe(
        `main...${WORKTREE_REVISION}`,
    );
    expect(isWorktreeRange(`main...${WORKTREE_REVISION}`)).toBe(true);
    expect(isWorktreeRange("main...HEAD")).toBe(false);
    // "Commits only" swaps the working tree for HEAD and keeps the separator.
    expect(
        commitsOnlyRevision(`refs/remotes/origin/main...${WORKTREE_REVISION}`),
    ).toBe("refs/remotes/origin/main...HEAD");
    // Banners name the working tree in words rather than the pseudo revision.
    expect(
        displayRevision(`refs/remotes/origin/main...${WORKTREE_REVISION}`),
    ).toBe("origin/main...working tree");
});
