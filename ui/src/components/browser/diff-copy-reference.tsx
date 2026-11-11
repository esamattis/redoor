import React from "react";
import { useMutation } from "@tanstack/react-query";
import { ClipboardCopy, FolderGit2 } from "lucide-react";
import { IconButton } from "#ui/components/icon-button";
import { Toast } from "#ui/components/toast";
import type { GitDiffListFile } from "#ui/components/browser/git-diff-list";
import { DIFF_SEARCH_PATH_ATTRIBUTE } from "#ui/utils/diff-search-highlighter";
import { getErrorMessage } from "#ui/utils/error";
import { formatFileReference } from "#ui/utils/file-reference";

/** Which path form a reference names its file by, like the editor's two menu items. */
type ReferenceKind = "absolute" | "repository";

/** Names each failed copy in its error toast, since the clipboard API gives no reason. */
const failureMessages = {
    absolute: "Could not copy the reference",
    repository: "Could not copy the repo reference",
} satisfies Record<ReferenceKind, string>;

/** Confirms each copy by the path form it used, since the clipboard shows nothing. */
const successMessages = {
    absolute: "Copied reference",
    repository: "Copied repo reference",
} satisfies Record<ReferenceKind, string>;

/** One line of the file's current version that a selection in its diff covers. */
interface SelectedLine {
    number: number;
    text: string;
}

/** The element a selection boundary sits in, which is the parent of a text node. */
function elementOf(node: Node): Element | null {
    return node instanceof Element ? node : node.parentElement;
}

/**
 * Reads a row's line as it is in the file's current version. A modified row shows the removed
 * text inline beside the added text, so the removed segments are dropped from a copy of it.
 */
function newSideText(row: HTMLTableRowElement): string {
    const cell = row.cells.item(row.cells.length - 1);

    if (cell === null) {
        return "";
    }

    const copy = cell.cloneNode(true);

    if (!(copy instanceof Element)) {
        return "";
    }

    for (const removed of copy.querySelectorAll("del")) {
        removed.remove();
    }

    return copy.textContent;
}

/**
 * Whether the selection covers a row at its edge. A selection that starts at the end of a line
 * or is dragged to the start of the next one touches that row without meaning to include it,
 * just like the editor leaves out a line the selection only reaches the start of. Only a row
 * holding the selection's `boundary` can be merely touched; one the selection runs through is
 * covered even when it is a blank line with no text to select.
 */
function selectsTextIn(
    range: Range,
    row: HTMLTableRowElement,
    boundary: Node,
): boolean {
    const cell = row.cells.item(row.cells.length - 1);

    if (!row.contains(boundary)) {
        return true;
    }

    if (cell === null) {
        return false;
    }

    const part = document.createRange();
    part.selectNodeContents(cell);

    if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) {
        part.setStart(range.startContainer, range.startOffset);
    }

    if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) {
        part.setEnd(range.endContainer, range.endOffset);
    }

    return part.toString() !== "";
}

/**
 * The current-version lines a selection covers in one diff card, in order. Removed rows are
 * skipped because they are not in the file a reference points at. Only the first and last
 * rows are checked for selected text, so an empty line the selection runs through is copied.
 */
function selectedLines(range: Range, section: Element): SelectedLine[] {
    const rows = [
        ...section.querySelectorAll<HTMLTableRowElement>("tr[data-line-new]"),
    ].filter((row) => range.intersectsNode(row));

    const first = rows.at(0);

    if (
        first !== undefined &&
        !selectsTextIn(range, first, range.startContainer)
    ) {
        rows.shift();
    }

    const last = rows.at(-1);

    if (last !== undefined && !selectsTextIn(range, last, range.endContainer)) {
        rows.pop();
    }

    return rows.map((row) => ({
        number: Number(row.dataset.lineNew),
        text: newSideText(row),
    }));
}

/**
 * Formats the selected lines as references. A selection across a fold that is still closed
 * skips lines, so each unbroken run gets its own block rather than one block that would
 * misquote the lines below the gap.
 */
