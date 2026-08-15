import React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUp } from "lucide-react";
import type { Agent } from "#ui/api-client";
import { Tooltip } from "#ui/components/tooltip";
import {
    BrowserPageHeader,
    ViewToggle,
} from "#ui/components/browser/navigation";
import {
    getBrowserPathHref,
    getImmediateParentPath,
} from "#ui/components/browser/utils";
import { shouldIgnoreKeyboardShortcut } from "#ui/utils/keyboard";

/** Keeps parent navigation identical across every file representation. */
function FileViewNavigation(props: {
    agent: Agent;
    parentPath: string | null;
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
        </>
    );
}

/** Keeps file navigation and object actions identical across its representations. */
export function FilePageHeader(props: {
    agent: Agent;
    agentId: string;
    path: string;
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
            navigation={
                <FileViewNavigation
                    agent={props.agent}
                    parentPath={parentPath}
                />
            }
            viewToggle={
                <ViewToggle
                    agent={props.agent}
                    path={props.path}
                    entryType="file"
                    activeView={props.activeView}
                />
            }
        />
    );
}
