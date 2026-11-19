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
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import {
    Check,
    Copy,
    Image as ImageIcon,
    ImageOff,
    LinkIcon,
    ListTree,
} from "lucide-react";
import { isMap, isNode, parseDocument, stringify, type Node } from "yaml";
import { browserRoute } from "#ui/browser-route";
import { useCopyFeedback } from "#ui/components/copyable-code-row";
import { FoldingSection } from "#ui/components/folding-section";
import { HighlightedLines } from "#ui/components/highlighted-tokens";
import { IconButton } from "#ui/components/icon-button";
import { MermaidDiagram } from "#ui/components/browser/mermaid-diagram";
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
function YamlFrontmatterTable(props: {
    headers: string[];
    values: string[];
    className: string;
}) {
    const [open, setOpen] = useState(true);

    return (
        <FoldingSection
            title="YAML frontmatter"
            open={open}
            onOpenChange={setOpen}
            tooltip="Hide or show the document's YAML frontmatter"
            className={cn("mb-6 overflow-hidden", props.className)}
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
        return (
            <code id={props.id} className={props.className}>
                {props.children}
            </code>
        );
    }

    return (
        <code id={props.id} className={props.className}>
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

/** Whether a fence is labeled `mermaid`, the label GitHub draws as a diagram. */
function isMermaidFence(children: MarkdownNodeChild[]): boolean {
    return children.some(
        (child) =>
            child.type === "element" &&
            child.tagName === "code" &&
            Array.isArray(child.properties.className) &&
            child.properties.className.includes("language-mermaid"),
    );
}

/**
 * Wraps fenced code with a copy button, because selecting a multi-line command or snippet
 * by hand is fiddly, especially on phones. The button stays visible rather than appearing on
 * hover so touch screens can reach it.
 */
function CopyableCodeBlock(props: {
    source: string;
    /** The fence as rendered code. */
    children: React.ReactNode;
}) {
    const { isCopied, copy } = useCopyFeedback(props.source);

    return (
        <div className="relative">
            {props.children}
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

/**
 * Renders a fence: Mermaid fences show their diagram, which is read rather than copied, and
 * every other fence gets a copy button.
 */
function MarkdownPre(props: ComponentProps<"pre"> & ExtraProps) {
    const children = props.node?.children ?? [];
    const source = markdownNodeText(children).replace(/\n$/, "");

    if (isMermaidFence(children)) {
        return (
            <MermaidDiagram
                source={source}
                code={
                    <pre id={props.id} className={props.className}>
                        {props.children}
                    </pre>
                }
            />
        );
    }

    return (
        <CopyableCodeBlock source={source}>
            {/* Right padding keeps short lines clear of the button. */}
            <pre id={props.id} className={cn("pr-12", props.className)}>
                {props.children}
            </pre>
        </CopyableCodeBlock>
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
    const href = props.href;

    // An anchor without a destination is a fragment target, such as `<a name>` or one whose
    // unsafe href the sanitizer removed, so it must not become a link to the file's directory.
    if (
        href === undefined ||
        href.startsWith("#") ||
        /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)
    ) {
        return (
            <a
                href={href}
                // Footnote back-references and authored anchors are found by these.
                id={props.id}
                // @ts-expect-error `name` is obsolete on anchors but still a fragment target.
                name={props.name}
                aria-describedby={props["aria-describedby"]}
                title={props.title}
                className={props.className}
            >
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
            // An authored anchor may also be a fragment target.
            id={props.id}
            // @ts-expect-error `name` is obsolete on anchors but still a fragment target.
            name={props.name}
            title={props.title}
            className={props.className}
        >
            {props.children}
        </Link>
    );
}

/** Web addresses an image may load from as written; any other `src` is a path of the device. */
const WEB_IMAGE_SOURCE = /^(?:https?:)?\/\//i;

/** An image dimension attribute in pixels, or null when it is missing or not a size. */
function imageDimension(value: string | number | undefined) {
    const pixels = Number(value);

    return Number.isFinite(pixels) && pixels > 0 ? pixels : null;
}

/**
 * Sizes an image, and the placeholder standing in for it, from the size the file gives it,
 * so approving the images does not reflow the document. The typography styles force
 * `height: auto` on images, which would drop the authored height for the picture's own
 * proportions, so the size is set as styles instead. With both dimensions the box keeps the
 * authored proportions when the column is narrower than the image.
 */
function imageBoxSize(
    width: string | number | undefined,
    height: string | number | undefined,
): React.CSSProperties {
    const w = imageDimension(width);
    const h = imageDimension(height);

    if (w !== null && h !== null) {
        return { width: `${w}px`, aspectRatio: `${w} / ${h}` };
    }

    return {
        width: w === null ? undefined : `${w}px`,
        height: h === null ? undefined : `${h}px`,
    };
}

/**
 * Shows an image only once the reader approved the file's images. Until then nothing is
 * fetched, because a remote image tells its server when and from where the file was read.
 * A relative source names a file on the device, so it is loaded through `imageUrl`.
 */
function MarkdownImage(
    props: ComponentProps<"img"> &
        ExtraProps & {
            approved: boolean;
            filePath: string;
            repositoryRoot: string | null;
            imageUrl: (path: string) => string;
        },
) {
    // Markdown only ever gives a text source; React's type also allows a Blob.
    const src = props.src === undefined ? "" : String(props.src);

    const description =
        props.alt === undefined || props.alt === "" ? "Image" : props.alt;

    if (!props.approved || src === "") {
        const box = imageBoxSize(props.width, props.height);

        return (
            <span
                role="img"
                id={props.id}
                aria-label={`Hidden image: ${description}`}
                style={box}
                className={cn(
                    "inline-flex max-w-full items-center justify-center gap-1.5 overflow-hidden rounded border border-dashed border-slate-600 align-middle text-xs text-slate-400",
                    // Padding would make a small authored box larger than the image it holds.
                    box.width === undefined && box.height === undefined
                        ? "px-2 py-1"
                        : null,
                )}
            >
                <ImageOff className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{description}</span>
            </span>
        );
    }

    const source = WEB_IMAGE_SOURCE.test(src)
        ? src
        : props.imageUrl(
              resolveMarkdownFileLink({
                  href: src,
                  filePath: props.filePath,
                  repositoryRoot: props.repositoryRoot,
              }).path,
          );

    return (
        <img
            src={source}
            id={props.id}
            alt={props.alt}
            title={props.title}
            width={props.width}
            height={props.height}
            // A picture whose proportions differ from its authored size is fitted inside the
            // box rather than stretched.
            style={{
                ...imageBoxSize(props.width, props.height),
                objectFit: "contain",
            }}
            // Remote servers learn nothing about which redoor page or file showed the image.
            referrerPolicy="no-referrer"
            loading="lazy"
            className={props.className}
        />
    );
}

/**
 * Counts the images left after sanitizing, so the preview only offers to show images when
 * the document has some.
 */
function countMarkdownImages(result: { count: number }) {
    const visit = (children: MarkdownNodeChild[]) => {
        for (const child of children) {
            if (child.type !== "element") continue;

            if (child.tagName === "img") {
                result.count += 1;
            }

            visit(child.children);
        }
    };

    return () => (tree: MarkdownRoot) => {
        visit(tree.children);
    };
}

/** The prefix `rehype-sanitize` puts on authored ids and names, as GitHub does. */
const USER_CONTENT_PREFIX = "user-content-";

/** An element of the rendered tree, whose attributes a plugin can read and change. */
type MarkdownElement = Extract<MarkdownNodeChild, { type: "element" }>;

/** An attribute of a tree element as text, or null when the element does not have it. */
function elementAttribute(element: MarkdownElement, name: string) {
    const value = element.properties[name];

    return value === undefined || value === null ? null : String(value);
}

/**
 * Keeps generated heading slugs off the ids the sanitizer left, so a heading titled like a
 * prefixed id, such as `user-content-fn-1`, cannot take that target's links. `reserve` runs
 * before `rehype-slug` to note the ids already in the tree; `separate` runs after it and
 * renames a colliding slug with the next free numeric suffix, as GitHub suffixes repeats.
 */
function separateHeadingSlugs() {
    const reserved = new Set<string>();
    const withIds = new WeakSet<MarkdownElement>();

    const visit = (
        children: MarkdownNodeChild[],
        onElement: (element: MarkdownElement) => void,
    ) => {
        for (const child of children) {
            if (child.type !== "element") continue;

            onElement(child);
            visit(child.children, onElement);
        }
    };

    const reserve = () => (tree: MarkdownRoot) => {
        visit(tree.children, (element) => {
            const id = elementAttribute(element, "id");
            const name = elementAttribute(element, "name");

            if (id !== null) {
                reserved.add(id);
                withIds.add(element);
            }

            // A named anchor is a fragment target as much as an id is.
            if (element.tagName === "a" && name !== null) {
                reserved.add(name);
            }
        });
    };

    const separate = () => (tree: MarkdownRoot) => {
        const taken = new Set<string>();
        const slugged: MarkdownElement[] = [];

        visit(tree.children, (element) => {
            const id = elementAttribute(element, "id");

            if (id === null) return;

            taken.add(id);

            if (!withIds.has(element) && reserved.has(id)) {
                slugged.push(element);
            }
        });

        for (const heading of slugged) {
            const id = elementAttribute(heading, "id") ?? "";
            let suffix = 1;

            while (
                taken.has(`${id}-${suffix}`) ||
                reserved.has(`${id}-${suffix}`)
            ) {
                suffix += 1;
            }

            heading.properties.id = `${id}-${suffix}`;
            taken.add(`${id}-${suffix}`);
        }
    };

    // The targets the file itself wrote, which fragment links may be pointed at.
    return { reserve, separate, reserved };
}

/**
 * Points fragment links at the prefixed ids the sanitizer leaves. Authored ids and names are
 * prefixed so markup like `<img name="getElementById">` cannot shadow DOM APIs of redoor's
 * page, which also moves footnotes and `<a name>` anchors away from the links written for
 * them. GitHub resolves those links the same way. Only `targets`, the ids and names in the
 * tree before heading slugs were made, are considered, and they win over a heading slug, so a
 * heading named like a footnote or anchor cannot take its links.
 */
function resolveUserContentFragments(targets: ReadonlySet<string>) {
    return () => (tree: MarkdownRoot) => {
        const links: { element: MarkdownElement; target: string }[] = [];

        const visit = (children: MarkdownNodeChild[]) => {
            for (const child of children) {
                if (child.type !== "element") continue;

                const href = elementAttribute(child, "href");

                if (child.tagName === "a" && href?.startsWith("#") === true) {
                    links.push({
                        element: child,
                        target: decodeMarkdownPath(href.slice(1)),
                    });
                }

                visit(child.children);
            }
        };

        visit(tree.children);

        for (const link of links) {
            const prefixed = `${USER_CONTENT_PREFIX}${link.target}`;

            if (targets.has(prefixed)) {
                link.element.properties.href = `#${prefixed}`;
            }
        }
    };
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

/**
 * Offers to show the document's images, and to hide them again, since images are blocked
 * until the reader approves them for the file.
 */
function MarkdownImagesBar(props: {
    count: number;
    approved: boolean;
    onApprovedChange: (approved: boolean) => void;
    className: string;
}) {
    const images = props.count === 1 ? "1 image" : `${props.count} images`;

    return (
        <div
            className={cn(
                "mb-6 flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-400",
                props.className,
            )}
        >
            <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1">
                {props.approved
                    ? `Showing ${images} from the network`
                    : `${images} hidden`}
            </p>
            <ToggleButton
                pressed={props.approved}
                label="Show images"
                variant="subtle"
                size="sm"
                className="shrink-0 aria-pressed:bg-blue-500/20 aria-pressed:text-blue-300"
                tooltip={
                    props.approved
                        ? "Hide this file's images and forget the approval"
                        : "Load this file's images, which lets their servers see that the file was opened. Remembered for 7 days."
                }
                onClick={() => props.onApprovedChange(!props.approved)}
            >
                Show images
            </ToggleButton>
        </div>
    );
}

/**
 * Renders an untrusted markdown draft. Embedded HTML is parsed into the same tree as the
 * markdown and cut down to GitHub's allowlist before React renders it, so scripts, styles,
 * frames, forms and event handlers never reach the page, which shares redoor's origin.
 */
export function MarkdownPreview(props: {
    content: string;
    /** The current name of the file's device, which in-app links carry in their URL. */
    deviceName: string;
    filePath: string;
    repositoryRoot: string | null;
    /** Whether the reader approved loading this file's images. */
    imagesApproved: boolean;
    onImagesApprovedChange: (approved: boolean) => void;
    /** The address that serves a file of the device, for images with a relative source. */
    imageUrl: (path: string) => string;
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
    const { rendered, headings, imageCount } = useMemo(() => {
        const headings: MarkdownTocHeading[] = [];
        const images = { count: 0 };
        const headingSlugs = separateHeadingSlugs();

        const rendered = Markdown({
            remarkPlugins: [remarkGfm],
            // The sanitizer prefixes footnote ids itself, so they are not prefixed twice.
            remarkRehypeOptions: { clobberPrefix: "" },
            rehypePlugins: [
                rehypeRaw,
                // Straight after parsing the HTML, so nothing the file wrote skips the allowlist.
                rehypeSanitize,
                // After sanitizing, so heading ids are not prefixed and match their slugs.
                headingSlugs.reserve,
                rehypeSlug,
                headingSlugs.separate,
                resolveUserContentFragments(headingSlugs.reserved),
                collectMarkdownHeadings(headings),
                countMarkdownImages(images),
            ],
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
                img: (imageProps) => (
                    <MarkdownImage
                        {...imageProps}
                        approved={props.imagesApproved}
                        filePath={props.filePath}
                        repositoryRoot={props.repositoryRoot}
                        imageUrl={props.imageUrl}
                    />
                ),
            },
            children: markdown,
        });

        return { rendered, headings, imageCount: images.count };
    }, [
        markdown,
        props.deviceName,
        props.filePath,
        props.repositoryRoot,
        props.imagesApproved,
        props.imageUrl,
    ]);

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

    // The bars above the document start where the corner buttons float, so they end short of
    // them. Each step is the button row's width past the section padding: the contents toggle
    // adds a second button until the preview is wide enough to show the contents as a column,
    // and from then on the buttons sit over that column instead of the document.
    const clearCornerButtons = hasToc
        ? "mr-20 @xl:mr-18 @4xl/markdown:mr-0"
        : "mr-10 @xl:mr-7";

    return (
        <div className="@container/markdown relative flex min-h-0 min-w-0 flex-1">
            <section
                role="region"
                aria-label="Markdown preview"
                className="min-h-0 min-w-0 max-w-none flex-1 overflow-auto px-5 py-6 @xl:px-8 @xl:py-8"
            >
                {imageCount > 0 ? (
                    <MarkdownImagesBar
                        count={imageCount}
                        approved={props.imagesApproved}
                        onApprovedChange={props.onImagesApprovedChange}
                        className={clearCornerButtons}
                    />
                ) : null}
                {frontmatter !== null && frontmatter.headers.length > 0 ? (
                    <YamlFrontmatterTable
                        headers={frontmatter.headers}
                        values={frontmatter.values}
                        className={clearCornerButtons}
                    />
                ) : null}
                {/* Images drop the typography margins and sit like their placeholders, so showing
                    them takes exactly the space the placeholders held. */}
                <div className="syntax-highlight prose prose-invert @max-xl:prose-sm max-w-none prose-img:my-0 prose-img:inline-block prose-img:align-middle prose-a:text-blue-400 prose-blockquote:border-slate-700 prose-code:rounded prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-headings:tracking-tight prose-hr:border-slate-700 prose-pre:border prose-pre:border-slate-700 prose-pre:bg-slate-900 prose-table:block prose-table:overflow-x-auto">
                    {rendered}
                </div>
            </section>
            {/* Inset past the scrollbars of the document and the contents column, so the
                buttons never sit on top of them. */}
            <div className="absolute top-2 right-4 z-30 flex items-center gap-1">
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
