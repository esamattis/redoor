import React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
    ArrowLeft,
    ArrowUp,
    Check,
    File,
    Files,
    GitCompareArrows,
    Home,
    Info,
    Pencil,
    RefreshCw,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
import { Tooltip } from "#ui/components/tooltip";
import {
    getBrowserPathHref,
    type PathLoadError,
} from "#ui/components/browser/utils";
import { shouldIgnoreKeyboardShortcut } from "#ui/utils/keyboard";

/** Keeps location, navigation, view state, and object actions in a stable frame. */
export function BrowserPageHeader(props: {
    agent: Agent;
    agentId: string;
    path: string;
    startEditingPath?: boolean;
    navigation: React.ReactNode;
    viewToggle: React.ReactNode;
}) {
    return (
        <header className="mb-4">
            <div className="mb-3 min-w-0 overflow-x-auto overscroll-x-contain">
                <div className="flex w-max min-w-full items-center gap-3">
                    <Tooltip content="Open agent home directory">
                        <Link
                            to={props.agent.getBrowserUrl(
                                props.agent.cwd ?? "/",
                            )}
                            aria-label="Agent home"
                            className="inline-flex shrink-0 items-center rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                        >
                            <Home className="h-4 w-4" aria-hidden="true" />
                        </Link>
                    </Tooltip>
                    {props.navigation}
                    <Breadcrumbs
                        agent={props.agent}
                        path={props.path}
                        startEditing={props.startEditingPath}
                    />
                </div>
            </div>
            <div className="mb-3 min-w-0 overflow-x-auto overscroll-x-contain border-b border-slate-800">
                {props.viewToggle}
            </div>
        </header>
    );
}

/** Keeps filesystem representations beside their path instead of in global navigation. */
export function ViewToggle(props: {
    agent: Agent;
    path: string;
    entryType: "directory" | "file";
    activeView: "files" | "details" | "view" | "diff" | "sync";
}) {
    const pathTarget = getBrowserPathHref(props.agent, props.path);
    if (props.entryType === "directory") {
        return (
            <ViewSwitch label="Directory view">
                <ViewToggleLink
                    to={pathTarget}
                    label="Files"
                    icon={<Files className="h-4 w-4" aria-hidden="true" />}
                    active={props.activeView === "files"}
                />
                <ViewToggleLink
                    to={pathTarget}
                    search={{ view: "details" }}
                    label="Details"
                    icon={<Info className="h-4 w-4" aria-hidden="true" />}
                    active={props.activeView === "details"}
                />
                <ViewToggleLink
                    to={pathTarget}
                    search={{ view: "sync" }}
                    label="Sync"
                    icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
                    active={props.activeView === "sync"}
                />
            </ViewSwitch>
        );
    }

    return (
        <ViewSwitch label="File view">
            <ViewToggleLink
                to={pathTarget}
                label="Details"
                icon={<Info className="h-4 w-4" aria-hidden="true" />}
                active={props.activeView === "details"}
            />
            <ViewToggleLink
                to={pathTarget}
                search={{ view: "edit" }}
                label="View"
                icon={<File className="h-4 w-4" aria-hidden="true" />}
                active={props.activeView === "view"}
            />
            <ViewToggleLink
                to={pathTarget}
                search={{ view: "diff" }}
                label="Diff"
                icon={
                    <GitCompareArrows className="h-4 w-4" aria-hidden="true" />
                }
                active={props.activeView === "diff"}
            />
            <ViewToggleLink
                to={pathTarget}
                search={{ view: "sync" }}
                label="Sync"
                icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
                active={props.activeView === "sync"}
            />
        </ViewSwitch>
    );
}

/** Applies current-page semantics to a filesystem representation link. */
function ViewToggleLink(props: {
    to: string;
    search?: Record<string, string>;
    label: string;
    icon: React.ReactNode;
    active: boolean;
}) {
    return (
        <Link
            to={props.to}
            search={props.search ?? {}}
            aria-current={props.active ? "page" : undefined}
            className={getViewSwitchItemClass(props.active)}
        >
            {props.icon}
            {props.label}
        </Link>
    );
}

/** Presents route-backed representations as a compact tab strip without changing link semantics. */
export function ViewSwitch(props: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div
            aria-label={props.label}
            className="top-tab-strip flex min-w-max items-end gap-1 overflow-x-auto overscroll-x-contain"
        >
            {props.children}
        </div>
    );
}

/** Recreates the raised active-tab treatment while retaining current-page semantics on links. */
export function getViewSwitchItemClass(isActive: boolean) {
    const baseClass =
        "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-lg border border-b-0 px-4 py-2 text-sm font-medium transition-colors";
    return isActive
        ? `${baseClass} border-slate-700 bg-[#161a23] text-slate-100 shadow-[0_-2px_0_0_rgb(59,130,246)_inset] [&_svg]:text-blue-400`
        : `${baseClass} border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-100`;
}

