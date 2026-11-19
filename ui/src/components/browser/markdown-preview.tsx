import {
    createElement,
    useId,
    useMemo,
    useRef,
    useState,
    type ComponentProps,
} from "react";
import { Link } from "@tanstack/react-router";
import Markdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { Check, Copy, LinkIcon, ListTree } from "lucide-react";
import { isMap, isNode, parseDocument, stringify, type Node } from "yaml";
import { browserRoute } from "#ui/browser-route";
import { useCopyFeedback } from "#ui/components/copyable-code-row";
import { FoldingSection } from "#ui/components/folding-section";
import { HighlightedLines } from "#ui/components/highlighted-tokens";
import { IconButton } from "#ui/components/icon-button";
import { ToggleButton } from "#ui/components/toggle-button";
import { Tooltip } from "#ui/components/tooltip";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { cn } from "#ui/utils/cn";
import { isPlainKey } from "#ui/utils/keyboard";
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

/** A child of a rendered markdown element, typed through react-markdown so hast needs no direct dependency. */
type MarkdownNodeChild = NonNullable<ExtraProps["node"]>["children"][number];

/**
 * Collects the authored text under a node. Highlighted fences are split into token
 * elements, so the copied source comes from the markdown tree rather than the DOM.
 */
function markdownNodeText(children: MarkdownNodeChild[]): string {
    return children
        .map((child) => {
            if (child.type === "text") {
                return child.value;
            }

            if (child.type === "element") {
                return markdownNodeText(child.children);
            }

            return "";
        })
        .join("");
}

/**
 * Wraps fenced code with a copy button, because selecting a multi-line command or snippet
 * by hand is fiddly, especially on phones. The button stays visible rather than appearing on
 * hover so touch screens can reach it.
 */
