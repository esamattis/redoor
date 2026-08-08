import { CalendarClock, GitCommitHorizontal, Hammer, Tag } from "lucide-react";

import type { BinaryIdentity, ServerBuildMode } from "../api-client";
import { Tooltip } from "./tooltip";

/** Human-readable cargo profile name. */
export function buildModeLabel(buildMode: ServerBuildMode): string {
    switch (buildMode) {
        case "debug":
            return "debug";
        case "release":
            return "release";
        case "unknown":
            return "unknown";
    }
}

/** GitHub commit URL when the baked revision looks like a real SHA. */
export function gitCommitUrl(gitRev: string): string | null {
    if (!/^[0-9a-f]{7,40}$/i.test(gitRev)) {
        return null;
    }
    return `https://github.com/esamattis/redoor/commit/${gitRev}`;
}

/** Amber badge with a tooltip explaining version-tag or working-tree dirty state. */
export function DirtyBadge(props: {
    /** Explains which dirty check failed. */
    explanation: string;
}) {
    return (
        <Tooltip content={props.explanation}>
            <span
                aria-label={props.explanation}
                className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-sans font-medium text-amber-300"
            >
                dirty
            </span>
        </Tooltip>
    );
}

/** Optional green/red emphasis when comparing an agent value against the server. */
export type MatchTone = "match" | "mismatch" | "neutral";

/** Maps match tone to text color classes used in list and detail views. */
function matchToneClass(tone: MatchTone): string {
    switch (tone) {
        case "match":
            return "text-emerald-400";
        case "mismatch":
            return "text-red-400";
        case "neutral":
            return "text-slate-100";
    }
}

/** Package version with a dirty badge when HEAD was not tagged `v{version}`. */
export function VersionValue(props: {
    version: string;
    versionDirty: boolean;
    /** Defaults to neutral; list rows pass match/mismatch vs the server. */
    tone?: MatchTone;
    title?: string;
}) {
    const tone = props.tone ?? "neutral";
    return (
        <span className="inline-flex flex-wrap items-center gap-2 font-mono text-sm">
            <span className={matchToneClass(tone)} title={props.title}>
                {props.version}
            </span>
            {props.versionDirty ? (
                <DirtyBadge
                    explanation={`Version is dirty: git revision is not tagged with this package version (expected tag v${props.version}).`}
                />
            ) : null}
        </span>
    );
}

/** Short git revision (optionally linked) with a dirty badge for a dirty worktree. */
export function RevValue(props: {
    gitRev: string;
    gitDirty: boolean;
    /** Defaults to neutral; list rows pass match/mismatch vs the server. */
    tone?: MatchTone;
    title?: string;
    /** When false, never renders a commit hyperlink (compact table cells). */
    link?: boolean;
}) {
    const tone = props.tone ?? "neutral";
    const shortRev = props.gitRev.slice(0, 7);
    const commitUrl = props.link === false ? null : gitCommitUrl(props.gitRev);
    const valueClass = matchToneClass(tone);

    return (
        <span className="inline-flex flex-wrap items-center gap-2 font-mono text-sm">
            {commitUrl ? (
                <a
                    href={commitUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={props.title}
                    className={`${valueClass} hover:underline`}
                >
                    {shortRev}
                </a>
            ) : (
                <span className={valueClass} title={props.title}>
                    {shortRev}
                </span>
            )}
            {props.gitDirty ? (
                <DirtyBadge explanation="Revision is dirty: the git working tree had uncommitted or untracked changes at build time." />
            ) : null}
        </span>
    );
}

/** Renders one binary identity field row for server/agent home cards. */
export function BinaryIdentityFields(props: {
    binary: BinaryIdentity;
    /** Optional class applied to each field separator row. */
    rowClassName?: string;
}) {
    const rowClass =
        props.rowClassName ??
        "flex items-start gap-3 border-t border-slate-800 pt-4";

    return (
        <>
            <div className={rowClass}>
                <Tag className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                <div className="min-w-0">
                    <h2 className="text-sm font-medium text-slate-400">
                        Version
                    </h2>
                    <p className="mt-1">
                        <VersionValue
                            version={props.binary.version}
                            versionDirty={props.binary.version_dirty}
                        />
                    </p>
                </div>
            </div>
            <div className={rowClass}>
                <GitCommitHorizontal className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                <div className="min-w-0">
                    <h2 className="text-sm font-medium text-slate-400">
                        Git revision
                    </h2>
                    <p className="mt-1">
                        <RevValue
                            gitRev={props.binary.git_rev}
                            gitDirty={props.binary.git_dirty}
                        />
                    </p>
                </div>
            </div>
            <div className={rowClass}>
                <Hammer className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                <div className="min-w-0">
                    <h2 className="text-sm font-medium text-slate-400">
                        Build mode
                    </h2>
                    <p className="mt-1 font-mono text-sm text-slate-100">
                        {buildModeLabel(props.binary.build_mode)}
                    </p>
                </div>
            </div>
            <div className={rowClass}>
                <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                <div className="min-w-0">
                    <h2 className="text-sm font-medium text-slate-400">
                        Build date
                    </h2>
                    <p className="mt-1 font-mono text-sm text-slate-100">
                        {props.binary.build_date}
                    </p>
                </div>
            </div>
        </>
    );
}

/** Match tone for one scalar field compared against the server binary. */
export function fieldMatchTone(
    agentValue: string,
    serverValue: string,
): MatchTone {
    return agentValue === serverValue ? "match" : "mismatch";
}
