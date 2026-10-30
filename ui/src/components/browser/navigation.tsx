import React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
    ArrowLeft,
    ArrowUp,
    File,
    Files,
    Home,
    Info,
    Pencil,
    RefreshCw,
    GitBranch,
    GitCommitHorizontal,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import type { GitContextResponse } from "#bindings/GitContextResponse";
import { Button } from "#ui/components/button";
import { PathBreadcrumbs } from "#ui/components/path-breadcrumbs";
import { IconLinkButton } from "#ui/components/icon-button";
import { SearchButton } from "#ui/components/search-button";
import { Tooltip } from "#ui/components/tooltip";
import { shortCommitId } from "#ui/components/browser/git-parts";
import { useViewToolbarSlotRef } from "#ui/components/browser/view-toolbar-slot";
import type { PathLoadError } from "#ui/components/browser/utils";
import { browserRoute } from "#ui/browser-route";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { isPlainKey } from "#ui/utils/keyboard";
import { cn } from "#ui/utils/cn";

/** Names the representations of a path that the view tabs switch between. */
export type BrowserView = "files" | "details" | "view" | "sync" | "git";

/**
 * What the Git tab names. The tab is already the sign that a path is in a repository, so it
 * also says where new commits would land, without opening the Git view to find out.
 */
export type GitTabHead =
    | { type: "branch"; name: string }
    /** No branch is checked out; the id is absent only if HEAD names no commit at all. */
    | { type: "detached"; commitId: string | null }
    /** A browsed revision, which its banner already names, so the tab stays plain "Git". */
    | { type: "revision" };

/** Reads the Git tab from the worktree context, or null to hide the tab outside a worktree. */
export function gitTabHead(context: GitContextResponse): GitTabHead | null {
    if (context.status === "outside_worktree") {
        return null;
    }

    if (context.branch_name !== null) {
        return { type: "branch", name: context.branch_name };
    }

    return { type: "detached", commitId: context.head_commit_id };
}

/** Keeps location, navigation, view state, and object actions in a stable frame. */
function BrowserPageHeader(props: {
    agent: Agent;
    path: string;
    startEditingPath?: boolean;
    navigation: React.ReactNode;
    /** Page-wide context shown under the breadcrumbs, such as the browsed Git revision. */
    banner?: React.ReactNode;
    viewToggle: React.ReactNode;
}) {
    const navigate = useNavigate();
    const setToolbarSlot = useViewToolbarSlotRef();

    return (
        <header>
            <div className="mb-2 flex min-w-0 items-center gap-1">
                <div className="flex shrink-0 items-center gap-0.5">
                    <IconLinkButton
                        {...browserRoute(props.agent, props.agent.cwd ?? "/")}
                        label="Device home"
                        tooltip="Open device home directory"
                        variant="ghost"
                        size="lg"
                    >
                        <Home className="h-4 w-4" aria-hidden="true" />
                    </IconLinkButton>
                    <SearchButton
                        size="lg"
                        className="[&_svg]:h-4 [&_svg]:w-4"
                    />
                    {props.navigation}
                </div>
                <span
                    aria-hidden="true"
                    className="mx-1 h-5 w-px shrink-0 bg-slate-700"
                />
                <PathBreadcrumbs
                    // A new location resets the path editor, so it starts closed (or open for a path that needs correcting).
                    key={`${props.path}:${props.startEditingPath === true}`}
                    path={props.path}
                    home={props.agent.cwd}
                    startEditing={props.startEditingPath}
                    renderLink={(link) => (
                        <Link
                            {...browserRoute(props.agent, link.path)}
                            className={link.className}
                        >
                            {link.children}
                        </Link>
                    )}
                    // The destination route decides whether the editor reopens for a missing path.
                    onSubmitPath={(path) =>
                        void navigate(browserRoute(props.agent, path))
                    }
                />
            </div>
            {props.banner ? <div className="mb-2">{props.banner}</div> : null}
            {props.viewToggle ? (
                // Wide columns put the view's toolbar on the tab row; narrow ones give it a row
                // of its own under the tabs, since both would not fit side by side on a phone.
                <div className="-mx-2 flex flex-col border-b border-slate-800 @2xl:flex-row @2xl:items-stretch @2xl:gap-4 @4xl:-mx-4">
                    <div className="scrollbar-hidden min-w-0 overflow-x-auto overscroll-x-contain px-2 @4xl:px-4 @2xl:pr-0">
                        {props.viewToggle}
                    </div>
                    <div
                        ref={setToolbarSlot}
                        className="flex min-w-0 items-center border-t border-slate-800 px-2 py-1 empty:hidden @2xl:ml-auto @2xl:border-t-0 @2xl:py-0.5 @4xl:px-4 @2xl:pl-0"
                    />
                </div>
            ) : null}
        </header>
    );
}

