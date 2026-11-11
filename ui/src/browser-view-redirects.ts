/**
 * Redirects of the file browser route that leave a view the path cannot show, apart from the
 * route file. Each replaces the history entry, so Back never returns to a view that only
 * redirects again.
 */
import { redirect } from "@tanstack/react-router";

import type { GitContextResponse } from "#bindings/GitContextResponse";
import type { MetadataResponse } from "#bindings/MetadataResponse";
import type { Agent } from "#ui/api-client";
import type { BrowserSearch } from "#ui/browser-search";
import { isLsFileResponse, type LsResponse } from "#ui/ls-response";
import { fetchQueryUncancelled, type QueryContext } from "#ui/queries";
import {
    isSystemdFileCandidate,
    systemdPathStatusQueryOptions,
    systemdScopeKeyUser,
} from "#ui/systemd-queries";
import { syntaxLanguageFromFileName } from "#ui/utils/editor-language";
import { opensInEditor } from "#ui/vault/vault-path";

/** The route's own parameters, which every redirect needs to stay on the same entry. */
type BrowserParams = { deviceName: string; _splat?: string };

/** Leaves the Git view of a path that is outside every repository, which has nothing to show. */
export function redirectOutsideWorktree(
    params: BrowserParams,
    view: BrowserSearch["view"],
    gitContext: GitContextResponse,
) {
    if (view === "git" && gitContext.status === "outside_worktree") {
        throw redirect({
            to: "/agents/$deviceName/browser/$",
            params,
            search: {},
            replace: true,
        });
    }
}

/** Content is the file default view. */
export function wantsFileContentView(view: BrowserSearch["view"]) {
    return view === undefined;
}

/** Replaces history so a content URL for a file without viewable content does not stay on the stack. */
export function replaceUnsupportedFileView(
    params: BrowserParams,
    view: BrowserSearch["view"],
    metadata: MetadataResponse | null,
) {
    const canShowContent =
        opensInEditor(metadata) || metadata?.viewable_image === true;

    if (wantsFileContentView(view) && !canShowContent) {
        throw redirect({
            to: "/agents/$deviceName/browser/$",
            params,
            search: { view: "details" },
            replace: true,
        });
    }
}

/**
 * Makes rendered markdown the canonical first view while line bookmarks stay in the editor.
 * It decides from the URL alone, so it runs before the loader and never needs the agent: an
 * offline tab already shows its final URL, and the reload on connection never redirects. A
 * redirect thrown from that reload would keep the same match, so the stale offline loader
 * data stayed on screen. A markdown file without editable content never reaches the editor,
 * so the flag is inert for it.
 */
export function replaceDefaultMarkdownPreview(options: {
    params: BrowserParams;
    search: BrowserSearch;
}) {
    const search = options.search;

    if (
        !wantsFileContentView(search.view) ||
        search.rev !== undefined ||
        search.line !== undefined ||
        search.preview !== undefined ||
        syntaxLanguageFromFileName(options.params._splat ?? "") !== "markdown"
    ) {
        return;
    }

    throw redirect({
        to: "/agents/$deviceName/browser/$",
        params: options.params,
        search: { ...search, preview: true },
        replace: true,
    });
}

/**
 * Leaves the Systemd view of a path no systemd manager loads, the way the Git view of a path
 * outside every repository is left: directories, files that are no unit file or drop-in,
 * devices without systemd, and unit files outside every manager's unit directories. A failed
 * question keeps the view, which explains the failure itself. The URL's user manager is asked
 * like the view asks it, so a shared file opened from a user's unit list is not left.
 */
export async function redirectUnusableSystemdView(options: {
    context: QueryContext;
    agent: Agent;
    params: BrowserParams;
    view: BrowserSearch["view"];
    systemdScope: BrowserSearch["systemdScope"];
    lsResult: LsResponse;
}) {
    if (options.view !== "systemd") {
        return;
    }

    const filePath = isLsFileResponse(options.lsResult)
        ? options.lsResult.path
        : null;

    let usable =
        filePath !== null && isSystemdFileCandidate(options.agent, filePath);

    if (usable && filePath !== null) {
        try {
            const status = await fetchQueryUncancelled(
                options.context.queryClient,
                systemdPathStatusQueryOptions(
                    options.agent,
                    filePath,
                    systemdScopeKeyUser(options.systemdScope),
                ),
            );

            usable = status.matches.length > 0;
        } catch {
            // The view shows why systemd could not be asked, with a retry.
        }
    }

    if (!usable) {
        throw redirect({
            to: "/agents/$deviceName/browser/$",
            params: options.params,
            search: {},
            replace: true,
        });
    }
}