function referenceText(lines: SelectedLine[], path: string): string {
    const runs: SelectedLine[][] = [];

    for (const line of lines) {
        const run = runs.at(-1);
        const previous = run?.at(-1);

        if (run !== undefined && previous?.number === line.number - 1) {
            run.push(line);
        } else {
            runs.push([line]);
        }
    }

    return runs
        .map((run) =>
            formatFileReference(
                path,
                run[0]?.number ?? 1,
                run.map((line) => line.text).join("\n"),
            ),
        )
        .join("\n\n");
}

/** What a selection in a diff list can be copied as a reference of. */
interface DiffSelectionReference {
    file: GitDiffListFile;
    lines: SelectedLine[];
}

/**
 * Finds the file and lines a selection covers. The selection has to stay inside one card,
 * since a reference names a single file, and the card has to be of one file on one device,
 * since a Sync compare's two devices have no path an agent could open.
 */
function selectionReference(
    range: Range,
    files: GitDiffListFile[],
): DiffSelectionReference | null {
    const selector = `[${DIFF_SEARCH_PATH_ATTRIBUTE}]`;
    const section = elementOf(range.startContainer)?.closest(selector) ?? null;

    if (
        section === null ||
        elementOf(range.endContainer)?.closest(selector) !== section
    ) {
        return null;
    }

    const path = section.getAttribute(DIFF_SEARCH_PATH_ATTRIBUTE);
    const file = files.find((candidate) => candidate.path === path);

    if (file === undefined || file.link === null) {
        return null;
    }

    const lines = selectedLines(range, section);

    return lines.length === 0 ? null : { file, lines };
}

/**
 * The editor's "Copy reference" and "Copy repo reference" for text selected in a diff list,
 * so a snippet spotted in a review can be pasted to an AI agent with the file and lines it
 * came from. `actionsFor` gives the buttons for the selection toolbar, and `toast` reports the
 * copy, outside the toolbar, since copying clears the selection and with it the toolbar.
 */
export function useDiffCopyReference(files: GitDiffListFile[]) {
    const mutation = useMutation({
        mutationFn: (copy: { kind: ReferenceKind; text: string }) =>
            navigator.clipboard.writeText(copy.text),
    });

    /** The copy buttons for a selection, or null where it covers no line of a file. */
    const actionsFor = (range: Range): React.ReactNode => {
        const reference = selectionReference(range, files);

        if (reference === null) {
            return null;
        }

        /**
         * Reads the lines before clearing the selection, which hides the toolbar once its job
         * is done, so it does not linger over the diff the reader goes back to.
         */
        const copy = (kind: ReferenceKind) => {
            const file = reference.file;

            mutation.mutate({
                kind,
                text: referenceText(
                    reference.lines,
                    kind === "absolute" ? file.path : file.relativePath,
                ),
            });
            document.getSelection()?.removeAllRanges();
        };

        return (
            <>
                <IconButton
                    type="button"
                    variant="outline"
                    size="sm"
                    label="Copy reference"
                    tooltip="Copy as an /absolute/path#Lline code block for AI prompts"
                    // Pressing a button would otherwise clear the selection it acts on.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => copy("absolute")}
                >
                    <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton
                    type="button"
                    variant="outline"
                    size="sm"
                    label="Copy repo reference"
                    tooltip="Copy as a repo/relative/path#Lline code block for AI prompts"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => copy("repository")}
                >
                    <FolderGit2 className="h-4 w-4" aria-hidden="true" />
                </IconButton>
            </>
        );
    };

    const kind = mutation.variables?.kind;

    const toast =
        kind === undefined ? null : mutation.isError ? (
            <Toast
                tone="error"
                dismissAriaLabel="Dismiss copy reference message"
                onDismiss={() => mutation.reset()}
            >
                {getErrorMessage(mutation.error, failureMessages[kind])}
            </Toast>
        ) : mutation.isSuccess ? (
            <Toast
                tone="success"
                icon={<ClipboardCopy className="h-4 w-4" />}
                dismissAriaLabel="Dismiss copy reference message"
                onDismiss={() => mutation.reset()}
            >
                {successMessages[kind]}
            </Toast>
        ) : null;

    return { actionsFor, toast };
}
