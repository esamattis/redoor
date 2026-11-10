import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import { FileCheck2, FilePlus2 } from "lucide-react";

import { browserRoute } from "#ui/browser-route";
import { getImmediateParentPath } from "#ui/components/browser/utils";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { IconButton } from "#ui/components/icon-button";
import { editorBufferQueryOptions } from "#ui/editor/stored-buffer";
import { queryKeys } from "#ui/queries";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { useAgents } from "#ui/use-agents";
import { useBrowserLocation } from "#ui/use-browser-location";
import {
    getOpenFileKey,
    isFileOpen,
    openFile,
    openFileAtLine,
    useUserState,
    type OpenFile,
} from "#ui/user-state";
import { cn } from "#ui/utils/cn";
import { getErrorMessage } from "#ui/utils/error";
import {
    isTerminalInputTarget,
    isTextEntryElement,
    isUnmodifiedAltKey,
} from "#ui/utils/keyboard";

const rootRouteApi = getRouteApi("__root__");

/**
 * Opens the file without leaving it. The editor calls it on the first edit, so unsaved text
 * is kept and listed without a click, and on a double click, which is how a file is kept
 * open before it has been changed.
 */
export function useKeepFileOpen(props: { file: OpenFile }) {
    const [, setUserState] = useUserState();
    const file = props.file;

    return React.useCallback(() => {
        setUserState((current) => {
            const openFiles = openFile(current.openFiles, file);

            if (openFiles === current.openFiles) {
                return current;
            }

            return { ...current, openFiles };
        });
    }, [file, setUserState]);
}

/**
 * Closes open files, asking first when one of them has unsaved edits, since closing
 * discards its buffer. A file not visited since the page loaded has no buffer in memory, so
 * its stored copy is read to know. Closing the file on screen goes to its directory, so
 * the page no longer shows a file that is not open. Returns the confirmation dialog for the
 * caller to render.
 */
export function useCloseOpenFiles() {
    const { api, editor } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const [, setUserState] = useUserState();
    const [pending, setPending] = React.useState<OpenFile[] | null>(null);
    const browser = useBrowserLocation();
    const agents = useAgents();
    const navigate = useNavigate();

    /** Shows the directory of the closed file on screen, if one of the files is shown. */
    const leaveClosedFile = (files: OpenFile[]) => {
        const shown = files.find(
            (file) =>
                browser?.agentId === file.agentId &&
                browser.path === file.path &&
                browser.revision === null,
        );

        const agent =
            shown === undefined
                ? undefined
                : agents.find((candidate) => candidate.id === shown.agentId);

        if (shown === undefined || agent === undefined) {
            return;
        }

        void navigate(
            browserRoute(agent, getImmediateParentPath(shown.path) ?? "/"),
        );
    };

    const close = (files: OpenFile[]) => {
        for (const file of files) {
            const key = getOpenFileKey(file);
            editor.close(key);
            queryClient.removeQueries({
                queryKey: queryKeys.editorBuffer(key),
            });
        }

        const closedKeys = new Set(files.map((file) => getOpenFileKey(file)));

        // The server deletes the buffers of files the new list no longer has.
        setUserState((current) => ({
            ...current,
            openFiles: current.openFiles.filter(
                (file) => !closedKeys.has(getOpenFileKey(file)),
            ),
        }));

        leaveClosedFile(files);
    };

    const checkMutation = useMutation({
        mutationFn: async (files: OpenFile[]) => {
            const dirty = await Promise.all(
                files.map(async (file) => {
                    const key = getOpenFileKey(file);
                    const loaded = editor.isDirty(key);

                    if (loaded !== undefined) {
                        return loaded;
                    }

                    const stored = await queryClient.fetchQuery(
                        editorBufferQueryOptions(api, key),
                    );

                    return stored?.data.dirty === true;
                }),
            );

            return { files, anyDirty: dirty.includes(true) };
        },
        onSuccess: (result) => {
            if (result.anyDirty) {
                setPending(result.files);
            } else {
                close(result.files);
            }
        },
    });

    const names = pending?.map((file) => file.name).join(", ") ?? "";

    const dialog = (
        <>
            <ConfirmationDialog
                isOpen={pending !== null}
                title="Discard unsaved changes?"
                description={
                    pending !== null && pending.length > 1
                        ? `Some of the open files have unsaved changes. Closing them discards those changes.`
                        : `${names} has unsaved changes. Closing it discards them.`
                }
                confirmLabel="Discard changes"
                onClose={() => setPending(null)}
                onConfirm={() => {
                    if (pending !== null) {
                        close(pending);
                    }

                    setPending(null);
                }}
            />
            <ConfirmationDialog
                isOpen={checkMutation.isError}
                title="Could not close the file"
                description={getErrorMessage(
                    checkMutation.error,
                    "Could not check the file for unsaved changes",
                )}
                confirmLabel="Close anyway"
                onClose={() => checkMutation.reset()}
                onConfirm={() => {
                    const files = checkMutation.variables;
                    checkMutation.reset();

                    if (files !== undefined) {
                        close(files);
                    }
                }}
            />
        </>
    );

    return {
        requestClose: (files: OpenFile[]) => checkMutation.mutate(files),
        dialog,
    };
}

