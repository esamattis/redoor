import * as React from "react";
import { Link } from "@tanstack/react-router";
import { File, Folder, FolderSearch } from "lucide-react";

import type { ContentGrepMatch } from "#bindings/ContentGrepMatch";
import type { FileSearchEntry } from "#bindings/FileSearchEntry";
import { type Agent } from "#ui/api-client";
import { browserRoute } from "#ui/browser-route";
import {
    OpenInBackgroundButton,
    useBackgroundOpen,
} from "#ui/components/browser/open-file-actions";
import { IconButton } from "#ui/components/icon-button";
import { cn } from "#ui/utils/cn";
import { getBaseName, getParentPath } from "#ui/utils/path";

/** Names where a search result leads, with the line a content match should reveal. */
export type SearchResultTarget = { path: string; line?: number };

/**
 * One result row: the link fills it and the row's action, opening a file in the background or
 * searching in a folder, stays at its right edge, also while a wide preview scrolls sideways.
 * The button sits beside the link, never inside it, and arrow-key focus only walks the links.
 */
function SearchResultRow(props: {
    agent: Agent;
    target: SearchResultTarget;
    /** Directories have nothing to open in the editor. */
    canOpenInBackground: boolean;
    /** Narrows the search to a directory result, offered in place of opening in the background. */
    onSearchInFolder?: () => void;
    children: React.ReactNode;
}) {
    const background = useBackgroundOpen(
        props.canOpenInBackground
            ? {
                  agentId: props.agent.id,
                  agentName: props.agent.name,
                  path: props.target.path,
                  name: getBaseName(props.target.path),
              }
            : null,
    );

    return (
        <div className="flex items-start border-b border-slate-800 last:border-b-0">
            {props.children}
            {background === null ? null : (
                <div className="sticky right-0 shrink-0 self-stretch bg-surface px-2 py-2">
                    <OpenInBackgroundButton
                        target={background}
                        line={props.target.line}
                    />
                </div>
            )}
            {props.onSearchInFolder === undefined ? null : (
                <div className="sticky right-0 shrink-0 self-stretch bg-surface px-2 py-2">
                    <IconButton
                        type="button"
                        variant="ghost"
                        size="xs"
                        label={`Search in ${props.target.path}`}
                        tooltip="Search in this folder instead"
                        onClick={props.onSearchInFolder}
                    >
                        <FolderSearch className="h-4 w-4" />
                    </IconButton>
                </div>
            )}
        </div>
    );
}

/** Leaves modified clicks on the real href so middle-click and new-tab still work. */
function handleSearchResultClick(
    event: React.MouseEvent<HTMLAnchorElement>,
    openSelectedResult: () => void,
) {
    if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
    ) {
        return;
    }

    event.preventDefault();
    openSelectedResult();
}

/** Presents one fuzzy path match with enough context to distinguish duplicate names. */
function PathResult(props: {
    result: FileSearchEntry;
    agent: Agent;
    target: SearchResultTarget;
    onOpen: (target: SearchResultTarget) => void;
    onSearchInFolder: () => void;
}) {
    const isDirectory = props.result.type === "directory";
    const ResultIcon = isDirectory ? Folder : File;

    return (
        <SearchResultRow
            agent={props.agent}
            target={props.target}
            canOpenInBackground={!isDirectory}
            onSearchInFolder={isDirectory ? props.onSearchInFolder : undefined}
        >
            <Link
                {...browserRoute(props.agent, props.target.path)}
                search={{ line: props.target.line }}
                className="flex min-w-0 flex-1 items-start gap-3 rounded-none px-3 py-2 text-left focus:bg-blue-500/10 focus:outline-none"
                aria-label={`Open path ${props.result.path}`}
                onClick={(event) =>
                    handleSearchResultClick(event, () =>
                        props.onOpen(props.target),
                    )
                }
            >
                <ResultIcon className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
                <span className="min-w-0">
                    <span className="block text-sm font-medium text-blue-300 sm:text-base">
                        {props.result.name}
                    </span>
                    <span className="block whitespace-nowrap font-mono text-[11px] font-normal text-slate-500 sm:text-xs">
                        {props.result.path}
                    </span>
                </span>
            </Link>
        </SearchResultRow>
    );
}

