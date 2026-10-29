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
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { PathBreadcrumbs } from "#ui/components/path-breadcrumbs";
import { Tooltip } from "#ui/components/tooltip";
import { SearchButton } from "#ui/components/search-button";
import type { PathLoadError } from "#ui/components/browser/utils";
import { browserRoute } from "#ui/browser-route";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { isPlainKey } from "#ui/utils/keyboard";

/** Names the representations of a path that the view tabs switch between. */
export type BrowserView = "files" | "details" | "view" | "sync" | "git";

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

    return (
        <header>
            <div className="mb-3 min-w-0 overflow-x-auto overscroll-x-contain">
                <div className="flex w-max min-w-full items-center gap-3">
                    <Tooltip content="Open device home directory">
                        <Link
                            {...browserRoute(
                                props.agent,
                                props.agent.cwd ?? "/",
                            )}
                            aria-label="Device home"
                            className="inline-flex shrink-0 items-center rounded-md p-1.5 text-slate-400 transition-colors hover:bg-tint hover:text-slate-100"
                        >
                            <Home className="h-4 w-4" aria-hidden="true" />
                        </Link>
                    </Tooltip>
                    <SearchButton
                        size="sm"
                        className="shrink-0 [&_svg]:h-4 [&_svg]:w-4"
                    />
                    {props.navigation}
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
            </div>
            {props.banner ? <div className="mb-3">{props.banner}</div> : null}
            {props.viewToggle ? (
                <div className="-mx-2 min-w-0 overflow-x-auto overscroll-x-contain border-b border-slate-800 px-2 @4xl:-mx-4 @4xl:px-4">
                    {props.viewToggle}
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
    gitAvailable: boolean;
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
            {props.gitAvailable ? (
                <ViewToggleLink
                    agent={props.agent}
                    path={props.path}
                    view="git"
                    label="Git"
                    icon={<GitBranch className="h-4 w-4" aria-hidden="true" />}
                    active={props.activeView === "git"}
                />
            ) : null}
        </ViewSwitch>
    );
}

/** Applies current-page semantics to a filesystem representation link. */
function ViewToggleLink(props: {
    agent: Agent;
    path: string;
    /** Leaves the default representation, the listing or content, when omitted. */
    view?: "details" | "sync" | "git";
    label: string;
    icon: React.ReactNode;
    active: boolean;
}) {
    return (
        <Link
            {...browserRoute(props.agent, props.path)}
            search={{ view: props.view }}
            aria-current={props.active ? "page" : undefined}
            className={getPageViewTabClass(props.active)}
        >
            {props.icon}
            {props.label}
        </Link>
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
            ? "top-tab-strip flex w-full min-w-0 items-stretch gap-0 overflow-x-auto overscroll-x-contain"
            : "top-tab-strip flex w-full min-w-0 items-end gap-1 overflow-x-auto overscroll-x-contain";

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

    return isActive
        ? `${baseClass} border-slate-700 bg-surface-active text-slate-100 shadow-[0_-2px_0_0_rgb(59,130,246)_inset] [&_svg]:text-blue-400`
        : `${baseClass} border-transparent text-slate-400 hover:bg-tint hover:text-slate-100`;
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
    gitAvailable: boolean;
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
                <>
                    <Tooltip content="Go to the parent directory (Backspace)">
                        <Link
                            {...browserRoute(
                                props.agent,
                                props.parentPath ?? "/",
                            )}
                            aria-label="Go to the parent directory"
                            className="inline-flex items-center rounded-md p-2 text-slate-200 transition-colors hover:bg-tint hover:text-slate-100 disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent"
                            disabled={props.parentPath === null}
                        >
                            <ArrowUp className="h-4 w-4" aria-hidden="true" />
                        </Link>
                    </Tooltip>
                </>
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
                        gitAvailable={props.gitAvailable}
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
