import React from "react";
import { useNavigate } from "@tanstack/react-router";
import { parse as parseDiff } from "diff2html";
import { ColorSchemeType, LineType } from "diff2html/lib/types";
import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui-base";
import "diff2html/bundles/css/diff2html.min.css";
import { syntaxLanguageFromFileName } from "#ui/utils/editor-language";
import {
    HIGHLIGHT_LANGUAGE_NAMES,
    syntaxHighlighter,
} from "#ui/utils/syntax-highlighting";
import { useResolvedTheme } from "#ui/utils/use-resolved-theme";

/** Finds a first-line shebang when an extensionless diff includes that line. */
function firstFileLine(file: ReturnType<typeof parseDiff>[number]): string {
    for (const block of file.blocks) {
        for (const line of block.lines) {
            const isFirstNewLine =
                line.type !== LineType.DELETE && line.newNumber === 1;
            const isFirstOldLine =
                line.type !== LineType.INSERT && line.oldNumber === 1;
            if (isFirstNewLine || isFirstOldLine) {
                return line.content.slice(1);
            }
        }
    }
    return "";
}

/** Keeps unmodified left-clicks in the SPA while still allowing new-tab opens via href. */
function isUnmodifiedPrimaryClick(event: MouseEvent): boolean {
    return (
        !event.defaultPrevented &&
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey
    );
}

/** Reads the new-file line from a diff2html gutter without wrapping the row in a link. */
function newFileLineNumber(row: Element): number | undefined {
    const lineText = row.querySelector(".line-num2")?.textContent?.trim() ?? "";
    if (!/^[1-9][0-9]*$/.test(lineText)) {
        return undefined;
    }
    return Number(lineText);
}

/** Turns generated filename chrome into an editor link so the duplicate heading can be omitted. */
function linkDiffFileNames(root: HTMLElement, editorHref: string) {
    for (const name of root.querySelectorAll(".d2h-file-name")) {
        if (name.closest("a") !== null || name.querySelector("a") !== null) {
            continue;
        }
        const link = document.createElement("a");
        link.href = editorHref;
        link.dataset.editorFile = "";
        link.className = "d2h-file-name-link";
        while (name.firstChild !== null) {
            link.append(name.firstChild);
        }
        name.append(link);
    }
}

/**
 * Appends a trailing editor link so the source text stays selectable and is not itself a link.
 * Only new-side numbers are used because those are the lines that exist in the current file.
 */
function appendEditorLineLinks(root: HTMLElement, editorHref: string) {
    for (const row of root.querySelectorAll("tr")) {
        const line = newFileLineNumber(row);
        const codeLine = row.querySelector(".d2h-code-line");
        const codeCell = codeLine?.parentElement;
        if (line === undefined || codeCell === null || codeCell === undefined) {
            continue;
        }
        codeCell.classList.add("d2h-editor-line-cell");
        const link = document.createElement("a");
        link.href = `${editorHref}?line=${String(line)}`;
        link.dataset.editorLine = String(line);
        link.className = "d2h-editor-line-link";
        link.setAttribute("aria-label", `Open line ${String(line)} in editor`);
        link.textContent = "Open";
        codeCell.append(link);
    }
}

/** Turns trusted server-generated unified diff text into the shared accessible table. */
export function UnifiedDiff(props: {
    unifiedDiff: string;
    emptyMessage?: string;
    /** Browser path for the current file so trailing Open links can jump with ?line=. */
    editorHref?: string;
}) {
    const targetRef = React.useRef<HTMLDivElement>(null);
    const resolvedTheme = useResolvedTheme();
    const navigate = useNavigate();

    React.useEffect(() => {
        const target = targetRef.current;
        if (target === null || props.unifiedDiff === "") {
            return;
        }

        const files = parseDiff(props.unifiedDiff);
        for (const file of files) {
            const fileName =
                file.newName === "/dev/null" ? file.oldName : file.newName;
            const language = syntaxLanguageFromFileName(
                fileName,
                firstFileLine(file),
            );
            file.language =
                language === undefined
                    ? "plaintext"
                    : HIGHLIGHT_LANGUAGE_NAMES[language];
        }

        const diffUi = new Diff2HtmlUI(
            target,
            files,
            {
                drawFileList: false,
                matching: "lines",
                outputFormat: "line-by-line",
                colorScheme:
                    resolvedTheme === "light"
                        ? ColorSchemeType.LIGHT
                        : ColorSchemeType.DARK,
                highlightLanguages: new Map(
                    Object.entries(HIGHLIGHT_LANGUAGE_NAMES),
                ),
                synchronisedScroll: false,
                fileListToggle: false,
                fileContentToggle: false,
                stickyFileHeaders: false,
            },
            syntaxHighlighter,
        );
        diffUi.draw();

        const editorHref = props.editorHref;
        if (editorHref === undefined) {
            return;
        }
        linkDiffFileNames(target, editorHref);
        appendEditorLineLinks(target, editorHref);

        const handleEditorLinkClick = (event: MouseEvent) => {
            if (!isUnmodifiedPrimaryClick(event)) {
                return;
            }
            const eventTarget = event.target;
            if (!(eventTarget instanceof Element)) {
                return;
            }
            const lineLink = eventTarget.closest("a[data-editor-line]");
            if (lineLink instanceof HTMLAnchorElement) {
                const line = Number(lineLink.dataset.editorLine);
                if (!Number.isInteger(line) || line < 1) {
                    return;
                }
                event.preventDefault();
                void navigate({
                    to: editorHref,
                    search: { line },
                });
                return;
            }
            const fileLink = eventTarget.closest("a[data-editor-file]");
            if (!(fileLink instanceof HTMLAnchorElement)) {
                return;
            }
            event.preventDefault();
            void navigate({
                to: editorHref,
                search: {},
            });
        };
        target.addEventListener("click", handleEditorLinkClick);
        return () => {
            target.removeEventListener("click", handleEditorLinkClick);
        };
    }, [props.unifiedDiff, props.editorHref, resolvedTheme, navigate]);

    if (props.unifiedDiff === "") {
        return (
            <p className="text-sm text-slate-400">
                {props.emptyMessage ?? "The files are identical."}
            </p>
        );
    }

    return (
        <div
            ref={targetRef}
            className="file-diff-html syntax-highlight min-w-max"
        />
    );
}
