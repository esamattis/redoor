import * as React from "react";
import {
    CaseLower,
    CaseSensitive,
    Eye,
    EyeOff,
    FileSearch,
    Folder,
    FolderGit2,
    GitBranch,
    Regex,
    Search,
    SlidersHorizontal,
    TextSearch,
} from "lucide-react";

import type { CaseSensitivity } from "#bindings/CaseSensitivity";
import type { AgentSearch } from "#ui/agent-search";
import { IconButton } from "#ui/components/icon-button";
import { InputControl } from "#ui/components/input-control";
import { ToggleButton } from "#ui/components/toggle-button";
import { cn } from "#ui/utils/cn";

/** Cycles smart → sensitive → insensitive so the control can name the next click. */
const nextCaseSensitivity = {
    smart: "sensitive",
    sensitive: "insensitive",
    insensitive: "smart",
} satisfies Record<CaseSensitivity, CaseSensitivity>;

/** Accessible name stays on the current mode so screen readers can hear the applied rule. */
const caseSensitivityLabel = {
    smart: "Case: smart",
    sensitive: "Case: sensitive",
    insensitive: "Case: insensitive",
} satisfies Record<CaseSensitivity, string>;

/** Tooltip copy names the mode the next click will select. */
const caseSensitivityNextTooltip = {
    smart: "Click to match exact letter case",
    sensitive: "Click to ignore letter case",
    insensitive: "Click to use smart case",
} satisfies Record<CaseSensitivity, string>;

/** Filter chips share one compact size so a row of them reads as a single toolbar. */
const filterChipClassName = "h-8 gap-1.5 px-2.5 py-0 text-xs sm:h-7";

/**
 * Options that change how the query text matches sit inside the field, where editors put them,
 * so they read as part of the query instead of another row of settings.
 */
const inlineOptionClassName =
    "h-8 w-8 rounded text-slate-400 sm:h-7 sm:w-7 hover:bg-tint hover:text-slate-100 aria-pressed:bg-blue-500/20 aria-pressed:text-blue-300";

/**
 * The search bar: the mode switch beside the query, with the matching options inside the
 * field. Keeping them on one line puts everything that changes what matches in one glance.
 */
