import { z } from "zod";

import { optionalBooleanSchema } from "#ui/agent-search";

/** Accepts only 1-based whole line numbers so garbage query values cannot drive the editor. */
export const browserLineSchema = z
    .union([
        z.number().int().gte(1),
        z
            .string()
            .regex(/^[1-9][0-9]*$/)
            .transform(Number)
            .pipe(z.number().int().gte(1)),
    ])
    .optional()
    .catch(undefined);

/** The alternate representations a path can show besides its default listing or content. */
const browserViewSchema = z
    .enum(["details", "sync", "git", "systemd"])
    .optional()
    .catch(undefined);

/**
 * Names the systemd unit the Systemd view shows when the file does not define just one: an
 * instance such as `getty@tty1.service` of the open template file. Only the characters of
 * unit names pass, so a hand-edited URL cannot smuggle anything else into a request.
 */
const systemdUnitSchema = z
    .string()
    .regex(/^[A-Za-z0-9:_.@\\-]{1,256}$/)
    .optional()
    .catch(undefined);

/**
 * Picks the manager in the Systemd view of a file that more than one manager loads, as
 * `system` or `user/<name>`. The first manager is the default and stays out of the URL.
 */
const systemdScopeSchema = z
    .string()
    .regex(/^(system|user\/[^/]{1,256})$/)
    .optional()
    .catch(undefined);

/**
 * Names the Git comparison a file shows. Full is the default and stays out of the URL, so only
 * the staged comparison is a shareable state worth a parameter.
 */
const gitDiffModeSchema = z
    .enum(["full", "staged"])
    .optional()
    .catch(undefined);

/**
 * Names the Git revision being browsed: a branch, tag or commit id. While it is set the
 * browser shows the committed tree instead of the worktree, read-only. Revisions are opaque
 * to the UI, so only empty and absurdly long values are refused here; the server validates.
 * The router parses JSON-looking query values, so an all-digit commit id arrives as a number
 * and is turned back into text.
 */
const gitRevisionSchema = z
    .union([z.string(), z.number().transform(String)])
    .pipe(z.string().trim().min(1).max(256))
    .optional()
    .catch(undefined);

/**
 * Names the list the Git view shows instead of its changes: the history of the path, or the
 * repository's branches, tags or worktrees. The changes are the default and stay out of the
 * URL. `upstream` is the comparison with the default remote branch when there is none to
 * open, which shows why instead; when there is one, that tab opens it as a revision range.
 */
const gitTabSchema = z
    .enum(["commits", "upstream", "branches", "tags", "worktrees"])
    .optional()
    .catch(undefined);

/**
 * Orders the branch and tag lists. Most recently committed first is the default and stays
 * out of the URL, so only the name order is spelled out.
 */
const gitRefSortSchema = z.enum(["recent", "name"]).optional().catch(undefined);

/**
 * Narrows the branch list to local or remote-tracking branches. Local is the default and
 * stays out of the URL, because those are the branches people work on.
 */
const gitBranchScopeSchema = z
    .enum(["local", "remote"])
    .optional()
    .catch(undefined);

/** The columns a directory listing can be ordered by; `git` is the Git status column. */
const fileSortColumnSchema = z
    .enum(["type", "git", "name", "size", "modified", "owner", "group"])
    .optional()
    .catch(undefined);

/** Ascending is the default direction, so only a descending order is spelled out in the URL. */
const fileSortDirectionSchema = z
    .enum(["ascending", "descending"])
    .optional()
    .catch(undefined);

/**
 * The file browser's own URL state: which representation of the path is open, an editor
 * line to reveal, the rendered preview of Markdown, HTML or SVG, the full-window editor, the
 * Git comparison, the browsed Git revision, the Git view's list, the order of its branch and
 * tag lists, whether the branch list shows local or remote-tracking branches, the listing
 * order, and the unit and manager of the Systemd view. Keeping these in the URL makes each of them survive a reload, work with Back, and be
 * shareable. Every field falls back to undefined, so a stale or hand-edited URL degrades to
 * the defaults.
 */
export const browserSearchSchema = z.object({
    view: browserViewSchema,
    line: browserLineSchema,
    preview: optionalBooleanSchema,
    fullWindow: optionalBooleanSchema,
    diffMode: gitDiffModeSchema,
    rev: gitRevisionSchema,
    gitTab: gitTabSchema,
    refSort: gitRefSortSchema,
    branchScope: gitBranchScopeSchema,
    sort: fileSortColumnSchema,
    order: fileSortDirectionSchema,
    unit: systemdUnitSchema,
    systemdScope: systemdScopeSchema,
});

/** The validated browser search state, derived so the schema stays the single definition. */
export type BrowserSearch = z.output<typeof browserSearchSchema>;

/** Names a list the Git view can show besides the changes. */
export type GitTab = NonNullable<BrowserSearch["gitTab"]>;

/** Names a sortable listing column. */
export type FileSortColumn = NonNullable<BrowserSearch["sort"]>;

/** Names the direction of a listing sort. */
export type FileSortDirection = NonNullable<BrowserSearch["order"]>;