function MarkdownPre(props: ComponentProps<"pre"> & ExtraProps) {
    const source = markdownNodeText(props.node?.children ?? []).replace(
        /\n$/,
        "",
    );

    const { isCopied, copy } = useCopyFeedback(source);

    return (
        <div className="relative">
            {/* Right padding keeps short lines clear of the button. */}
            <pre className={cn("pr-12", props.className)}>{props.children}</pre>
            <div className="absolute right-1 top-1">
                <IconButton
                    type="button"
                    size="sm"
                    label={isCopied ? "Copied!" : "Copy code"}
                    onClick={() => {
                        void copy();
                    }}
                    className={cn(
                        "rounded-md border bg-slate-900 transition-colors",
                        isCopied
                            ? "border-emerald-400/50 text-emerald-300"
                            : "border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                    )}
                >
                    {isCopied ? (
                        <Check className="size-4" aria-hidden="true" />
                    ) : (
                        <Copy className="size-4" aria-hidden="true" />
                    )}
                </IconButton>
            </div>
        </div>
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

/** A heading of the rendered document, as the table of contents lists it. */
type MarkdownTocHeading = {
    /** The slug `rehype-slug` gave the heading, which the entry links to. */
    id: string;
    /** 1 to 6, so entries can be indented by heading level. */
    depth: number;
    text: string;
};

/** The rendered tree's root, typed through react-markdown so hast needs no direct dependency. */
type MarkdownRoot = { children: MarkdownNodeChild[] };

/**
 * Builds a rehype plugin that records the document's headings into `headings` as the
 * markdown is rendered. Reading them from the same tree that becomes the page, after
 * `rehype-slug`, keeps the table of contents' links equal to the heading ids without
 * parsing the document a second time.
 */
function collectMarkdownHeadings(headings: MarkdownTocHeading[]) {
    const visit = (children: MarkdownNodeChild[]) => {
        for (const child of children) {
            if (child.type !== "element") continue;

            const depth = /^h([1-6])$/.exec(child.tagName)?.[1];
            // `rehype-slug` gives every heading an id; hast just types properties loosely.
            const id = child.properties.id;

            if (depth !== undefined && id !== undefined && id !== null) {
                headings.push({
                    id: String(id),
                    depth: Number(depth),
                    text: markdownNodeText(child.children),
                });
            } else {
                visit(child.children);
            }
        }
    };

    return () => (tree: MarkdownRoot) => {
        visit(tree.children);
    };
}

/**
 * Lists the document's headings. Entries are native fragment links like the heading
 * permalinks, so jumping to a section behaves, and can be shared, the same way.
 */
function MarkdownTableOfContents(props: {
    headings: MarkdownTocHeading[];
    /** Whether the narrow-screen drawer is open; wide previews always show the column. */
    open: boolean;
    onNavigate: () => void;
}) {
    // Indent relative to the shallowest heading, so a document without an h1 is not shifted.
    const minDepth = Math.min(
        ...props.headings.map((heading) => heading.depth),
    );

    return (
        <nav
            aria-label="Table of contents"
            className={cn(
                "w-64 shrink-0 overflow-auto border-l border-slate-800 bg-surface pb-6 text-sm",
                props.open
                    ? "absolute inset-y-0 right-0 z-20 max-w-[85%] shadow-xl @4xl/markdown:static @4xl/markdown:max-w-none @4xl/markdown:shadow-none"
                    : "hidden @4xl/markdown:block",
            )}
        >
            {/* Not a heading, so the document's own heading outline stays its own. Right padding
                keeps the title clear of the preview's buttons above it. */}
            <p className="flex h-11 items-center pl-4 pr-24 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Contents
            </p>
            <ul>
                {props.headings.map((heading) => (
                    <li key={heading.id}>
                        <a
                            href={`#${heading.id}`}
                            onClick={props.onNavigate}
                            style={{
                                paddingLeft: `${1 + (heading.depth - minDepth) * 0.75}rem`,
                            }}
                            className="block py-1.5 pr-4 text-slate-300 hover:bg-tint hover:text-slate-50 @max-4xl/markdown:py-2.5"
                        >
                            {heading.text}
                        </a>
                    </li>
                ))}
            </ul>
        </nav>
    );
}

/** Renders an untrusted markdown draft without enabling raw HTML execution. */
export function MarkdownPreview(props: {
    content: string;
    /** The current name of the file's device, which in-app links carry in their URL. */
    deviceName: string;
    filePath: string;
    repositoryRoot: string | null;
    /** Controls placed in the preview's top-right corner, such as the way back to the editor. */
    actions?: React.ReactNode;
    /**
     * False while the preview stays mounted behind the editor, so a drawer left open there
     * does not take Escape from the editor. Defaults to shown.
     */
    shown?: boolean;
}) {
    const frontmatter = parseMarkdownYamlFrontmatter(props.content);
    const markdown = frontmatter === null ? props.content : frontmatter.body;
    const [isTocOpen, setTocOpen] = useState(false);

    // `Markdown` is a plain synchronous function, so calling it here renders the document and
    // fills `headings` in one pass, and a re-render that keeps the text skips both.
    const { rendered, headings } = useMemo(() => {
        const headings: MarkdownTocHeading[] = [];

        const rendered = Markdown({
            remarkPlugins: [remarkGfm],
            rehypePlugins: [rehypeSlug, collectMarkdownHeadings(headings)],
            components: {
                code: MarkdownCode,
                pre: MarkdownPre,
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
            },
            children: markdown,
        });

        return { rendered, headings };
    }, [markdown, props.deviceName, props.filePath, props.repositoryRoot]);

    const hasToc = headings.length > 0;
    const tocToggleRef = useRef<HTMLButtonElement>(null);

    // Just above the view tier, so Escape closes the drawer before the whole preview, while
    // menus and dialogs opened over the drawer, which are modal, still close first.
    useShortcut(
        {
            name: "close-markdown-toc",
            phase: "bubble",
            priority: shortcutPriority.view + 1,
            skipTypingTargets: true,
            // The toggle shows only while the contents are a drawer; once the preview widens
            // into a column, Escape belongs to the preview again.
            match: (event) =>
                isPlainKey(event, "Escape") &&
                tocToggleRef.current?.checkVisibility() === true,
            run: () => {
                setTocOpen(false);
                // Focus inside the closing drawer would be lost, so it goes back to the opener.
                tocToggleRef.current?.focus();
            },
        },
        hasToc && isTocOpen && props.shown !== false,
    );

    return (
        <div className="@container/markdown relative flex min-h-0 min-w-0 flex-1">
            <section
                role="region"
                aria-label="Markdown preview"
                className="min-h-0 min-w-0 max-w-none flex-1 overflow-auto px-5 py-6 @xl:px-8 @xl:py-8"
            >
                {frontmatter !== null && frontmatter.headers.length > 0 ? (
                    <YamlFrontmatterTable
                        headers={frontmatter.headers}
                        values={frontmatter.values}
                    />
                ) : null}
                <div className="syntax-highlight prose prose-invert @max-xl:prose-sm max-w-none prose-a:text-blue-400 prose-blockquote:border-slate-700 prose-code:rounded prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-headings:tracking-tight prose-hr:border-slate-700 prose-pre:border prose-pre:border-slate-700 prose-pre:bg-slate-900 prose-table:block prose-table:overflow-x-auto">
                    {rendered}
                </div>
            </section>
            <div className="absolute top-1 right-1 z-30 flex items-center gap-1">
                {hasToc ? (
                    // Wide previews show the contents as a column, so only narrow ones need it.
                    <ToggleButton
                        ref={tocToggleRef}
                        pressed={isTocOpen}
                        label="Table of contents"
                        tooltip={
                            isTocOpen
                                ? "Hide the table of contents (Esc)"
                                : "Show the table of contents"
                        }
                        variant="subtle"
                        size="lg"
                        onClick={() => setTocOpen((open) => !open)}
                        className="bg-surface/90 @4xl/markdown:hidden"
                    >
                        <ListTree className="h-5 w-5" aria-hidden="true" />
                    </ToggleButton>
                ) : null}
                {props.actions}
            </div>
            {/* After the buttons, so Tab from the toggle walks into the drawer it opened. */}
            {hasToc ? (
                <MarkdownTableOfContents
                    headings={headings}
                    open={isTocOpen}
                    onNavigate={() => setTocOpen(false)}
                />
            ) : null}
        </div>
    );
}
