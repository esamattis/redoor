import {
    createElement,
    useId,
    useMemo,
    useState,
    type ComponentProps,
} from "react";
import { Link } from "@tanstack/react-router";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { LinkIcon } from "lucide-react";
import { isMap, isNode, parseDocument, stringify, type Node } from "yaml";
import { browserRoute } from "#ui/browser-route";
import { FoldingSection } from "#ui/components/folding-section";
import { HighlightedLines } from "#ui/components/highlighted-tokens";
import { Tooltip } from "#ui/components/tooltip";
import {
    highlightLines,
    languageForName,
    useLoadedLanguage,
} from "#ui/utils/code-highlight";

/** Opening `---` must be the first line so thematic breaks later in the file stay markdown. */
const YAML_FRONTMATTER_OPENING = /^---[ \t]*\r?\n/;

/** The next fence-only line ends the YAML document the same way GitHub and Jekyll do. */
const YAML_FRONTMATTER_CLOSING = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/;

/** Keeps table cells as authored YAML instead of re-parsing values as markdown. */
function formatYamlFrontmatterCell(value: Node | null): string {
    if (value === null) {
        return "";
    }

    return stringify(value, { lineWidth: 0 }).trimEnd();
}

/**
 * GitHub turns a leading YAML mapping into a header-row table, so invalid or
 * non-mapping fences are left in the markdown rather than guessed at.
 */
function parseMarkdownYamlFrontmatter(content: string): {
    headers: string[];
    values: string[];
    body: string;
} | null {
    const opening = YAML_FRONTMATTER_OPENING.exec(content);

    if (opening === null) {
        return null;
    }

    const fromYaml = content.slice(opening[0].length);
    const closing = YAML_FRONTMATTER_CLOSING.exec(fromYaml);

    if (closing === null) {
        return null;
    }

    const body = fromYaml.slice(closing.index + closing[0].length);
    const document = parseDocument(fromYaml.slice(0, closing.index));

    if (document.errors.length > 0) {
        return null;
    }

    if (document.contents === null) {
        return { headers: [], values: [], body };
    }

    if (!isMap(document.contents)) {
        return null;
    }

    const headers: string[] = [];
    const values: string[] = [];

    for (const item of document.contents.items) {
        headers.push(
            formatYamlFrontmatterCell(isNode(item.key) ? item.key : null),
        );
        values.push(
            formatYamlFrontmatterCell(isNode(item.value) ? item.value : null),
        );
    }

    return { headers, values, body };
}

/**
 * Frontmatter is metadata, not document prose, so it stays outside typography
 * styles that collapse YAML indentation and shrink tables to content width.
 */