/**
 * Reads which way an open-files shortcut moves through the list: Alt (Option) with j or the
 * down arrow goes to the next file, with k or the up arrow to the previous one, matching the
 * list's top-to-bottom order. Returns null for any other key.
 */
function openFileStep(event: KeyboardEvent): 1 | -1 | null {
    if (isUnmodifiedAltKey(event, "j")) {
        return 1;
    }

    if (isUnmodifiedAltKey(event, "k")) {
        return -1;
    }

    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return null;
    }

    if (event.key === "ArrowDown") {
        return 1;
    }

    return event.key === "ArrowUp" ? -1 : null;
}

/**
 * Moves between the open files with Alt (Option on macOS) and j/k or the arrow keys, and
 * closes the file on screen with Alt+w, which goes to its directory, so the working set can
 * be handled without reaching for the sidebar. The editor of the file moved to gets focus, so typing can go on at once,
 * except when the file opens in its preview. The keys run in the editor's capture tier and
 * are swallowed, because the editor itself would otherwise move lines with Alt+arrows. Text
 * fields keep them for their own caret movement and the terminal keeps them for the shell's
 * meta bindings. Files on unavailable devices cannot be shown, so they are skipped, and the
 * list wraps around at either end. Returns the unsaved-changes dialog for the caller to
 * render.
 */
export function useOpenFileShortcuts() {
    const { editor } = rootRouteApi.useRouteContext();
    const [userState] = useUserState();
    const agents = useAgents();
    const browser = useBrowserLocation();
    const router = useRouter();
    const closer = useCloseOpenFiles();
    // The file this shortcut last went to and the location it navigated to. The browser
    // location only follows once the route's loader finishes, so a quick second press would
    // otherwise still count from the file before and land on the same file again.
    const lastTarget = React.useRef<{ key: string; href: string } | null>(null);
    const openFiles = userState.openFiles;
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

    /** Finds the open file on screen, or -1 when the page shows none of them. */
    const activeIndex = () => {
        const pendingKey =
            lastTarget.current?.href === router.state.location.href
                ? lastTarget.current.key
                : null;

        return openFiles.findIndex((file) =>
            pendingKey === null
                ? browser?.agentId === file.agentId &&
                  browser.path === file.path &&
                  browser.revision === null
                : getOpenFileKey(file) === pendingKey,
        );
    };

    /** Shows a file whose device is available, and reports whether it could. */
    const goTo = (file: OpenFile | undefined) => {
        const agent =
            file === undefined ? undefined : agentsById.get(file.agentId);

        // An offline device cannot show the file, so switching to it would only show an error.
        if (file === undefined || agent?.status !== "connected") {
            return false;
        }

        const target = {
            ...browserRoute(agent, file.path),
            // Like the sidebar link: the working file, not the revision being browsed.
            search: { rev: undefined },
        };

        const key = getOpenFileKey(file);
        lastTarget.current = { key, href: router.buildLocation(target).href };
        // Keeps the keyboard in the editor, unless the file opens in its preview.
        editor.requestFocus(key);
        void router.navigate(target);

        return true;
    };

    const isShortcutTarget = (event: KeyboardEvent) =>
        !isTextEntryElement(event.target) &&
        !isTerminalInputTarget(event.target);

    useShortcut({
        name: "cycle-open-files",
        phase: "capture",
        priority: shortcutPriority.editor,
        effect: "swallow",
        match: (event) =>
            openFileStep(event) !== null && isShortcutTarget(event),
        run: (event) => {
            const step = openFileStep(event);
            const count = openFiles.length;

            if (step === null || count === 0) {
                return false;
            }

            const active = activeIndex();
            // Outside the list, the next file is the first and the previous one the last.
            const fallbackIndex = step === 1 ? count - 1 : 0;
            const startIndex = active === -1 ? fallbackIndex : active;

            for (let offset = 1; offset <= count; offset += 1) {
                const index = (startIndex + step * offset + count * 2) % count;

                if (index !== active && goTo(openFiles[index])) {
                    return;
                }
            }

            // Nothing else to switch to. The key is still taken, so Alt+arrows never fall
            // through to the editor's line moving just because the list is short.
        },
    });

    useShortcut({
        name: "close-open-file",
        phase: "capture",
        priority: shortcutPriority.editor,
        effect: "swallow",
        match: (event) =>
            isUnmodifiedAltKey(event, "w") && isShortcutTarget(event),
        run: () => {
            const active = activeIndex();
            const file = openFiles[active];

            if (file === undefined) {
                return false;
            }

            closer.requestClose([file]);
        },
    });

    return closer.dialog;
}