/** Presents a grep match with its line preview and exact navigation destination. */
function ContentResult(props: {
    result: ContentGrepMatch;
    agent: Agent;
    target: SearchResultTarget;
    onOpen: (target: SearchResultTarget) => void;
}) {
    return (
        <SearchResultRow
            agent={props.agent}
            target={props.target}
            canOpenInBackground
        >
            <Link
                {...browserRoute(props.agent, props.target.path)}
                search={{ line: props.target.line }}
                className="block min-w-0 flex-1 rounded-none px-3 py-2 text-left focus:bg-blue-500/10 focus:outline-none"
                aria-label={`Open ${props.result.path} at line ${props.result.line_number}`}
                onClick={(event) =>
                    handleSearchResultClick(event, () =>
                        props.onOpen(props.target),
                    )
                }
            >
                {/* The file name leads, so a narrow screen that cuts the row still shows it. */}
                <span className="flex items-baseline gap-2 whitespace-nowrap">
                    <span className="text-sm font-medium text-blue-300">
                        {getBaseName(props.result.path)}:
                        {props.result.line_number}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500 sm:text-xs">
                        {getParentPath(props.result.path)}
                    </span>
                </span>
                <span className="mt-1 block font-mono text-xs font-normal sm:text-sm">
                    {props.result.before_context.map((line) => (
                        <span
                            key={line.line_number}
                            className="grid grid-cols-[3rem_minmax(0,1fr)] text-slate-500"
                        >
                            <span className="pr-3 text-right select-none">
                                {line.line_number}
                            </span>
                            <span className="whitespace-pre">
                                {line.line}
                                {line.line_truncated ? "…" : ""}
                            </span>
                        </span>
                    ))}
                    <span className="grid grid-cols-[3rem_minmax(0,1fr)] bg-blue-500/10 text-slate-200">
                        <span className="pr-3 text-right text-blue-300 select-none">
                            {props.result.line_number}
                        </span>
                        <span className="whitespace-pre">
                            {props.result.line}
                            {props.result.line_truncated ? "…" : ""}
                        </span>
                    </span>
                    {props.result.after_context.map((line) => (
                        <span
                            key={line.line_number}
                            className="grid grid-cols-[3rem_minmax(0,1fr)] text-slate-500"
                        >
                            <span className="pr-3 text-right select-none">
                                {line.line_number}
                            </span>
                            <span className="whitespace-pre">
                                {line.line}
                                {line.line_truncated ? "…" : ""}
                            </span>
                        </span>
                    ))}
                </span>
            </Link>
        </SearchResultRow>
    );
}

/**
 * The results of the active search mode. Only the result links are anchors, so the dialog's
 * arrow-key focus can walk them through `resultsRef`.
 */
export function SearchResultList(props: {
    agent: Agent;
    resultsRef: React.RefObject<HTMLDivElement | null>;
    isContentSearch: boolean;
    pathResults: FileSearchEntry[] | undefined;
    contentResults: ContentGrepMatch[] | undefined;
    onOpen: (target: SearchResultTarget, index: number) => void;
    onSearchInFolder: (path: string) => void;
}) {
    const results = props.isContentSearch
        ? props.contentResults
        : props.pathResults;

    const hasResults = results !== undefined && results.length > 0;

    return (
        <div
            ref={props.resultsRef}
            aria-label="Search results"
            // Without results the list is empty, and a border would draw a stray line under the status.
            className={cn(
                "overflow-x-auto rounded-lg",
                hasResults && "border border-slate-800",
            )}
        >
            {/*
             * This shared width makes every row as wide as the widest preview line. Rows clamp their
             * sticky actions to their own right edge, so without it the actions would sit at
             * different places whenever the list scrolls sideways.
             */}
            <div className="flex w-max min-w-full flex-col">
                {props.isContentSearch
                    ? props.contentResults?.map((result, index) => (
                          <ContentResult
                              key={`${result.path}:${result.line_number}:${result.line}`}
                              result={result}
                              agent={props.agent}
                              target={{
                                  path: result.path,
                                  line: result.line_number,
                              }}
                              onOpen={(target) => props.onOpen(target, index)}
                          />
                      ))
                    : props.pathResults?.map((result, index) => (
                          <PathResult
                              key={result.path}
                              result={result}
                              agent={props.agent}
                              target={{ path: result.path }}
                              onOpen={(target) => props.onOpen(target, index)}
                              onSearchInFolder={() =>
                                  props.onSearchInFolder(result.path)
                              }
                          />
                      ))}
            </div>
        </div>
    );
}