/** Separates location context, navigation, and directory actions by purpose. */
export function BrowserHeader(props: {
    agent: Agent;
    agentId: string;
    path: string;
    parentPath: string | null;
    entryType: "directory" | "file";
    activeView: "files" | "details" | "view" | "diff" | "sync";
    pathUnavailable?: boolean;
    startEditingPath?: boolean;
}) {
    const navigate = useNavigate();
    const pathUnavailable = props.pathUnavailable === true;

    React.useEffect(() => {
        /** Returns alternate directory views to the list before moving to the parent. */
        const handleBackspace = (event: KeyboardEvent) => {
            if (
                event.key !== "Backspace" ||
                shouldIgnoreKeyboardShortcut(event)
            ) {
                return;
            }

            if (
                props.entryType === "directory" &&
                props.activeView !== "files" &&
                !pathUnavailable
            ) {
                event.preventDefault();
                void navigate({
                    to: props.agent.getBrowserUrl(props.path),
                    search: {},
                });
                return;
            }
            if (props.parentPath === null) {
                return;
            }

            event.preventDefault();
            void navigate({ to: props.agent.getBrowserUrl(props.parentPath) });
        };

        window.addEventListener("keydown", handleBackspace);
        return () => window.removeEventListener("keydown", handleBackspace);
    }, [navigate, pathUnavailable, props]);

    return (
        <BrowserPageHeader
            agent={props.agent}
            agentId={props.agentId}
            path={props.path}
            startEditingPath={
                pathUnavailable && props.startEditingPath !== false
            }
            navigation={
                <>
                    <Tooltip content="Go to the parent directory (Backspace)">
                        <Link
                            to={
                                props.parentPath
                                    ? getBrowserPathHref(
                                          props.agent,
                                          props.parentPath,
                                      )
                                    : props.agent.getBrowserUrl("/")
                            }
                            className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent"
                            disabled={props.parentPath === null}
                        >
                            <ArrowUp className="h-4 w-4" />
                            Up
                        </Link>
                    </Tooltip>
                </>
            }
            viewToggle={
                <ViewToggle
                    agent={props.agent}
                    path={props.path}
                    entryType={props.entryType}
                    activeView={props.activeView}
                />
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
                <button
                    type="button"
                    onClick={() => window.history.back()}
                    className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Go back
                </button>
                {props.parentPath ? (
                    <Link
                        to={getBrowserPathHref(props.agent, props.parentPath)}
                        className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-white/5"
                    >
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                        Open parent directory
                    </Link>
                ) : null}
            </div>
        </section>
    );
}

/** Shows the current path as links while allowing direct path navigation. */
function Breadcrumbs(props: {
    agent: Agent;
    path: string;
    /** Opens the path editor immediately so a missing path can be corrected in place. */
    startEditing?: boolean;
}) {
    const navigate = useNavigate();
    const pathInputRef = React.useRef<HTMLInputElement>(null);
    const [isEditing, setIsEditing] = React.useState(
        props.startEditing === true,
    );
    const [editedPath, setEditedPath] = React.useState(props.path);

    const parts = props.path.split("/").filter((part) => part !== "");
    const isAtRoot = parts.length === 0;
    let accumulatedPath = "";

    // Keep the editor aligned with route changes, including missing-path landings.
    React.useEffect(() => {
        setEditedPath(props.path);
        if (props.startEditing) {
            setIsEditing(true);
        } else {
            setIsEditing(false);
        }
    }, [props.path, props.startEditing]);

    // Focus after paint so keyboard correction works immediately on missing paths.
    React.useEffect(() => {
        if (!isEditing) {
            return;
        }
        pathInputRef.current?.focus();
        pathInputRef.current?.select();
    }, [isEditing, props.path]);

    /** Opens the path editor with the current route path. */
    const startEditing = () => {
        setEditedPath(props.path);
        setIsEditing(true);
    };

    /** Navigates to the entered path, treating an empty or relative value helpfully. */
    const navigateToEditedPath = async (
        event: React.FormEvent<HTMLFormElement>,
    ) => {
        event.preventDefault();
        const targetPath =
            editedPath === ""
                ? "/"
                : editedPath.startsWith("/")
                  ? editedPath
                  : `/${editedPath}`;

        setIsEditing(false);
        if (targetPath === props.path) {
            return;
        }
        // Destination route decides whether the editor stays open (missing path).
        await navigate({
            to: props.agent.getBrowserUrl(targetPath),
        });
    };

    return (
        <div className="flex min-w-0 flex-1 items-center gap-1">
            {isEditing ? (
                <form
                    onSubmit={navigateToEditedPath}
                    className="flex min-w-0 flex-1 items-center gap-1"
                >
                    <input
                        ref={pathInputRef}
                        type="text"
                        value={editedPath}
                        onChange={(event) => setEditedPath(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                setIsEditing(false);
                            }
                        }}
                        aria-label="File path"
                        className="min-w-0 w-full flex-1 rounded-md border border-slate-600 bg-slate-950 px-2 py-1 font-mono text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                    />
                    <button
                        type="submit"
                        aria-label="Navigate to path"
                        className="shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                    >
                        <Check className="h-4 w-4" />
                    </button>
                </form>
            ) : (
                <>
                    <nav
                        aria-label="Breadcrumbs"
                        className="flex min-w-0 flex-1 items-center gap-2 text-sm"
                    >
                        {isAtRoot ? (
                            <span className="shrink-0 font-medium text-slate-100">
                                /
                            </span>
                        ) : (
                            <Link
                                to={props.agent.getBrowserUrl("/")}
                                className="shrink-0 text-blue-400 hover:underline"
                            >
                                /
                            </Link>
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
                                        <span className="text-slate-600">
                                            /
                                        </span>
                                    ) : null}
                                    {isLast ? (
                                        <span className="whitespace-nowrap font-medium text-slate-100">
                                            {part}
                                        </span>
                                    ) : (
                                        <Link
                                            to={props.agent.getBrowserUrl(
                                                accumulatedPath,
                                            )}
                                            className="whitespace-nowrap font-medium text-blue-400 hover:underline"
                                        >
                                            {part}
                                        </Link>
                                    )}
                                </div>
                            );
                        })}
                    </nav>
                    <button
                        type="button"
                        onClick={startEditing}
                        aria-label="Edit file path"
                        className="shrink-0 rounded-md p-1.5 text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-100"
                    >
                        <Pencil className="h-3.5 w-3.5" />
                    </button>
                </>
            )}
        </div>
    );
}