/** Keeps filesystem representations beside their path instead of in global navigation. */
export function ViewToggle(props: {
    agent: Agent;
    path: string;
    entryType: "directory" | "file";
    activeView: BrowserView;
    /** Names the content tab Edit only after the agent marks the file writable. */
    editable?: boolean;
    /** What the Git tab names, or null to hide it outside a worktree. */
    gitHead: GitTabHead | null;
    /** Hides views that change files, and never names the content tab Edit. */
    readOnly?: boolean;
}) {
    const isDirectory = props.entryType === "directory";
    const readOnly = props.readOnly === true;

    // A directory's default tab is its listing; a file's is its content, named by what it allows.
    const contentLabel = isDirectory
        ? "Files"
        : props.editable === true && !readOnly
          ? "Edit"
          : "View";

    const contentIcon = isDirectory ? (
        <Files className="h-4 w-4" aria-hidden="true" />
    ) : props.editable === true && !readOnly ? (
        <Pencil className="h-4 w-4" aria-hidden="true" />
    ) : (
        <File className="h-4 w-4" aria-hidden="true" />
    );

    return (
        <ViewSwitch
            label={isDirectory ? "Directory view" : "File view"}
            variant="page"
        >
            <ViewToggleLink
                agent={props.agent}
                path={props.path}
                label={contentLabel}
                icon={contentIcon}
                active={props.activeView === (isDirectory ? "files" : "view")}
            />
            <ViewToggleLink
                agent={props.agent}
                path={props.path}
                view="details"
                label="Details"
                icon={<Info className="h-4 w-4" aria-hidden="true" />}
                active={props.activeView === "details"}
            />
            {readOnly ? null : (
                <ViewToggleLink
                    agent={props.agent}
                    path={props.path}
                    view="sync"
                    label="Sync"
                    icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
                    active={props.activeView === "sync"}
                />
            )}
            {props.gitHead === null ? null : (
                <GitViewToggleLink
                    agent={props.agent}
                    path={props.path}
                    head={props.gitHead}
                    active={props.activeView === "git"}
                />
            )}
        </ViewSwitch>
    );
}

/**
 * Names the Git tab by the checked-out branch, or in amber by the commit of a detached HEAD,
 * which is not where new commits would go. The accessible name keeps "Git" first, so the
 * tab is still announced and found as the Git view when its visible text is a branch name.
 */