function YamlFrontmatterTable(props: { headers: string[]; values: string[] }) {
    const [open, setOpen] = useState(true);

    return (
        <FoldingSection
            title="YAML frontmatter"
            open={open}
            onOpenChange={setOpen}
            tooltip="Hide or show the document's YAML frontmatter"
            className="mb-6 w-full overflow-hidden"
            contentClassName="p-0"
        >
            <table
                aria-label="YAML frontmatter"
                className="w-full table-fixed border-collapse text-xs"
            >
                <thead>
                    <tr>
                        {props.headers.map((header, index) => (
                            <th
                                key={index}
                                className="border border-slate-700 bg-slate-900 px-2 py-1 text-left font-medium"
                            >
                                {header}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        {props.values.map((value, index) => (
                            <td
                                key={index}
                                className="whitespace-pre-wrap break-words border border-slate-700 px-2 py-1 align-top font-mono"
                            >
                                {value}
                            </td>
                        ))}
                    </tr>
                </tbody>
            </table>
        </FoldingSection>
    );
}

/**
 * Highlights only explicitly labeled fences so inline and unknown code remain predictable.
 * Languages the editor bundles colour at once; others load their grammar and colour the
 * fence once it arrives, showing the plain source until then.
 */
function MarkdownCode(props: ComponentProps<"code"> & ExtraProps) {
    const label = /(?:^|\s)language-([^\s]+)/.exec(props.className ?? "")?.[1];

    const language = useLoadedLanguage(
        label === undefined ? null : languageForName(label),
    );

    const source = (props.node?.children ?? [])
        .map((child) => (child.type === "text" ? child.value : ""))
        .join("")
        .replace(/\n$/, "");

    // Fences re-render with the document, so a long fence is not parsed again each time.
    const lines = useMemo(
        () => (language === null ? null : highlightLines(source, language)),
        [source, language],
    );

    if (lines === null) {
        return <code className={props.className}>{props.children}</code>;
    }

    return (
        <code className={props.className}>
            <HighlightedLines lines={lines} />
        </code>
    );
}

/** Keeps heading names intact while exposing a permalink beside their authored content. */
function MarkdownHeading(props: ComponentProps<"h1"> & ExtraProps) {
    const titleId = useId();

    return createElement(
        props.node?.tagName ?? "h2",
        { id: props.id, "aria-labelledby": titleId },
        <span id={titleId}>{props.children}</span>,
        <Tooltip content="Link to this heading">
            <a
                href={`#${props.id ?? ""}`}
                aria-label="Link to this heading"
                className="ml-2 inline-flex min-h-6 min-w-6 items-center justify-center no-underline opacity-60 hover:opacity-100"
            >
                <LinkIcon aria-hidden="true" className="size-4" />
            </a>
        </Tooltip>,
    );
}

/** Normalizes a remote POSIX path without allowing parent segments above filesystem root. */
function normalizeFilesystemPath(path: string): string {
    const parts: string[] = [];

    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;

        if (part === "..") {
            parts.pop();
            continue;
        }

        parts.push(part);
    }

    return `/${parts.join("/")}`;
}

/** Decodes Markdown URL escaping before encoding the destination as a browser route. */
function decodeMarkdownPath(path: string): string {
    try {
        return decodeURIComponent(path);
    } catch {
        return path;
    }
}

/** A Markdown file link resolved to a file-browser destination on the same device. */
type MarkdownFileLink = { path: string; hash: string | undefined };

/**
 * Resolves a Markdown file link against its directory or the active repository root. It
 * returns the filesystem path and the fragment rather than a URL, so the router builds the
 * device URL and encodes the device name itself. A query string has no meaning for the file
 * browser and is dropped.
 */
export function resolveMarkdownFileLink(options: {
    href: string;
    filePath: string;
    repositoryRoot: string | null;
}): MarkdownFileLink {
    const suffixIndex = options.href.search(/[?#]/);

    const hrefPath =
        suffixIndex === -1 ? options.href : options.href.slice(0, suffixIndex);

    const hashIndex = options.href.indexOf("#");
    const hash = hashIndex === -1 ? "" : options.href.slice(hashIndex + 1);
    const decodedPath = decodeMarkdownPath(hrefPath);

    const fileDirectory = options.filePath.slice(
        0,
        options.filePath.lastIndexOf("/") + 1,
    );

    const destination = decodedPath.startsWith("/")
        ? `${options.repositoryRoot ?? ""}/${decodedPath.slice(1)}`
        : `${fileDirectory}/${decodedPath}`;

    return {
        path: normalizeFilesystemPath(destination),
        hash: hash === "" ? undefined : hash,
    };
}

/** Keeps web and document links native while routing remote filesystem links in-app. */
function MarkdownLink(
    props: ComponentProps<"a"> &
        ExtraProps & {
            deviceName: string;
            filePath: string;
            repositoryRoot: string | null;
        },
) {
    const href = props.href ?? "";

    if (href.startsWith("#") || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) {
        return (
            <a href={href} title={props.title} className={props.className}>
                {props.children}
            </a>
        );
    }

    const link = resolveMarkdownFileLink({
        href,
        filePath: props.filePath,
        repositoryRoot: props.repositoryRoot,
    });

    return (
        <Link
            {...browserRoute({ name: props.deviceName }, link.path)}
            search={{}}
            hash={link.hash}
            title={props.title}
            className={props.className}
        >
            {props.children}
        </Link>
    );
}

/** Renders an untrusted markdown draft without enabling raw HTML execution. */
export function MarkdownPreview(props: {
    content: string;
    /** The current name of the file's device, which in-app links carry in their URL. */
    deviceName: string;
    filePath: string;
    repositoryRoot: string | null;
}) {
    const frontmatter = parseMarkdownYamlFrontmatter(props.content);
    const markdown = frontmatter === null ? props.content : frontmatter.body;

    return (
        <section
            role="region"
            aria-label="Markdown preview"
            className="min-h-0 max-w-none flex-1 overflow-auto px-5 py-6 @xl:px-8 @xl:py-8"
        >
            {frontmatter !== null && frontmatter.headers.length > 0 ? (
                <YamlFrontmatterTable
                    headers={frontmatter.headers}
                    values={frontmatter.values}
                />
            ) : null}
            <div className="syntax-highlight prose prose-invert @max-xl:prose-sm max-w-none prose-a:text-blue-400 prose-blockquote:border-slate-700 prose-code:rounded prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-headings:tracking-tight prose-hr:border-slate-700 prose-pre:border prose-pre:border-slate-700 prose-pre:bg-slate-900 prose-table:block prose-table:overflow-x-auto">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeSlug]}
                    components={{
                        code: MarkdownCode,
                        h1: MarkdownHeading,
                        h2: MarkdownHeading,
                        h3: MarkdownHeading,
                        h4: MarkdownHeading,
                        h5: MarkdownHeading,
                        h6: MarkdownHeading,
                        a: (linkProps) => (
                            <MarkdownLink
                                {...linkProps}
                                deviceName={props.deviceName}
                                filePath={props.filePath}
                                repositoryRoot={props.repositoryRoot}
                            />
                        ),
                    }}
                >
                    {markdown}
                </ReactMarkdown>
            </div>
        </section>
    );
}
