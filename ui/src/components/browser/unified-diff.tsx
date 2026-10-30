import React from "react";
import { createPortal } from "react-dom";
import { browserRoute } from "#ui/browser-route";
import { parseDiff, type DiffFile } from "#ui/utils/diff-parse";
import { Diff, diffFileName } from "#ui/components/browser/diff-view";
import { useBackgroundOpen } from "#ui/components/browser/open-file-actions";
import { getBaseName } from "#ui/utils/path";

/** Words for the file-level changes worth a badge; plain modifications need none. */
const FILE_TYPE_LABELS = {
    add: "Added",
    delete: "Deleted",
    modify: null,
    rename: "Renamed",
    copy: "Copied",
} satisfies Record<DiffFile["type"], string | null>;

/** Counts added and removed lines, a modified row counting as one of each, like `git diff --stat`. */
function changeCounts(file: DiffFile) {
    let added = 0;
    let removed = 0;

    for (const hunk of file.hunks) {
        if (hunk.type !== "hunk") {
            continue;
        }

        for (const line of hunk.lines) {
            if (line.kind === "insert" || line.kind === "modified") {
                added++;
            }

            if (line.kind === "delete" || line.kind === "modified") {
                removed++;
            }
        }
    }

    return { added, removed };
}

/**
 * Where a diff card shows the facts only the parsed patch knows: how many lines changed and,
 * for a card without a Git change badge, what happened to the file. The patch is parsed in
 * the card's body, which may fetch it on its own, so the body renders the facts into the
 * card's header through a portal instead of the card parsing the patch a second time.
 */
export type DiffSummarySlot = {
    element: HTMLElement;
    /** Whether the header has no change badge, so the summary names the change in words. */
    namesChange: boolean;
};

/** The header slot of the diff card around a patch, or null outside a card. */
export const DiffSummarySlotContext =
    React.createContext<DiffSummarySlot | null>(null);

/**
 * The added and removed line counts of a patch, and the kind of change of a lone file when the
 * card does not already show it as a badge.
 */
function DiffSummary(props: { files: DiffFile[]; namesChange: boolean }) {
    let added = 0;
    let removed = 0;

    for (const file of props.files) {
        const counts = changeCounts(file);
        added += counts.added;
        removed += counts.removed;
    }

    const lone = props.files.length === 1 ? props.files[0] : undefined;

    // A badge already names the change, and a patch of several files has no one kind.
    const typeLabel =
        !props.namesChange || lone === undefined
            ? null
            : lone.isBinary
              ? "Binary"
              : FILE_TYPE_LABELS[lone.type];

    return (
        <>
            {typeLabel === null ? null : (
                <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">
                    {typeLabel}
                </span>
            )}
            {added + removed === 0 ? null : (
                <span className="font-mono text-xs tabular-nums">
                    <span className="text-emerald-400">+{added}</span>{" "}
                    <span className="text-red-400">−{removed}</span>
                </span>
            )}
        </>
    );
}

/** Explains a file without rows, so it never reads as an empty or broken diff. */
function emptyFileMessage(file: DiffFile): string {
    if (file.isBinary) {
        return "Binary file not shown.";
    }

    if (file.type === "rename" || file.type === "copy") {
        return "The content did not change.";
    }

    return "No content changes.";
}

/**
 * Turns trusted server-generated unified diff text into the shared accessible table. It is
 * the body of a diff card, which names the file and holds the layout, wrap and whole-file
 * switches, so it renders only the rows and hands the change counts to the card's header.
 */
export function UnifiedDiff(props: {
    unifiedDiff: string;
    emptyMessage?: string;
    /**
     * The current file, so the trailing Open links can jump to it with ?line=, or open it
     * without leaving the diff. The device's current name is what the browser URL holds; its
     * id is what the open files list keys the file by.
     */
    editorFile?: { device: { id: string; name: string }; path: string };
    /** Whether a similar removed and added line show as one row with inline changes. */
    mergeModifiedLines: boolean;
    /** Whether long lines wrap inside the view instead of scrolling it sideways. */
    wrapLines: boolean;
    /**
     * Whether the patch carries every unchanged line, as the server says, so the view folds
     * them itself and can reveal them without fetching.
     */
    fullContext: boolean;
    /** Shows every file whole, as chosen in the card's header. */
    wholeFile: boolean;
}) {
    const mergeModifiedLines = props.mergeModifiedLines;
    const fullContext = props.fullContext;
    const summarySlot = React.useContext(DiffSummarySlotContext);

    const editorDeviceId = props.editorFile?.device.id;
    const editorDeviceName = props.editorFile?.device.name;
    const editorPath = props.editorFile?.path;

    // Parsing pairs similar lines with word diffs, which is too slow to redo every render.
    const files = React.useMemo(
        () => parseDiff(props.unifiedDiff, { mergeModifiedLines, fullContext }),
        [props.unifiedDiff, mergeModifiedLines, fullContext],
    );

    // A stable route and file keep the memoized rows from re-rendering when the parent does.
    const editorRoute = React.useMemo(
        () =>
            editorDeviceId === undefined ||
            editorDeviceName === undefined ||
            editorPath === undefined
                ? null
                : browserRoute(
                      { id: editorDeviceId, name: editorDeviceName },
                      editorPath,
                  ),
        [editorDeviceId, editorDeviceName, editorPath],
    );

    const backgroundFile = React.useMemo(
        () =>
            editorDeviceId === undefined ||
            editorDeviceName === undefined ||
            editorPath === undefined
                ? null
                : {
                      agentId: editorDeviceId,
                      agentName: editorDeviceName,
                      path: editorPath,
                      name: getBaseName(editorPath),
                  },
        [editorDeviceId, editorDeviceName, editorPath],
    );

    const background = useBackgroundOpen(backgroundFile);

    if (props.unifiedDiff === "") {
        return (
            <p className="text-sm text-slate-400">
                {props.emptyMessage ?? "The files are identical."}
            </p>
        );
    }

    if (files.length === 0) {
        // Text the reader does not recognise as a patch is still worth showing as is.
        return (
            <pre className="whitespace-pre p-3 font-mono text-xs text-slate-200">
                {props.unifiedDiff}
            </pre>
        );
    }

    return (
        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)]">
            {summarySlot === null
                ? null
                : createPortal(
                      <DiffSummary
                          files={files}
                          namesChange={summarySlot.namesChange}
                      />,
                      summarySlot.element,
                  )}
            {files.map((file, index) => {
                const name = diffFileName(file);
                const hasRows = file.hunks.some((hunk) => hunk.type === "hunk");

                return (
                    <div key={index} className="min-w-0">
                        {hasRows ? (
                            <Diff
                                file={file}
                                diffIndex={index}
                                label={
                                    name === ""
                                        ? "Changes"
                                        : `Changes in ${name}`
                                }
                                editorRoute={editorRoute}
                                background={background}
                                wrapLines={props.wrapLines}
                                wholeFile={props.wholeFile}
                            />
                        ) : (
                            <p className="px-3 py-2 text-sm text-slate-400">
                                {emptyFileMessage(file)}
                            </p>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