function GitViewToggleLink(props: {
    agent: Agent;
    path: string;
    head: GitTabHead;
    active: boolean;
}) {
    const head = props.head;
    const branchIcon = <GitBranch className="h-4 w-4" aria-hidden="true" />;

    if (head.type === "revision") {
        return (
            <ViewToggleLink
                agent={props.agent}
                path={props.path}
                view="git"
                label="Git"
                icon={branchIcon}
                active={props.active}
            />
        );
    }

    const description =
        head.type === "branch"
            ? `branch ${head.name}`
            : head.commitId === null
              ? "detached HEAD"
              : `detached at ${shortCommitId(head.commitId)}`;

    return (
        <ViewToggleLink
            agent={props.agent}
            path={props.path}
            view="git"
            label={
                // Long branch names would push the other tabs off a phone-narrow strip.
                <span className="max-w-48 truncate @max-xl/main:max-w-32">
                    {head.type === "branch"
                        ? head.name
                        : head.commitId === null
                          ? "Detached"
                          : shortCommitId(head.commitId)}
                </span>
            }
            ariaLabel={`Git, ${description}`}
            tooltip={`Git view, on ${description}`}
            icon={
                head.type === "branch" ? (
                    branchIcon
                ) : (
                    <GitCommitHorizontal
                        className="h-4 w-4"
                        aria-hidden="true"
                    />
                )
            }
            active={props.active}
            className={
                head.type === "detached"
                    ? "text-amber-300 [&_svg]:text-amber-300"
                    : undefined
            }
        />
    );
}

/** Applies current-page semantics to a filesystem representation link. */
function ViewToggleLink(props: {
    agent: Agent;
    path: string;
    /** Leaves the default representation, the listing or content, when omitted. */
    view?: "details" | "sync" | "git";
    label: React.ReactNode;
    /** Names the tab for assistive technology when the visible label alone is not its name. */
    ariaLabel?: string;
    /** Explains a tab whose visible label is not the name of its view. */
    tooltip?: string;
    icon: React.ReactNode;
    active: boolean;
    className?: string;
}) {
    const link = (
        <Link
            {...browserRoute(props.agent, props.path)}
            search={{ view: props.view }}
            aria-current={props.active ? "page" : undefined}
            aria-label={props.ariaLabel}
            className={cn(getPageViewTabClass(props.active), props.className)}
        >
            {props.icon}
            {props.label}
        </Link>
    );

    return props.tooltip === undefined ? (
        link
    ) : (
        <Tooltip content={props.tooltip} className="shrink-0">
            {link}
        </Tooltip>
    );
}

/** Presents route-backed representations as a compact tab strip without changing link semantics. */
export function ViewSwitch(props: {
    label: string;
    /** Page tabs stay visually secondary so they do not compete with the top-bar chrome tabs. */
    variant?: "chrome" | "page";
    children: React.ReactNode;
}) {
    const stripClass =
        props.variant === "page"
            ? "scrollbar-hidden flex w-full min-w-0 items-stretch gap-0 overflow-x-auto overscroll-x-contain"
            : "scrollbar-hidden flex w-full min-w-0 items-end gap-1 overflow-x-auto overscroll-x-contain";

    return (
        <div aria-label={props.label} className={stripClass}>
            {props.children}
        </div>
    );
}

/** Recreates the raised active-tab treatment while retaining current-page semantics on links. */
export function getViewSwitchItemClass(isActive: boolean) {
    const baseClass =
        "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-lg border border-b-0 px-4 py-2 text-sm font-medium transition-colors";

    // A phone cannot fit every label, so only the active tab keeps its label and the others
    // show their icon. The label stays for assistive technology, which still names each tab.
    return isActive
        ? `${baseClass} border-slate-700 bg-surface-active text-slate-100 shadow-[0_-2px_0_0_rgb(59,130,246)_inset] [&_svg]:text-blue-400 @max-xl/main:px-3`
        : `${baseClass} border-transparent text-slate-400 hover:bg-tint hover:text-slate-100 @max-xl/main:px-3 @max-xl/main:[&>span]:sr-only`;
}

/** Uses an underline so file and directory views read as in-page switches, not a second top bar. */
function getPageViewTabClass(isActive: boolean) {
    const baseClass =
        "inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-1.5 text-sm font-medium transition-colors";

    return isActive
        ? `${baseClass} border-blue-500 text-slate-100 [&_svg]:text-blue-400`
        : `${baseClass} border-transparent text-slate-400 hover:border-slate-600 hover:text-slate-100`;
}

