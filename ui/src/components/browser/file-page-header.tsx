import React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUp, File, GitCompareArrows, Info, RefreshCw } from "lucide-react";
import type { Agent } from "#ui/api-client";
import { Tooltip } from "#ui/components/tooltip";
import {
    BrowserPageHeader,
    ViewSwitch,
    getViewSwitchItemClass,
} from "#ui/components/browser/navigation";
import { PersistentPathActions } from "#ui/components/browser/path-actions";
import {
    getBrowserPathHref,
    getImmediateParentPath,
} from "#ui/components/browser/utils";
import { shouldIgnoreKeyboardShortcut } from "#ui/utils/keyboard";

/** Keeps parent navigation and both file representations identical across views. */
function FileViewNavigation(props: {
    agent: Agent;
    path: string;
    parentPath: string | null;
    activeView: "details" | "view" | "diff" | "sync";
}) {
    return (
        <>
            <Tooltip content="Go to the parent directory (Backspace)">
                <Link
                    to={getBrowserPathHref(
                        props.agent,
                        props.parentPath ?? "/",
                    )}
                    className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
                >
                    <ArrowUp className="h-4 w-4" />
                    Up
                </Link>
            </Tooltip>
            <ViewSwitch label="File view">
                <Link
                    to={getBrowserPathHref(props.agent, props.path)}
                    search={{}}
                    aria-current={
                        props.activeView === "details" ? "page" : undefined
                    }
                    className={getViewSwitchItemClass(
                        props.activeView === "details",
                    )}
                >
                    <Info className="h-4 w-4" />
                    Details
                </Link>
                <Link
                    to={getBrowserPathHref(props.agent, props.path)}
                    search={{ view: "edit" }}
                    aria-current={
                        props.activeView === "view" ? "page" : undefined
                    }
                    className={getViewSwitchItemClass(
                        props.activeView === "view",
                    )}
                >
                    <File className="h-4 w-4" />
                    View
                </Link>
                <Link
                    to={getBrowserPathHref(props.agent, props.path)}
                    search={{ view: "diff" }}
                    aria-current={
                        props.activeView === "diff" ? "page" : undefined
                    }
                    className={getViewSwitchItemClass(
                        props.activeView === "diff",
                    )}
                >
                    <GitCompareArrows className="h-4 w-4" />
                    Diff
                </Link>
                <Link
                    to={getBrowserPathHref(props.agent, props.path)}
                    search={{ view: "sync" }}
                    aria-current={
                        props.activeView === "sync" ? "page" : undefined
                    }
                    className={getViewSwitchItemClass(
                        props.activeView === "sync",
                    )}
                >
                    <RefreshCw className="h-4 w-4" />
                    Sync
                </Link>
            </ViewSwitch>
        </>
    );
}

/** Keeps file navigation and object actions identical across its representations. */
export function FilePageHeader(props: {
    agent: Agent;
    agentId: string;
    path: string;
    fileName: string;
    downloadUrl: string;
    activeView: "details" | "view" | "diff" | "sync";
}) {
    const navigate = useNavigate();
    const parentPath = getImmediateParentPath(props.path);

    React.useEffect(() => {
        /** Returns every file representation to its containing directory. */
        const handleBackspace = (event: KeyboardEvent) => {
            if (
                event.key !== "Backspace" ||
                shouldIgnoreKeyboardShortcut(event) ||
                parentPath === null
            ) {
                return;
            }

            event.preventDefault();
            void navigate({ to: props.agent.getBrowserUrl(parentPath) });
        };

        window.addEventListener("keydown", handleBackspace);
        return () => window.removeEventListener("keydown", handleBackspace);
    }, [navigate, parentPath, props.agent]);

    return (
        <BrowserPageHeader
            agent={props.agent}
            agentId={props.agentId}
            path={props.path}
            actionLabel="File actions"
            navigation={
                <FileViewNavigation
                    agent={props.agent}
                    path={props.path}
                    parentPath={parentPath}
                    activeView={props.activeView}
                />
            }
            actions={
                <PersistentPathActions
                    agent={props.agent}
                    path={props.path}
                    currentName={props.fileName}
                    entryType="file"
                    view={
                        props.activeView === "view"
                            ? "edit"
                            : props.activeView === "diff"
                              ? "diff"
                              : props.activeView === "sync"
                                ? "sync"
                                : undefined
                    }
                    downloadUrl={props.downloadUrl}
                    downloadName={props.fileName}
                />
            }
        />
    );
}
