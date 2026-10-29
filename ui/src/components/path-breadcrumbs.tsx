import React from "react";
import { Check, Copy, Pencil } from "lucide-react";

import { useCopyFeedback } from "#ui/components/copyable-code-row";
import { IconButton } from "#ui/components/icon-button";
import { InputControl } from "#ui/components/input-control";
import { expandHomePath } from "#ui/utils/path";

/**
 * One ancestor segment the caller renders. The caller decides what opening a segment means,
 * such as browsing to it or searching in it, and keeps it a real link so modified clicks
 * can still open it in a new tab.
 */
export type PathBreadcrumbLink = {
    path: string;
    className: string;
    children: React.ReactNode;
};

/** Accessible names of the controls, so several breadcrumbs on one screen stay distinct. */
export type PathBreadcrumbLabels = {
    navigation: string;
    input: string;
    submit: string;
    copy: string;
    edit: string;
};

/** The file browser's names, which existing shortcuts in tests and muscle memory rely on. */
const defaultLabels: PathBreadcrumbLabels = {
    navigation: "Breadcrumbs",
    input: "File path",
    submit: "Navigate to path",
    copy: "Copy file path",
    edit: "Edit file path",
};

/**
 * Turns typed text into an absolute path, resolving the device's home shorthand, because
 * routes and searches only accept absolute paths.
 */
function resolveEditedPath(home: string | null, editedPath: string) {
    const expandedPath = expandHomePath(home, editedPath);

    if (expandedPath === "") {
        return "/";
    }

    return expandedPath.startsWith("/") ? expandedPath : `/${expandedPath}`;
}

/**
 * Shows an absolute path as links to each ancestor while allowing the whole path to be typed,
 * copied or corrected in place. Remount it with a `key` when the path changes from outside so
 * an open editor closes.
 */
