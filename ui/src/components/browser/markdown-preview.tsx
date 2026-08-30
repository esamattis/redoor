import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders an untrusted markdown draft without enabling raw HTML execution. */
export function MarkdownPreview(props: { content: string }) {
    return (
        <section
            role="region"
            aria-label="Markdown preview"
            className="prose prose-invert min-h-0 max-w-none flex-1 overflow-auto px-5 py-6 prose-a:text-blue-400 prose-blockquote:border-slate-700 prose-code:rounded prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-headings:tracking-tight prose-hr:border-slate-700 prose-pre:border prose-pre:border-slate-700 prose-pre:bg-slate-900 prose-table:block prose-table:overflow-x-auto sm:px-8 sm:py-8"
        >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {props.content}
            </ReactMarkdown>
        </section>
    );
}