/** Separates location context, navigation, and directory actions by purpose. */
export function BrowserHeader(props: {
    agent: Agent;
    path: string;
    parentPath: string | null;
    entryType: "directory" | "file";
    activeView: BrowserView;
    /** Forwards the content-tab label so file chrome matches the editable gate. */
    editable?: boolean;
    /** What the Git tab names, or null to hide it outside a worktree. */
    gitHead: GitTabHead | null;
    pathUnavailable?: boolean;
    startEditingPath?: boolean;
    /** Shown under the breadcrumbs, such as the banner of a browsed Git revision. */
    banner?: React.ReactNode;
    /** Hides views that change files, for read-only history browsing. */
    readOnly?: boolean;
}) {
    const navigate = useNavigate();
    const pathUnavailable = props.pathUnavailable === true;

    /** Returns alternate directory views to the list before moving to the parent. */
    const goUp = () => {
        if (
            props.entryType === "directory" &&
            props.activeView !== "files" &&
            !pathUnavailable
        ) {
            void navigate({
                ...browserRoute(props.agent, props.path),
                search: {},
            });

            return;
        }

        if (props.parentPath === null) {
            return false;
        }

        void navigate(browserRoute(props.agent, props.parentPath));
    };

    useShortcut({
        name: "browser-go-up",
        phase: "bubble",
        priority: shortcutPriority.view,
        skipTypingTargets: true,
        match: (event) => isPlainKey(event, "Backspace", { allowShift: true }),
        run: goUp,
    });

    return (
        <BrowserPageHeader
            agent={props.agent}
            path={props.path}
            startEditingPath={
                pathUnavailable && props.startEditingPath !== false
            }
            navigation={
                <IconLinkButton
                    {...browserRoute(props.agent, props.parentPath ?? "/")}
                    label="Go to the parent directory"
                    tooltip="Go to the parent directory (Backspace)"
                    variant="ghost"
                    size="lg"
                    disabled={props.parentPath === null}
                    className="disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent"
                >
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                </IconLinkButton>
            }
            banner={props.banner}
            viewToggle={
                pathUnavailable ? null : (
                    <ViewToggle
                        agent={props.agent}
                        path={props.path}
                        entryType={props.entryType}
                        activeView={props.activeView}
                        editable={props.editable}
                        gitHead={props.gitHead}
                        readOnly={props.readOnly}
                    />
                )
            }
        />
    );
}

/** Explains a path lookup failure without replacing the surrounding browser navigation. */
export function UnavailablePathState(props: {
    agent: Agent;
    path: string;
    parentPath: string | null;
    error: PathLoadError;
}) {
    const title =
        props.error.type === "missing"
            ? "File or directory not found"
            : "Could not read file or directory";

    return (
        <section
            role="status"
            aria-labelledby="unavailable-path-title"
            className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-6"
        >
            <div className="flex items-start gap-3">
                <Info
                    className="mt-0.5 h-5 w-5 shrink-0 text-amber-400"
                    aria-hidden="true"
                />
                <div className="min-w-0">
                    <h1
                        id="unavailable-path-title"
                        className="font-semibold text-slate-100"
                    >
                        {title}
                    </h1>
                    <p className="mt-1 wrap-break-word text-sm text-slate-300">
                        {props.error.message}
                    </p>
                    <p className="mt-2 break-all font-mono text-xs text-slate-500">
                        {props.path}
                    </p>
                </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
                <Button
                    type="button"
                    onClick={() => window.history.back()}
                    size="sm"
                    className="rounded-md"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Go back
                </Button>
                {props.parentPath ? (
                    <Link
                        {...browserRoute(props.agent, props.parentPath)}
                        className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-tint"
                    >
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                        Open parent directory
                    </Link>
                ) : null}
            </div>
        </section>
    );
}
