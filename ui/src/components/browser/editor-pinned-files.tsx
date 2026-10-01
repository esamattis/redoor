import * as React from "react";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";

import { getBrowserUrl } from "#ui/api-client";
import { IconButton } from "#ui/components/icon-button";
import { SortableItem, SortableList } from "#ui/components/sortable-list";
import { Tooltip } from "#ui/components/tooltip";
import {
    getPinnedFileKey,
    reorderPinnedFiles,
    unpinFile,
    useUserState,
} from "#ui/user-state";

/** Keeps pinned destinations reachable when the full-window editor covers the sidebar. */
export function EditorPinnedFiles(props: {
    agentId: string;
    filePath: string;
}) {
    const [userState, setUserState] = useUserState();
    const listRef = React.useRef<HTMLElement>(null);
    if (userState.pinnedFiles.length === 0) {
        return null;
    }
    return (
        <SortableList
            itemIds={userState.pinnedFiles.map((file) =>
                getPinnedFileKey(file),
            )}
            orientation="horizontal"
            label="Editor pinned files"
            listRef={listRef}
            getItemLabel={(itemId) =>
                userState.pinnedFiles.find(
                    (file) => getPinnedFileKey(file) === itemId,
                )?.name ?? itemId
            }
            onMove={(move) => {
                setUserState((current) => {
                    const pinnedFiles = reorderPinnedFiles(
                        current.pinnedFiles,
                        move,
                    );
                    if (pinnedFiles === current.pinnedFiles) {
                        return current;
                    }
                    return { ...current, pinnedFiles };
                });
            }}
        >
            <nav
                ref={listRef}
                aria-label="Editor pinned files"
                className="shrink-0 overflow-x-auto border-b border-slate-800 px-3 py-2"
            >
                <ul className="flex w-max min-w-full items-center gap-2">
                    {userState.pinnedFiles.map((file) => (
                        <EditorPin
                            key={getPinnedFileKey(file)}
                            file={file}
                            isActive={
                                file.agentId === props.agentId &&
                                file.path === props.filePath
                            }
                            onClose={() => {
                                setUserState((current) => ({
                                    ...current,
                                    pinnedFiles: unpinFile(
                                        current.pinnedFiles,
                                        file,
                                    ),
                                }));
                            }}
                        />
                    ))}
                </ul>
            </nav>
        </SortableList>
    );
}

/** Leaves the open editor and its unsaved buffer intact when a pin is closed. */
function EditorPin(props: {
    file: {
        agentId: string;
        path: string;
        name: string;
        agentName: string;
    };
    isActive: boolean;
    onClose: () => void;
}) {
    return (
        <SortableItem id={getPinnedFileKey(props.file)}>
            {(item) => (
                <li
                    {...item.dragProps}
                    aria-label={`Pinned file ${props.file.name} on ${props.file.agentName}`}
                    ref={item.setNodeRef}
                    style={item.style}
                    className={`flex items-center rounded ${
                        item.isDragging ? "opacity-70" : ""
                    } ${
                        item.isOver && !item.isDragging
                            ? "ring-1 ring-blue-400/60"
                            : ""
                    } ${
                        props.isActive
                            ? "bg-white/10 text-slate-100"
                            : "text-slate-300 hover:bg-white/5 hover:text-slate-100"
                    }`}
                    onAuxClick={(event) => {
                        if (event.button === 1) {
                            // Suppress the link's new-tab action when middle-click closes a pin.
                            event.preventDefault();
                            props.onClose();
                        }
                    }}
                >
                    <Tooltip
                        content={`Open ${props.file.path} on ${props.file.agentName}`}
                    >
                        <Link
                            to={getBrowserUrl(
                                props.file.agentId,
                                props.file.path,
                            )}
                            aria-label={props.file.name}
                            aria-current={props.isActive ? "page" : undefined}
                            className="block px-3 py-1 text-sm whitespace-nowrap"
                        >
                            {props.file.name}
                        </Link>
                    </Tooltip>
                    <IconButton
                        type="button"
                        label={`Close pinned file ${props.file.name}`}
                        tooltip={`Unpin ${props.file.name}`}
                        onClick={props.onClose}
                        className="mr-1 shrink-0 rounded p-1 text-slate-500 hover:bg-white/10 hover:text-slate-200"
                    >
                        <X className="h-3 w-3" aria-hidden="true" />
                    </IconButton>
                </li>
            )}
        </SortableItem>
    );
}
