import { useMatch } from "@tanstack/react-router";

import { AgentUnavailableError } from "#ui/agent-unavailable";
import { isLsDirectoryResponse } from "#ui/ls-response";

/**
 * What the shell needs to know about the filesystem location on screen. The browser route's
 * loader data is the only place that knows whether a path is a file, a directory or
 * unavailable, so this type is the one boundary where other components depend on that shape.
 */
export type BrowserLocation = {
    agentId: string;
    /** The path requested by the URL, which may be an alias of the resolved path. */
    path: string;
    /** What the path resolved to, or null for a missing path or an agent that is not connected. */
    entry: "directory" | "file" | null;
    /** The canonical path reported by the listing, or null when the path did not resolve. */
    resolvedPath: string | null;
    /** False while the route waits for its agent to connect, so no repository discovery ran. */
    isConnected: boolean;
    /**
     * The browsed Git revision and what the path is at it, or null for the worktree. It is
     * kept apart from `entry`, which describes the disk, so worktree consumers such as
     * terminals and search never treat a committed path as existing. `entry` here is null
     * when the path did not resolve at the revision.
     */
    revision: { rev: string; entry: "directory" | "file" | null } | null;
};

/**
 * Selects the browser route's location in one place instead of every consumer digging through
 * `useMatches`. Returns null outside the file browser, so callers fall back to the agent's own
 * cwd. The selection is structurally shared, so subscribers only rerender when it changes.
 */
export function useBrowserLocation(): BrowserLocation | null {
    const location = useMatch({
        from: "/_app/agents/$deviceName/browser/$",
        shouldThrow: false,
        select: (match): BrowserLocation | null => {
            if (match.error instanceof AgentUnavailableError) {
                return {
                    agentId: match.error.agentId,
                    path: match.error.path,
                    entry: null,
                    resolvedPath: null,
                    isConnected: false,
                    revision: null,
                };
            }

            const data = match.loaderData;

            if (!data) {
                return null;
            }

            // A Git revision is not on disk, so worktree consumers such as terminals and
            // search must not treat its path as an existing file or directory.
            if (data.kind === "revision") {
                return {
                    agentId: data.agentId,
                    path: data.path,
                    entry: null,
                    resolvedPath: null,
                    isConnected: true,
                    revision: { rev: data.rev, entry: revisionEntry(data) },
                };
            }

            const lsResult = data.lsResult;

            return {
                agentId: data.agentId,
                path: data.path,
                entry: lsResult
                    ? isLsDirectoryResponse(lsResult)
                        ? "directory"
                        : "file"
                    : null,
                resolvedPath: lsResult?.path ?? null,
                isConnected: true,
                revision: null,
            };
        },
    });

    return location ?? null;
}

/** Names what a revision page shows: a committed tree or file, or a path the commit deleted. */
function revisionEntry(data: {
    tree: { entry: { type: string } } | null;
    deletion: { files: { path: string }[] } | null;
    path: string;
}): "directory" | "file" | null {
    if (data.tree !== null) {
        return data.tree.entry.type === "directory" ? "directory" : "file";
    }

    if (data.deletion !== null) {
        return data.deletion.files.length === 1 &&
            data.deletion.files[0]?.path === data.path
            ? "file"
            : "directory";
    }

    return null;
}
