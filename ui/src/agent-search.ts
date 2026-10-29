import { z } from "zod";

/** Restricts grep timeout URLs to the same safe range accepted by recursive search. */
const searchTimeoutSchema = z.coerce
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .catch(undefined);

/** Restricts shared before/after grep context to the limit accepted by the agent. */
const searchContextSchema = z.coerce
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .catch(undefined);

/** Accepts booleans from both router navigation and directly entered query strings. */
export const optionalBooleanSchema = z
    .union([
        z.boolean(),
        z.literal("true").transform(() => true),
        z.literal("false").transform(() => false),
    ])
    .optional()
    .catch(undefined);

/** Keeps presence meaningful because an empty q still opens and focuses the dialog. */
const searchQuerySchema = z.string().optional().catch(undefined);

/** Treats a missing mode as path search while rejecting stale shared URL values. */
const searchModeSchema = z.literal("content").optional().catch(undefined);

/** Only absolute paths can scope a search, so a hand-edited relative one falls back to defaults. */
const searchDirectorySchema = z
    .string()
    .startsWith("/")
    .optional()
    .catch(undefined);

/** Rejects stale case values while keeping a missing value equivalent to smart case. */
const caseSensitivitySchema = z
    .enum(["smart", "sensitive", "insensitive"])
    .optional()
    .catch(undefined);

/**
 * The search workflow's URL state. It lives on the agent route so every child view shares one
 * dialog, and its keys are the contract that typed navigation and shared links rely on.
 * Every field falls back to undefined, so a stale or hand-edited URL degrades to defaults.
 */
export const agentSearchSchema = z.object({
    q: searchQuerySchema,
    mode: searchModeSchema,
    context: searchContextSchema,
    timeout: searchTimeoutSchema,
    hidden: optionalBooleanSchema,
    gitignore: optionalBooleanSchema,
    regex: optionalBooleanSchema,
    gitroot: optionalBooleanSchema,
    /** Path search lists only directories, for picking a folder to search in. */
    dirs: optionalBooleanSchema,
    /** A folder the reader chose to search in, overriding the browsed folder and the Git root. */
    dir: searchDirectorySchema,
    case: caseSensitivitySchema,
});

/** The validated search workflow state, derived so the schema stays the single definition. */
export type AgentSearch = z.output<typeof agentSearchSchema>;