export function PathBreadcrumbs(props: {
    path: string;
    /** The device's home directory, so a typed `~` resolves on that device. */
    home: string | null;
    renderLink: (link: PathBreadcrumbLink) => React.ReactNode;
    /** Receives an absolute path that differs from the current one. */
    onSubmitPath: (path: string) => void;
    /** Opens the path editor immediately so a missing path can be corrected in place. */
    startEditing?: boolean;
    labels?: PathBreadcrumbLabels;
}) {
    const labels = props.labels ?? defaultLabels;
    const pathInputRef = React.useRef<HTMLInputElement>(null);
    const crumbsRef = React.useRef<HTMLElement>(null);

    const [isEditing, setIsEditing] = React.useState(
        props.startEditing === true,
    );

    const [editedPath, setEditedPath] = React.useState(props.path);
    const { isCopied, copy } = useCopyFeedback(props.path);

    const parts = props.path.split("/").filter((part) => part !== "");
    const isAtRoot = parts.length === 0;
    let accumulatedPath = "";

    // Focus after paint so keyboard correction works immediately on missing paths.
    React.useEffect(() => {
        if (!isEditing) {
            return;
        }

        pathInputRef.current?.focus();
        pathInputRef.current?.select();
    }, [isEditing, props.path]);

    // A long path overflows a narrow column, and its last segment is the one the reader is
    // at, so the crumbs show their end. A resize observer waits for the crumbs to have a
    // width, since a dialog may open only after this effect runs, and follows later resizes.
    React.useEffect(() => {
        const crumbs = crumbsRef.current;

        if (isEditing || !crumbs) {
            return;
        }

        const observer = new ResizeObserver(() => {
            crumbs.scrollLeft = crumbs.scrollWidth;
        });

        observer.observe(crumbs);

        return () => observer.disconnect();
    }, [isEditing, props.path]);

    // The crumbs hide their scrollbar and a plain mouse wheel only scrolls vertically, so a
    // mouse user could not reach the start of a long path. The wheel scrolls the crumbs
    // sideways only while they overflow, so a short path does not swallow page scrolling.
    // React registers wheel handlers as passive, which cannot prevent the page scroll.
    React.useEffect(() => {
        const crumbs = crumbsRef.current;

        if (isEditing || !crumbs) {
            return;
        }

        const scrollSideways = (event: WheelEvent) => {
            const overflows = crumbs.scrollWidth > crumbs.clientWidth;
            const isVertical = Math.abs(event.deltaY) > Math.abs(event.deltaX);

            // Trackpads already scroll sideways, and Shift+wheel is the browser's own way.
            if (!overflows || !isVertical || event.shiftKey) {
                return;
            }

            event.preventDefault();

            // Firefox reports mouse wheels in lines, which would barely move the crumbs.
            const lineHeight =
                event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;

            crumbs.scrollLeft += event.deltaY * lineHeight;
        };

        crumbs.addEventListener("wheel", scrollSideways, { passive: false });

        return () => crumbs.removeEventListener("wheel", scrollSideways);
    }, [isEditing]);

    /** Opens the path editor with the current path. */
    const startEditing = () => {
        setEditedPath(props.path);
        setIsEditing(true);
    };

    /** Hands a changed path to the owner, which decides whether the editor stays open. */
    const submitEditedPath = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const targetPath = resolveEditedPath(props.home, editedPath);
        setIsEditing(false);

        if (targetPath !== props.path) {
            props.onSubmitPath(targetPath);
        }
    };

    if (isEditing) {
        return (
            <form
                onSubmit={submitEditedPath}
                className="flex min-w-0 flex-1 items-center gap-1"
            >
                <InputControl
                    ref={pathInputRef}
                    type="text"
                    value={editedPath}
                    onChange={(event) => setEditedPath(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            // Inside a modal dialog Escape would otherwise close the whole dialog.
                            event.preventDefault();
                            setIsEditing(false);
                        }
                    }}
                    aria-label={labels.input}
                    className="min-w-0 w-full flex-1 border-slate-600 bg-slate-950 px-2 py-1 font-mono text-sm"
                />
                <IconButton
                    type="submit"
                    label={labels.submit}
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                >
                    <Check className="h-4 w-4" />
                </IconButton>
            </form>
        );
    }

    return (
        <div className="flex min-w-0 flex-1 items-center gap-1">
            {/* Only the crumbs scroll, so copy and edit stay in reach on a long path. The
                scrollbar is hidden, since the crumbs start scrolled to the end anyway. Padded
                tap targets of short segments overhang the row, so the y axis is padded and
                clipped. */}
            <nav
                ref={crumbsRef}
                aria-label={labels.navigation}
                className="scrollbar-hidden flex min-w-0 flex-1 items-center gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain py-1 text-sm"
            >
                {isAtRoot ? (
                    <span className="shrink-0 font-medium text-slate-100">
                        /
                    </span>
                ) : (
                    props.renderLink({
                        path: "/",
                        className:
                            "-my-1 shrink-0 rounded px-1.5 py-1 text-blue-400 hover:underline",
                        children: "/",
                    })
                )}
                {parts.map((part, index) => {
                    accumulatedPath = `${accumulatedPath}/${part}`;
                    const isLast = index === parts.length - 1;

                    return (
                        <div
                            key={index}
                            className="flex shrink-0 items-center gap-2"
                        >
                            {index > 0 ? (
                                <span className="text-slate-600">/</span>
                            ) : null}
                            {isLast ? (
                                <span className="whitespace-nowrap font-medium text-slate-100">
                                    {part}
                                </span>
                            ) : (
                                props.renderLink({
                                    path: accumulatedPath,
                                    // Short names get padding so they remain easy to tap.
                                    className: `whitespace-nowrap font-medium text-blue-400 hover:underline ${part.length < 3 ? "-my-1 rounded px-1.5 py-1" : ""}`,
                                    children: part,
                                })
                            )}
                        </div>
                    );
                })}
            </nav>
            <IconButton
                type="button"
                onClick={() => {
                    void copy();
                }}
                label={isCopied ? "Copied!" : labels.copy}
                tooltip={labels.copy}
                variant="ghost"
                size="sm"
                className={
                    isCopied
                        ? "shrink-0 text-emerald-300 hover:bg-transparent hover:text-emerald-300"
                        : "shrink-0 text-slate-500"
                }
            >
                {isCopied ? (
                    <Check className="h-3.5 w-3.5" />
                ) : (
                    <Copy className="h-3.5 w-3.5" />
                )}
            </IconButton>
            <IconButton
                type="button"
                onClick={startEditing}
                label={labels.edit}
                variant="ghost"
                size="sm"
                className="shrink-0 text-slate-500"
            >
                <Pencil className="h-3.5 w-3.5" />
            </IconButton>
        </div>
    );
}