export function SearchQueryBar(props: {
    query: string;
    isContentSearch: boolean;
    regex: boolean;
    caseSensitivity: CaseSensitivity;
    disabled: boolean;
    queryInputRef: React.RefObject<HTMLInputElement | null>;
    /** The filter panel the phone-only options button folds. */
    optionsId: string;
    showsOptions: boolean;
    onShowOptionsChange: (shows: boolean) => void;
    onModeChange: (checked: boolean) => void;
    onQueryChange: (query: string) => void;
    onUpdate: (changes: AgentSearch) => Promise<void>;
}) {
    const caseSensitivityIcon = {
        smart: <SmartCaseIcon className="h-4 w-4" />,
        sensitive: <CaseSensitive className="h-4 w-4" />,
        insensitive: <CaseLower className="h-4 w-4" />,
    } satisfies Record<CaseSensitivity, React.ReactNode>;

    return (
        <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex gap-2">
                <div
                    role="group"
                    aria-label="Search by"
                    className="grid h-10 min-w-0 flex-1 grid-cols-2 gap-0.5 rounded-md border border-slate-700 bg-slate-950/60 p-0.5"
                >
                    <ToggleButton
                        label="Search file paths"
                        tooltip="Find files and folders by name"
                        pressed={!props.isContentSearch}
                        size="sm"
                        variant="subtle"
                        className="h-full w-full gap-1.5 rounded px-3 py-1.5 aria-pressed:bg-slate-700 aria-pressed:text-slate-100"
                        onClick={() => props.onModeChange(false)}
                    >
                        <FileSearch className="h-4 w-4" aria-hidden="true" />
                        Paths
                    </ToggleButton>
                    <ToggleButton
                        label="Search file contents"
                        tooltip="Find text inside files"
                        pressed={props.isContentSearch}
                        size="sm"
                        variant="subtle"
                        className="h-full w-full gap-1.5 rounded px-3 py-1.5 aria-pressed:bg-slate-700 aria-pressed:text-slate-100"
                        onClick={() => props.onModeChange(true)}
                    >
                        <TextSearch className="h-4 w-4" aria-hidden="true" />
                        Contents
                    </ToggleButton>
                </div>
                <IconButton
                    label="Search options"
                    tooltip={
                        props.showsOptions
                            ? "Hide search options"
                            : "Show search options"
                    }
                    aria-expanded={props.showsOptions}
                    aria-controls={props.optionsId}
                    variant="outline"
                    // Wider screens always show the options, so only phones get the button.
                    tooltipClassName="sm:hidden"
                    className={cn(
                        "h-10 w-10",
                        props.showsOptions &&
                            "border-blue-500 bg-blue-500/15 text-blue-300",
                    )}
                    onClick={() =>
                        props.onShowOptionsChange(!props.showsOptions)
                    }
                >
                    <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                </IconButton>
            </div>

            <div className="relative flex min-w-0 flex-1 items-center">
                <Search
                    className="pointer-events-none absolute left-3 h-4 w-4 text-slate-500"
                    aria-hidden="true"
                />
                <InputControl
                    key={props.isContentSearch ? "content" : "path"}
                    ref={props.queryInputRef}
                    autoFocus
                    type="search"
                    aria-label={
                        props.isContentSearch
                            ? "Search file contents"
                            : "Search file paths"
                    }
                    value={props.query}
                    disabled={props.disabled}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                        props.onQueryChange(event.target.value)
                    }
                    placeholder={
                        props.isContentSearch
                            ? props.regex
                                ? "Regular expression"
                                : "Text inside files"
                            : "File or folder name"
                    }
                    className={cn(
                        // Phones get 16px text, since iOS zooms into smaller fields on focus.
                        "h-11 w-full pl-9 text-base placeholder:text-slate-600 sm:h-10 sm:text-sm",
                        props.isContentSearch
                            ? "pr-[4.75rem] sm:pr-16"
                            : "pr-11 sm:pr-10",
                    )}
                />
                <div className="absolute right-1.5 flex items-center gap-0.5">
                    <IconButton
                        label={caseSensitivityLabel[props.caseSensitivity]}
                        tooltip={
                            caseSensitivityNextTooltip[props.caseSensitivity]
                        }
                        // Smart case is the default, so only an explicit choice is highlighted.
                        className={cn(
                            inlineOptionClassName,
                            props.caseSensitivity !== "smart" &&
                                "bg-blue-500/20 text-blue-300",
                        )}
                        onClick={() =>
                            void props.onUpdate({
                                case: nextCaseSensitivity[
                                    props.caseSensitivity
                                ],
                            })
                        }
                    >
                        {caseSensitivityIcon[props.caseSensitivity]}
                    </IconButton>
                    {props.isContentSearch ? (
                        <ToggleButton
                            label="Use regular expressions"
                            pressed={props.regex}
                            tooltip={
                                props.regex
                                    ? "Search as literal text"
                                    : "Use regular expressions"
                            }
                            variant="subtle"
                            className={inlineOptionClassName}
                            onClick={() =>
                                void props.onUpdate({ regex: !props.regex })
                            }
                        >
                            <Regex className="h-4 w-4" />
                        </ToggleButton>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

/**
 * Which files the search walks, and how long and how much it shows. These change rarely, so
 * they are small labelled chips that say what they do without hovering for a tooltip.
 */
export function SearchFilters(props: {
    id: string;
    className?: string;
    isContentSearch: boolean;
    timeoutSeconds: number;
    includeHidden: boolean;
    respectGitignore: boolean;
    directoriesOnly: boolean;
    contextSize: number;
    onUpdate: (changes: AgentSearch) => Promise<void>;
    onUpdateOption: (
        changes: AgentSearch,
        preferences: Record<string, number | boolean>,
    ) => void;
}) {
    return (
        <div
            id={props.id}
            className={cn(
                "flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2",
                props.className,
            )}
        >
            <div className="flex flex-wrap items-center gap-1.5">
                <ToggleButton
                    label="Include hidden files and directories"
                    pressed={props.includeHidden}
                    tooltip={
                        props.includeHidden
                            ? "Exclude hidden files and directories"
                            : "Include hidden files and directories"
                    }
                    size="sm"
                    className={filterChipClassName}
                    onClick={() =>
                        props.onUpdateOption(
                            { hidden: !props.includeHidden },
                            {
                                recursiveSearchIncludeHidden:
                                    !props.includeHidden,
                            },
                        )
                    }
                >
                    {props.includeHidden ? (
                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                        <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    Hidden files
                </ToggleButton>
                <ToggleButton
                    label="Respect .gitignore files"
                    pressed={props.respectGitignore}
                    tooltip={
                        props.respectGitignore
                            ? "Include files ignored by .gitignore"
                            : "Respect .gitignore files"
                    }
                    size="sm"
                    className={filterChipClassName}
                    onClick={() =>
                        props.onUpdateOption(
                            { gitignore: !props.respectGitignore },
                            {
                                recursiveSearchRespectGitignore:
                                    !props.respectGitignore,
                            },
                        )
                    }
                >
                    <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                    .gitignore
                </ToggleButton>
                {props.isContentSearch ? null : (
                    <ToggleButton
                        label="Search directories only"
                        pressed={props.directoriesOnly}
                        tooltip={
                            props.directoriesOnly
                                ? "Search files and directories"
                                : "Search directories only"
                        }
                        size="sm"
                        className={filterChipClassName}
                        onClick={() =>
                            void props.onUpdate({
                                dirs: props.directoriesOnly ? undefined : true,
                            })
                        }
                    >
                        <Folder className="h-3.5 w-3.5" aria-hidden="true" />
                        Folders only
                    </ToggleButton>
                )}
            </div>
            <SearchNumberInputs
                isContentSearch={props.isContentSearch}
                timeoutSeconds={props.timeoutSeconds}
                contextSize={props.contextSize}
                onUpdate={props.onUpdate}
                onUpdateOption={props.onUpdateOption}
            />
        </div>
    );
}

/** Switches between the Git repository root and the browsed folder. */
export function GitRootToggle(props: {
    pressed: boolean;
    onUpdate: (changes: AgentSearch) => Promise<void>;
}) {
    return (
        <ToggleButton
            label="Search from git root"
            pressed={props.pressed}
            tooltip={
                props.pressed
                    ? "Search the current directory only"
                    : "Search the entire Git repository instead of the current directory"
            }
            size="sm"
            className={cn(filterChipClassName, "shrink-0")}
            // Leaves a chosen folder too, so the toggle always lands on the root or the browsed folder.
            onClick={() =>
                void props.onUpdate({
                    gitroot: !props.pressed,
                    dir: undefined,
                })
            }
        >
            <FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Git root</span>
        </ToggleButton>
    );
}

/**
 * Keeps bounded numeric controls inline with their units, so they sit in the filter row
 * instead of needing a labelled column of their own.
 */
function SearchNumberInputs(props: {
    isContentSearch: boolean;
    timeoutSeconds: number;
    contextSize: number;
    onUpdate: (changes: AgentSearch) => Promise<void>;
    onUpdateOption: (
        changes: AgentSearch,
        preferences: Record<string, number | boolean>,
    ) => void;
}) {
    return (
        <div className="flex items-center gap-4 sm:ml-auto">
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
                Timeout
                <InputControl
                    aria-label="Search timeout in seconds"
                    type="number"
                    min={1}
                    max={60}
                    value={props.timeoutSeconds}
                    onChange={(event) => {
                        const value = event.target.valueAsNumber;

                        if (Number.isInteger(value)) {
                            const timeout = Math.min(60, Math.max(1, value));
                            props.onUpdateOption(
                                { timeout },
                                { recursiveSearchTimeoutSeconds: timeout },
                            );
                        }
                    }}
                    className="h-8 w-14 px-2 py-0 text-base sm:h-7 sm:text-xs"
                />
                <span className="text-slate-500">s</span>
            </label>
            {props.isContentSearch ? (
                <label className="flex items-center gap-1.5 text-xs text-slate-400">
                    Context
                    <InputControl
                        aria-label="Context lines above and below"
                        type="number"
                        min={0}
                        max={20}
                        value={props.contextSize}
                        onChange={(event) => {
                            const value = event.target.valueAsNumber;

                            if (Number.isInteger(value)) {
                                void props.onUpdate({
                                    context: Math.min(20, Math.max(0, value)),
                                });
                            }
                        }}
                        className="h-8 w-14 px-2 py-0 text-base sm:h-7 sm:text-xs"
                    />
                    <span className="text-slate-500">lines</span>
                </label>
            ) : null}
        </div>
    );
}

/**
 * Lucide has Aa and aa glyphs, but nothing for smart case, so this keeps the
 * same letterforms and adds a sparkle to show automatic case matching.
 */
function SmartCaseIcon(props: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <path d="m2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16" />
            <path d="M3.304 13h6.392" />
            <path d="M22 11v5" />
            <circle cx="18.5" cy="13.5" r="3.5" />
            <path d="M19 3v4" />
            <path d="M17 5h4" />
        </svg>
    );
}
