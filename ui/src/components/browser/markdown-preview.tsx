import type { ComponentProps } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { syntaxHighlighter } from "#ui/utils/syntax-highlighting";

/** Highlights only explicitly labeled fences so inline and unknown code remain predictable. */
function MarkdownCode(props: ComponentProps<"code"> & ExtraProps) {
    const className = props.className ?? "";
    const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1];

    if (
        language === undefined ||
        syntaxHighlighter.getLanguage(language) === undefined
    ) {
        return <code className={props.className}>{props.children}</code>;
    }

    const source = (props.node?.children ?? [])
        .map((child) => (child.type === "text" ? child.value : ""))
        .join("")
        .replace(/\n$/, "");
    const highlighted = syntaxHighlighter.highlight(source, {
        language,
        ignoreIllegals: true,
    }).value;

    return (
        <code
            className={`${className} hljs`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
        />
    );
}

/** Renders an untrusted markdown draft without enabling raw HTML execution. */
export function MarkdownPreview(props: { content: string }) {
    return (
        <section
            role="region"
            aria-label="Markdown preview"
            className="syntax-highlight prose prose-invert min-h-0 max-w-none flex-1 overflow-auto px-5 py-6 prose-a:text-blue-400 prose-blockquote:border-slate-700 prose-code:rounded prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-headings:tracking-tight prose-hr:border-slate-700 prose-pre:border prose-pre:border-slate-700 prose-pre:bg-slate-900 prose-table:block prose-table:overflow-x-auto sm:px-8 sm:py-8"
        >
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{ code: MarkdownCode }}
            >
                {props.content}
            </ReactMarkdown>
        </section>
    );
}
