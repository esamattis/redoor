import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftRight } from "lucide-react";
import type { Agent } from "#ui/api-client";
import { browserRoute } from "#ui/browser-route";
import { IconLinkButton } from "#ui/components/icon-button";
import { Select } from "#ui/components/select";
import {
    displayRevision,
    revisionRange,
} from "#ui/components/browser/git-parts";
import { gitRefsQueryOptions } from "#ui/queries";
import { cn } from "#ui/utils/cn";
import type { GitRef } from "#bindings/GitRef";

/** The checkout's own revision, kept symbolic so a comparison follows new commits. */
const HEAD = "HEAD";

/** The choices one side of a comparison offers, grouped the way `git branch -a` lists them. */
type CompareOptions = {
    local: Array<{ value: string; label: string }>;
    remote: Array<{ value: string; label: string }>;
    /** Revisions on screen that the branch page does not hold, such as a tag or a commit id. */
    other: Array<{ value: string; label: string }>;
};

/**
 * Picks both sides of a symmetric comparison `base...compare` and swaps them, so a branch can
 * be reviewed against any other one without typing a range into the URL. Native selects are
 * used because phones open them as their own full-screen pickers, which beats any dropdown
 * squeezed into a narrow column. In a narrow column the two selects stack beside one swap
 * button instead of sitting in one row, so neither branch name is cut to a few letters.
 */
export function GitComparePicker(props: {
    agent: Agent;
    path: string;
    /** The repository the comparison was resolved in, whose branches are offered. */
    repositoryRoot: string;
    /** The symmetric range as browsed, with refs as typed so the selects show names. */
    rev: string;
}) {
    const navigate = useNavigate();
    const sides = revisionRange(props.rev);
    // An empty side means HEAD, as in Git, so the select shows it as the checkout.
    const base = sides?.base || HEAD;
    const compare = sides?.head || HEAD;

    // The first page holds the 100 most recently committed branches, which covers the ones
    // anyone compares; an older branch is still reachable from the branch list's own button.
    const refsQuery = useInfiniteQuery(
        gitRefsQueryOptions(props.agent, props.repositoryRoot, {
            kind: "branches",
            // Both scopes, so a remote-tracking branch such as origin/main can be a side.
            scope: "all",
            sort: "recent",
        }),
    );

    const refs = refsQuery.data?.pages.flatMap((page) => page.refs) ?? [];
    const options = compareOptions(refs, [base, compare]);
    const headBranch = refs.find((ref) => ref.is_head);

    const headLabel =
        headBranch === undefined
            ? "HEAD (checkout)"
            : `HEAD (${headBranch.name})`;

    /** Opens the comparison of two picked sides, as a new history entry so Back undoes it. */
    function open(nextBase: string, nextCompare: string) {
        void navigate({
            ...browserRoute(props.agent, props.path),
            search: (previous) => ({
                ...previous,
                view: "git",
                rev: `${nextBase}...${nextCompare}`,
            }),
        });
    }

    return (
        <div
            role="group"
            aria-label="Compared branches"
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 @xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
        >
            <CompareSide
                label="Base"
                value={base}
                headLabel={headLabel}
                options={options}
                onChange={(value) => open(value, compare)}
                className="col-start-1 row-start-1"
            />
            {/* The tooltip wraps the link, so this box is what the grid places: beside both
                stacked selects in a narrow column, between them in a wide one. */}
            <div className="col-start-2 row-start-1 row-end-3 flex items-center @xl:row-end-2">
                <IconLinkButton
                    {...browserRoute(props.agent, props.path)}
                    search={(previous) => ({
                        ...previous,
                        view: "git",
                        rev: `${compare}...${base}`,
                    })}
                    label="Swap compared branches"
                    tooltip={`Show what ${displayRevision(base)} adds to ${displayRevision(compare)} instead`}
                    variant="outline"
                    size="xl"
                >
                    {/* Up and down when the sides are stacked, left and right when in a row. */}
                    <ArrowLeftRight
                        className="h-4 w-4 @max-xl:rotate-90"
                        aria-hidden="true"
                    />
                </IconLinkButton>
            </div>
            <CompareSide
                label="Compare"
                value={compare}
                headLabel={headLabel}
                options={options}
                onChange={(value) => open(base, value)}
                className="col-start-1 row-start-2 @xl:col-start-3 @xl:row-start-1"
            />
        </div>
    );
}

/** One side of the comparison: a labelled select of the checkout and the branches. */
function CompareSide(props: {
    label: string;
    value: string;
    headLabel: string;
    options: CompareOptions;
    onChange: (value: string) => void;
    className: string;
}) {
    return (
        <label
            className={cn("flex min-w-0 items-center gap-2", props.className)}
        >
            {/* A fixed width lines both stacked selects up in a narrow column. */}
            <span className="w-16 shrink-0 text-xs font-medium text-slate-400 @xl:w-auto">
                {props.label}
            </span>
            <Select
                value={props.value}
                onChange={(event) => props.onChange(event.target.value)}
                containerClassName="min-w-0 flex-1"
                className="font-mono text-sm"
            >
                <option value={HEAD}>{props.headLabel}</option>
                <OptionGroup label="Local" options={props.options.local} />
                <OptionGroup label="Remote" options={props.options.remote} />
                <OptionGroup label="Other" options={props.options.other} />
            </Select>
        </label>
    );
}

/** A named group of options, left out when empty so the picker lists no bare headings. */
function OptionGroup(props: {
    label: string;
    options: CompareOptions["other"];
}) {
    if (props.options.length === 0) {
        return null;
    }

    return (
        <optgroup label={props.label}>
            {props.options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </optgroup>
    );
}

/**
 * Builds the choices from the listed branches by full ref name, which a tag and a branch
 * cannot share. Revisions already on screen that the list lacks are added, so a select
 * never silently shows a different branch than the URL compares.
 */
function compareOptions(refs: GitRef[], selected: string[]): CompareOptions {
    const options: CompareOptions = { local: [], remote: [], other: [] };
    const known = new Set([HEAD]);

    for (const ref of refs) {
        known.add(ref.full_name);

        // The branch list never holds tags; this only narrows the kind for the groups.
        if (ref.kind !== "tag") {
            options[ref.kind === "branch" ? "local" : "remote"].push({
                value: ref.full_name,
                label: ref.name,
            });
        }
    }

    for (const value of new Set(selected)) {
        if (!known.has(value)) {
            options.other.push({ value, label: displayRevision(value) });
        }
    }

    return options;
}
