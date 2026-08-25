import React from "react";
import { useNavigate } from "@tanstack/react-router";
import { parse as parseDiff } from "diff2html";
import { ColorSchemeType, LineType } from "diff2html/lib/types";
import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui-base";
import hljs from "highlight.js/lib/core";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import perl from "highlight.js/lib/languages/perl";
import plaintext from "highlight.js/lib/languages/plaintext";
import properties from "highlight.js/lib/languages/properties";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import toml from "highlight.js/lib/languages/ini";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "diff2html/bundles/css/diff2html.min.css";
import {
    syntaxLanguageFromFileName,
    type SupportedSyntaxLanguage,
} from "#ui/utils/editor-language";
import { useResolvedTheme } from "#ui/utils/use-resolved-theme";

const HIGHLIGHT_LANGUAGE_NAMES = {
    cpp: "cpp",
    csharp: "csharp",
    css: "css",
    go: "go",
    html: "xml",
    java: "java",
    javascript: "javascript",
    json: "json",
    lua: "lua",
    markdown: "markdown",
    perl: "perl",
    plaintext: "plaintext",
    properties: "properties",
    python: "python",
    ruby: "ruby",
    rust: "rust",
    shell: "shell",
    toml: "toml",
    typescript: "typescript",
    xml: "xml",
    yaml: "yaml",
} satisfies Record<SupportedSyntaxLanguage | "plaintext", string>;

hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("perl", perl);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("properties", properties);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("toml", toml);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

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

/** Reads the new-file line from a diff2html gutter without wrapping the row in a link. */
function newFileLineNumber(row: Element): number | undefined {
    const lineText = row.querySelector(".line-num2")?.textContent?.trim() ?? "";
    if (!/^[1-9][0-9]*$/.test(lineText)) {
        return undefined;
    }
    return Number(lineText);
}

/**
 * Appends a trailing editor link so the source text stays selectable and is not itself a link.
 * Only new-side numbers are used because those are the lines that exist in the current file.
 */
function appendEditorLineLinks(root: HTMLElement, editorHref: string) {
    for (const row of root.querySelectorAll("tr")) {
        const line = newFileLineNumber(row);
        const codeLine = row.querySelector(".d2h-code-line");
        if (line === undefined || codeLine === null) {
            continue;
        }
        const link = document.createElement("a");
        link.href = `${editorHref}?line=${String(line)}`;
        link.dataset.editorLine = String(line);
        link.className = "d2h-editor-line-link";
        link.setAttribute("aria-label", `Open line ${String(line)} in editor`);
        link.textContent = "Open";
        codeLine.append(link);
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
            hljs,
        );
        diffUi.draw();

        const editorHref = props.editorHref;
        if (editorHref === undefined) {
            return;
        }
        appendEditorLineLinks(target, editorHref);

        /** Keeps unmodified clicks in the SPA while still allowing new-tab opens via the href. */
        const handleEditorLineClick = (event: MouseEvent) => {
            if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
            ) {
                return;
            }
            const eventTarget = event.target;
            if (!(eventTarget instanceof Element)) {
                return;
            }
            const link = eventTarget.closest("a[data-editor-line]");
            if (!(link instanceof HTMLAnchorElement)) {
                return;
            }
            const line = Number(link.dataset.editorLine);
            if (!Number.isInteger(line) || line < 1) {
                return;
            }
            event.preventDefault();
            void navigate({
                to: editorHref,
                search: { line },
            });
        };
        target.addEventListener("click", handleEditorLineClick);
        return () => {
            target.removeEventListener("click", handleEditorLineClick);
        };
    }, [props.unifiedDiff, props.editorHref, resolvedTheme, navigate]);

    if (props.unifiedDiff === "") {
        return (
            <p className="text-sm text-slate-400">
                {props.emptyMessage ?? "The files are identical."}
            </p>
        );
    }

    return <div ref={targetRef} className="file-diff-html min-w-max" />;
}