/**
 * Names one line request. `crypto.randomUUID` needs a secure context, which a device reached
 * over plain HTTP on a LAN is not; the id only has to differ from the previous request.
 */
function createRevealId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Whether a file is open and how to open it, at a line, without going to it. */
export type BackgroundOpen = {
    fileName: string;
    isOpen: boolean;
    open: (line?: number) => void;
};

/**
 * Opens a file from a diff or search result while the reader stays where they are, so they
 * can collect several files to work on later. A line is selected and centered the next time
 * the file is shown. Pass null for a result without a working file to open.
 */
export function useBackgroundOpen(
    file: OpenFile | null,
): BackgroundOpen | null {
    const [userState, setUserState] = useUserState();
    const isOpen = file !== null && isFileOpen(userState.openFiles, file);

    const open = React.useCallback(
        (line?: number) => {
            if (file === null) {
                return;
            }

            const reveal =
                line === undefined ? undefined : { line, id: createRevealId() };

            setUserState((current) => {
                const openFiles = openFileAtLine(
                    current.openFiles,
                    file,
                    reveal,
                );

                if (openFiles === current.openFiles) {
                    return current;
                }

                return { ...current, openFiles };
            });
        },
        [file, setUserState],
    );

    // Diff rows are memoized, so they get the same object until something they show changes.
    return React.useMemo(
        () => (file === null ? null : { fileName: file.name, isOpen, open }),
        [file, isOpen, open],
    );
}

/**
 * A small icon button that opens a file without leaving the page. Its icon and a tinted chip
 * show whether the file is already open; an open file can still be sent to another line, while
 * opening one that is already open without a line would do nothing, so it says so instead.
 */
export function OpenInBackgroundButton(props: {
    target: BackgroundOpen;
    /** The line to show when the file is visited, for results that point at one. */
    line?: number;
    className?: string;
}) {
    const name = props.target.fileName;
    const line = props.line;
    const isOpen = props.target.isOpen;
    const atLine = line === undefined ? "" : ` at line ${String(line)}`;

    const label = isOpen
        ? line === undefined
            ? `${name} is open`
            : `Show line ${String(line)} when ${name} is visited`
        : `Open ${name}${atLine} in the background`;

    const tooltip = isOpen
        ? line === undefined
            ? `${name} is already in the open files`
            : `${name} is already open. Click to show line ${String(line)} the next time it is visited`
        : `Add ${name} to the open files${atLine} without leaving this page`;

    const Icon = isOpen ? FileCheck2 : FilePlus2;

    return (
        <IconButton
            type="button"
            variant="ghost"
            size="xs"
            label={label}
            tooltip={tooltip}
            aria-disabled={isOpen && line === undefined ? true : undefined}
            onClick={() => {
                if (isOpen && line === undefined) {
                    return;
                }

                props.target.open(line);
            }}
            className={cn(
                "shrink-0",
                // A tinted, outlined chip rather than a color shift alone, so an open file
                // stands out from a closed one when scanning a long list of rows.
                isOpen &&
                    "bg-blue-500/15 text-blue-300 ring-1 ring-blue-500/50 ring-inset hover:bg-blue-500/25 hover:text-blue-200",
                props.className,
            )}
        >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
    );
}
