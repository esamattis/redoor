import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { Image as ImageIcon, X } from "lucide-react";
import type { Agent } from "#ui/api-client";
import type { GitContextResponse } from "#bindings/GitContextResponse";
import { shortcutPriority, useShortcut } from "#ui/shortcuts";
import { BrowserViewCard } from "#ui/components/browser-view-card";
import { ViewCardHeader } from "#ui/components/view-card-header";
import { Button } from "#ui/components/button";
import { useKeepFileOpen } from "#ui/components/browser/open-file-actions";
import {
    CodeEditor,
    type EditorSelection,
} from "#ui/components/browser/code-editor";
import type { EditorSearchHandle } from "#ui/components/browser/editor-search";
import { PersistentPathActions } from "#ui/components/browser/path-actions";
import { getErrorMessage } from "#ui/utils/error";
import { cn } from "#ui/utils/cn";
import { DeletePathDialog } from "#ui/components/browser/delete-path-dialog";
import { useEditorFullWindow } from "#ui/components/browser/editor-full-window";
import { IconButton } from "#ui/components/icon-button";
import {
    fileContentQueryOptions,
    gitFileBasesQueryOptions,
    gitRevisionContentQueryOptions,
} from "#ui/queries";
import { useEditorRefreshRegistration } from "#ui/components/browser/refresh";
import { openSideMenuAtom } from "#ui/side-menu-state";
import { isTerminalInputTarget } from "#ui/utils/keyboard";
import {
    getOpenFileKey,
    useUserState,
    type OpenFileReveal,
} from "#ui/user-state";
import {
    editorBufferQueryOptions,
    type StoredBuffer,
} from "#ui/editor/stored-buffer";
import {
    GIT_GUTTER_EMPTY,
    GIT_GUTTER_HIDDEN,
    gitGutterSource,
    type GitGutterSource,
} from "#ui/editor/git-gutter";
import { syntaxLanguageFromFileName } from "#ui/utils/editor-language";
import { MarkdownPreview } from "#ui/components/browser/markdown-preview";
import { FileEditHeader } from "#ui/components/browser/file-edit-toolbar";
import {
    useVaultFile,
    useVaultUnloadWarning,
    VaultFileBanners,
    VaultLockedPanel,
} from "#ui/components/browser/vault-file-editor";
import { vaultFileContentQueryOptions } from "#ui/vault/vault-files";
import { isVaultPath } from "#ui/vault/vault-path";

const rootRouteApi = getRouteApi("__root__");

/** Puts the editor exit on the rendered page so it stays with the markdown, not the toolbar. */
function CloseMarkdownPreviewButton(props: { onClose: () => void }) {
    return (
        <IconButton
            type="button"
            label="Close markdown preview"
            tooltip="Edit markdown"
            onClick={props.onClose}
            variant="ghost"
            size="lg"
            className="bg-surface/90 text-slate-300 hover:text-slate-50"
        >
            <X className="h-4 w-4" aria-hidden="true" />
        </IconButton>
    );
}

/**
 * The single owner of Mod-S, whether or not CodeMirror has focus, so the browser's save-page
 * dialog never opens over the editor. The capture phase runs before the editor's own handlers,
 * which is why CodeMirror needs no binding of its own. The terminal keeps its keystrokes.
 */
function useFileSaveShortcut(onSave: () => void) {
    useShortcut({
        name: "editor-save",
        phase: "capture",
        priority: shortcutPriority.editor,
        effect: "swallow",
        match: (event) =>
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            event.key === "s" &&
            !event.defaultPrevented &&
            !isTerminalInputTarget(event.target),
        run: onSave,
    });
}

/**
 * Warns that the device changed under unsaved browser edits. The browser version wins until
 * the user decides, so the device text is only loaded when they discard their changes;
 * keeping them dismisses the warning, and saving overwrites the device.
 */
function DeviceChangedBanner(props: {
    deviceName: string;
    onKeep: () => void;
    onDiscard: () => void;
}) {
    return (
        <div
            role="alert"
            aria-label="File changed on device"
            className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
        >
            <span>
                This file changed on {props.deviceName} after your unsaved edits
                started. Saving overwrites the device version.
            </span>
            <div className="flex gap-2">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    tooltip="Dismiss this warning and keep editing the browser version"
                    onClick={props.onKeep}
                >
                    Keep my changes
                </Button>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    tooltip="Throw away the unsaved browser changes and load the file from the device"
                    onClick={props.onDiscard}
                >
                    Discard my changes
                </Button>
            </div>
        </div>
    );
}

/** Selects the editor body without coupling its loading states to buffer ownership. */
function FileEditorSurface(props: {
    deviceName: string;
    filePath: string;
    repositoryRoot: string | null;
    isPending: boolean;
    error?: Error;
    bufferKey: string;
    deviceContent: string;
    stored: StoredBuffer | null;
    previewContent: string;
    fileName: string;
    editable: boolean;
    vimMode: boolean;
    wrapLines: boolean;
    preview: boolean;
    scrollToLine?: number;
    reveal?: OpenFileReveal;
    searchHandleRef: React.RefObject<EditorSearchHandle | null>;
    isSearchOpen: boolean;
    onSearchOpenChange: (open: boolean) => void;
    onBecameDirty: () => void;
    onDoubleClick?: () => void;
    onFocus: () => void;
    onSave: () => void;
    onSelectionChange: (selection: EditorSelection | null) => void;
    onClosePreview: () => void;
    gitGutter: GitGutterSource;
}) {
    if (props.isPending) {
        return <p className="p-4 text-sm text-slate-400">Loading file...</p>;
    }

    if (props.error !== undefined) {
        return (
            <p className="p-4 text-sm text-red-300">
                {getErrorMessage(props.error, "Failed to load file")}
            </p>
        );
    }

    return (
        <>
            <div
                aria-hidden={props.preview}
                className={props.preview ? "hidden" : "flex min-h-0 flex-1"}
            >
                <CodeEditor
                    bufferKey={props.bufferKey}
                    deviceContent={props.deviceContent}
                    stored={props.stored}
                    fileName={props.fileName}
                    editable={props.editable}
                    vimMode={props.vimMode}
                    wrapLines={props.wrapLines}
                    scrollToLine={props.scrollToLine}
                    reveal={props.reveal}
                    onBecameDirty={props.onBecameDirty}
                    onDoubleClick={props.onDoubleClick}
                    onFocus={props.onFocus}
                    onSave={props.onSave}
                    onSelectionChange={props.onSelectionChange}
                    searchHandleRef={props.searchHandleRef}
                    isSearchOpen={props.isSearchOpen}
                    onSearchOpenChange={props.onSearchOpenChange}
                    captureFindKeys={!props.preview}
                    gitGutter={props.gitGutter}
                />
            </div>
            <div
                aria-hidden={!props.preview}
                className={
                    props.preview ? "relative flex min-h-0 flex-1" : "hidden"
                }
            >
                <MarkdownPreview
                    content={props.previewContent}
                    deviceName={props.deviceName}
                    filePath={props.filePath}
                    repositoryRoot={props.repositoryRoot}
                />
                <div className="absolute top-0 right-1 z-10">
                    <CloseMarkdownPreviewButton
                        onClose={props.onClosePreview}
                    />
                </div>
            </div>
        </>
    );
}

/** Chooses the single editor status announced beside file actions. */
function getFileEditorStatus(props: {
    readOnly: boolean;
    isLoading: boolean;
    loadError?: Error;
    isSaving: boolean;
    isSaved: boolean;
    saveError?: Error;
    isDirty: boolean;
}): string | null {
    if (props.isLoading) return "Loading file...";

    if (props.loadError) {
        return getErrorMessage(props.loadError, "Failed to load file");
    }

    if (props.isSaving) return "Saving...";

    if (props.isSaved) return "Saved";

    if (props.saveError) {
        return getErrorMessage(props.saveError, "Failed to save file");
    }

    if (props.readOnly) return "Read-only revision";

    return props.isDirty ? "Unsaved changes" : null;
}

/** Makes file removal confirm draft loss for both trash and permanent deletion. */
function EditorDeleteDialog(props: {
    agent: Agent;
    filePath: string;
    fileName: string;
    isDirty: boolean;
    onClose: () => void;
}) {
    return (
        <DeletePathDialog
            agent={props.agent}
            path={props.filePath}
            name={props.fileName}
            entryType="file"
            leaveToParent
            onClose={props.onClose}
        >
            {props.isDirty ? (
                <p className="mt-3 text-sm text-amber-300">
                    Unsaved edits will be discarded if you remove this file.
                </p>
            ) : null}
        </DeletePathDialog>
    );
}

/**
 * Keeps editor route context explicit because previews need filesystem and repository paths.
 */
type FileEditViewProps = {
    agent: Agent;
    fileName: string;
    filePath: string;
    /**
     * Shows the file as committed at this Git revision instead of the working file. The
     * editor is then read-only and offers no save, reload or file operations.
     */
    revision?: string;
    repositoryRoot: string | null;
    mimeType: string;
    /** Absent when the shown content has no raw download, such as a Git revision. */
    downloadUrl: string | null;
    scrollToLine?: number;
    preview: boolean;
    onPreviewChange: (preview: boolean) => void;
    /**
     * Shows the Git gutter: the file is in a repository and Git does not ignore it. Known
     * from the route's Git context, so the gutter's space is there before its marks load.
     */
    showGitGutter?: boolean;
};

/**
 * Joins a file's device text, its server copy and its buffer in the editor workspace. The
 * buffer's document is the draft: dirty tracking and saving read it, so there is no second
 * copy of the text in React state.
 */
function useFileBuffer(props: FileEditViewProps) {
    const { api, editor } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const [userState] = useUserState();
    const readOnly = props.revision !== undefined;
    // Encrypted files never store their draft on the server; see `useVaultFile`.
    const isVault = !readOnly && isVaultPath(props.filePath);
    const fileQuery = fileContentQueryOptions(props.agent, props.filePath);
    const contentQuery = useEditorContentQuery(props);

    const vaultFile = useVaultFile({
        agent: props.agent,
        path: props.filePath,
        enabled: isVault,
    });

    // A revision is a read-only preview of other text, so it never shares the file's buffer.
    const bufferKey = readOnly
        ? `revision:${props.revision ?? ""}:${props.agent.id}:${props.filePath}`
        : getOpenFileKey({ agentId: props.agent.id, path: props.filePath });

    const storedQuery = useQuery({
        ...editorBufferQueryOptions(api, bufferKey),
        enabled: !readOnly && !isVault,
    });

    const statuses = React.useSyncExternalStore(
        editor.subscribe,
        editor.getSnapshot,
    );

    const status = statuses.get(bufferKey);
    const openFiles = userState.openFiles;

    // A revision's key never matches an open file, so it never takes the file's line request.
    const reveal = openFiles.find(
        (file) => getOpenFileKey(file) === bufferKey,
    )?.reveal;

    // Tells the workspace which buffers to keep and write, before the editor activates.
    React.useLayoutEffect(() => {
        editor.setOpenKeys(openFiles.map((file) => getOpenFileKey(file)));
    }, [editor, openFiles]);

    const saveMutation = useMutation({
        mutationFn: async (nextContent: string) => {
            if (isVault) {
                return {
                    nextContent,
                    revision: await vaultFile.save(nextContent),
                };
            }

            await props.agent.editFile(
                props.filePath,
                new globalThis.File([nextContent], props.fileName, {
                    type: props.mimeType || "text/plain",
                }),
            );

            return { nextContent, revision: null };
        },
        onSuccess: async (saved) => {
            // A read that started before the write would bring back the old text as if the
            // device had changed it, and a clean buffer would follow it.
            await queryClient.cancelQueries({ queryKey: fileQuery.queryKey });
            // The buffer learns its new base before the cache update reaches it as device text.
            editor.rebase(bufferKey, saved.nextContent);

            if (saved.revision === null) {
                queryClient.setQueryData(fileQuery.queryKey, saved.nextContent);
            } else {
                vaultFile.adopt(saved.nextContent, saved.revision);
            }
        },
    });

    return {
        editor,
        readOnly,
        bufferKey,
        reveal,
        contentQuery,
        storedQuery,
        saveMutation,
        isDirty: status?.isDirty === true,
        conflict: status?.conflict ?? null,
        // A failed server read must not keep the file from opening from the device.
        isStoredReady: readOnly || isVault || !storedQuery.isPending,
        isVault,
        vaultFile,
    };
}

/**
 * The editor props that follow from the route's Git context: the repository root for
 * Markdown links, and whether the file gets a Git gutter (in a worktree and not ignored).
 */
export function worktreeEditorProps(
    gitContext: GitContextResponse,
): Pick<FileEditViewProps, "repositoryRoot" | "showGitGutter"> {
    return gitContext.status === "inside_worktree"
        ? {
              repositoryRoot: gitContext.repository_root,
              showGitGutter: gitContext.tracking_state !== "ignored",
          }
        : { repositoryRoot: null, showGitGutter: false };
}

/**
 * Reads what the editor's Git gutter compares the buffer with. It is a background query, so
 * the file opens without waiting for Git, and its abort signal stops the agent's read when
 * the file is left. A failed or not yet answered read leaves the gutter empty.
 */
function useGitGutterSource(props: {
    agent: Agent;
    filePath: string;
    enabled: boolean;
}): GitGutterSource {
    const basesQuery = useQuery({
        ...gitFileBasesQueryOptions(props.agent, props.filePath),
        enabled: props.enabled,
    });

    const data = basesQuery.data;

    // The marks are recomputed whenever the source changes identity, so it only changes
    // with the answer.
    return React.useMemo(() => {
        if (!props.enabled) {
            return GIT_GUTTER_HIDDEN;
        }

        return data === undefined ? GIT_GUTTER_EMPTY : gitGutterSource(data);
    }, [data, props.enabled]);
}

/**
 * Dismisses the open files panel once the editor's full-window overlay leaves, because the
 * persistent sidebar returns and the drawer would otherwise sit redundantly on top of it.
 */
function useCloseOpenFilesPanelOnFullWindowExit(isFullWindow: boolean) {
    const [openMenu, setOpenMenu] = useAtom(openSideMenuAtom);
    const wasFullWindow = React.useRef(isFullWindow);

    React.useEffect(() => {
        if (
            wasFullWindow.current &&
            !isFullWindow &&
            openMenu === "application"
        ) {
            setOpenMenu(null);
        }

        wasFullWindow.current = isFullWindow;
    }, [isFullWindow, openMenu, setOpenMenu]);
}

/**
 * The warnings above the editor: an encrypted file's key and save conflicts, or a plain
 * file that changed on the device under unsaved edits.
 */
function FileEditBanners(props: {
    agent: Agent;
    filePath: string;
    buffer: ReturnType<typeof useFileBuffer>;
    onSave: () => void;
}) {
    const buffer = props.buffer;

    return (
        <>
            {buffer.isVault ? (
                <VaultFileBanners
                    agent={props.agent}
                    path={props.filePath}
                    deviceName={props.agent.name}
                    vaultFile={buffer.vaultFile}
                    onOverwrite={() => {
                        buffer.vaultFile.allowOverwrite();
                        props.onSave();
                    }}
                    onDiscard={(content) =>
                        buffer.editor.discard(buffer.bufferKey, content)
                    }
                />
            ) : null}
            {buffer.conflict === null ? null : (
                <DeviceChangedBanner
                    deviceName={props.agent.name}
                    onKeep={() => {
                        if (buffer.conflict !== null) {
                            buffer.editor.rebase(
                                buffer.bufferKey,
                                buffer.conflict,
                            );
                        }
                    }}
                    onDiscard={() => {
                        if (buffer.conflict !== null) {
                            buffer.editor.discard(
                                buffer.bufferKey,
                                buffer.conflict,
                            );
                        }
                    }}
                />
            )}
        </>
    );
}

/**
 * Edits file contents in a viewport-bounded CodeMirror with explicit save and reload.
 * scrollToLine is inbound-only so a ?line= URL can move the caret without writing back.
 * There is no unsaved-changes prompt on leaving: an edited file is open, and its buffer is
 * kept on the server until the file is closed from the open files list.
 */
export function FileEditView(props: FileEditViewProps) {
    const [deleteConfirmationOpen, setDeleteConfirmationOpen] =
        React.useState(false);

    const fullWindow = useEditorFullWindow();
    useCloseOpenFilesPanelOnFullWindowExit(fullWindow.isFullWindow);

    const [userState] = useUserState();
    const buffer = useFileBuffer(props);

    const gitGutter = useGitGutterSource({
        agent: props.agent,
        filePath: props.filePath,
        // A revision is committed text, which has no uncommitted changes to mark.
        enabled: props.showGitGutter === true && !buffer.readOnly,
    });

    const contentQuery = buffer.contentQuery;
    const saveMutation = buffer.saveMutation;
    const isDirty = buffer.isDirty;

    const [selection, setSelection] = React.useState<EditorSelection | null>(
        null,
    );

    const [isSearchOpen, setIsSearchOpen] = React.useState(false);
    const searchHandleRef = React.useRef<EditorSearchHandle | null>(null);
    const reloadPromiseRef = React.useRef<Promise<unknown> | null>(null);
    const isSavingRef = React.useRef(false);

    // Viewing a file does not open it; the first change away from the device text or a double
    // click in the editor does.
    const keepOpen = useKeepFileOpen({
        file: {
            agentId: props.agent.id,
            path: props.filePath,
            name: props.fileName,
            agentName: props.agent.name,
        },
    });

    // Saving must not flip CodeMirror read-only, or Mod-s and :w steal editor focus.
    const canEdit = contentQuery.isSuccess && !buffer.readOnly;

    const isMarkdown =
        syntaxLanguageFromFileName(props.fileName) === "markdown";

    const isPreviewShown = isMarkdown && props.preview;

    const previewContent = React.useSyncExternalStore(
        buffer.editor.subscribeDocument,
        () => (isPreviewShown ? buffer.editor.text(buffer.bufferKey) : ""),
    );

    useEditorRefreshRegistration({
        agentId: props.agent.id,
        path: props.filePath,
    });

    // Fetches the device text and the server copy. Neither replaces unsaved edits: a dirty
    // buffer only reports a conflict, and a newer server copy is adopted only when clean.
    const reloadFile = React.useCallback(() => {
        // `:w` refocuses the editor in the same tick it starts saving, before isPending renders.
        if (
            !canEdit ||
            saveMutation.isPending ||
            isSavingRef.current ||
            reloadPromiseRef.current
        ) {
            return;
        }

        const reloadPromise = Promise.all([
            contentQuery.refetch({ cancelRefetch: false }),
            buffer.storedQuery.refetch({ cancelRefetch: false }),
        ]).finally(() => {
            reloadPromiseRef.current = null;
        });

        reloadPromiseRef.current = reloadPromise;
    }, [buffer.storedQuery, canEdit, contentQuery, saveMutation.isPending]);

    const handleSave = React.useCallback(() => {
        if (!canEdit || saveMutation.isPending || !isDirty) {
            return;
        }

        isSavingRef.current = true;
        saveMutation.mutate(buffer.editor.text(buffer.bufferKey), {
            onSettled: () => {
                isSavingRef.current = false;
            },
        });
    }, [buffer.bufferKey, buffer.editor, canEdit, isDirty, saveMutation]);

    useFileSaveShortcut(handleSave);
    useVaultUnloadWarning(buffer.isVault && isDirty);

    const statusMessage = getFileEditorStatus({
        readOnly: buffer.readOnly,
        isLoading: contentQuery.isPending,
        loadError: contentQuery.isError ? contentQuery.error : undefined,
        isSaving: saveMutation.isPending,
        isSaved: saveMutation.isSuccess && !isDirty,
        saveError: saveMutation.isError ? saveMutation.error : undefined,
        isDirty,
    });

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <article
                aria-label="Editing panel"
                data-editor-full-window={fullWindow.isFullWindow}
                // Fixed positioning bypasses the page padding, so reserve the measured drawer height here too.
                className={cn(
                    "flex min-h-0 flex-1 flex-col overflow-hidden bg-surface shadow-2xl shadow-black/20",
                    fullWindow.isFullWindow &&
                        "fixed inset-x-0 top-0 bottom-[var(--bottom-chrome-height,0px)] z-[60]",
                )}
            >
                <FileEditHeader
                    readOnly={buffer.readOnly}
                    fileName={props.fileName}
                    statusMessage={statusMessage}
                    hasError={contentQuery.isError || saveMutation.isError}
                    isSaved={saveMutation.isSuccess && !isDirty}
                    canEdit={canEdit}
                    isDirty={isDirty}
                    isSaving={saveMutation.isPending}
                    agent={props.agent}
                    filePath={props.filePath}
                    selection={selection}
                    preview={isMarkdown ? props.preview : undefined}
                    isSearchOpen={isSearchOpen}
                    isReloading={contentQuery.isFetching}
                    downloadUrl={props.downloadUrl}
                    isFullWindow={fullWindow.isFullWindow}
                    onSave={handleSave}
                    onToggleSearch={() => {
                        if (!searchHandleRef.current?.close()) {
                            searchHandleRef.current?.open();
                        }
                    }}
                    onPreviewChange={
                        isMarkdown ? props.onPreviewChange : undefined
                    }
                    onToggleFullWindow={fullWindow.toggle}
                    onReload={reloadFile}
                    onDelete={() => setDeleteConfirmationOpen(true)}
                />
                <FileEditBanners
                    agent={props.agent}
                    filePath={props.filePath}
                    buffer={buffer}
                    onSave={handleSave}
                />

                <div className="flex min-h-0 flex-1 flex-col">
                    {buffer.vaultFile.isLocked ? (
                        <VaultLockedPanel
                            fileName={props.fileName}
                            onUnlock={buffer.vaultFile.unlock}
                        />
                    ) : (
                        <FileEditorSurface
                            deviceName={props.agent.name}
                            filePath={props.filePath}
                            repositoryRoot={props.repositoryRoot}
                            isPending={
                                contentQuery.isPending || !buffer.isStoredReady
                            }
                            error={
                                contentQuery.isError
                                    ? contentQuery.error
                                    : undefined
                            }
                            bufferKey={buffer.bufferKey}
                            deviceContent={contentQuery.data ?? ""}
                            stored={buffer.storedQuery.data ?? null}
                            previewContent={previewContent}
                            fileName={props.fileName}
                            editable={canEdit}
                            vimMode={userState.vimMode}
                            wrapLines={userState.wrapEditorLines}
                            preview={isPreviewShown}
                            scrollToLine={props.scrollToLine}
                            reveal={buffer.reveal}
                            onBecameDirty={() => {
                                if (saveMutation.isSuccess)
                                    saveMutation.reset();

                                if (!buffer.readOnly) {
                                    keepOpen();
                                }
                            }}
                            // A revision is not the working file, so there is nothing to open.
                            onDoubleClick={
                                buffer.readOnly ? undefined : keepOpen
                            }
                            onFocus={reloadFile}
                            onSave={handleSave}
                            onSelectionChange={setSelection}
                            searchHandleRef={searchHandleRef}
                            isSearchOpen={isSearchOpen}
                            onSearchOpenChange={setIsSearchOpen}
                            onClosePreview={() => props.onPreviewChange(false)}
                            gitGutter={gitGutter}
                        />
                    )}
                </div>
            </article>
            {deleteConfirmationOpen ? (
                <EditorDeleteDialog
                    agent={props.agent}
                    filePath={props.filePath}
                    fileName={props.fileName}
                    isDirty={isDirty}
                    onClose={() => setDeleteConfirmationOpen(false)}
                />
            ) : null}
        </div>
    );
}

/**
 * Reads the text the editor shows: the working file, or the committed file when a revision
 * is browsed. A revision has its own query key, so it never shares a buffer with the
 * working file, and only the query for the shown source runs.
 */
function useEditorContentQuery(props: {
    agent: Agent;
    filePath: string;
    revision?: string;
}) {
    const readOnly = props.revision !== undefined;
    const isVault = !readOnly && isVaultPath(props.filePath);
    const { vault } = rootRouteApi.useRouteContext();

    const vaultState = React.useSyncExternalStore(
        vault.subscribe,
        vault.getSnapshot,
    );

    const worktreeContentQuery = useQuery({
        ...fileContentQueryOptions(props.agent, props.filePath),
        enabled: !readOnly && !isVault,
    });

    // Shares the cache entry of `useVaultFile`, which also needs the revision.
    const vaultContentQuery = useQuery({
        ...vaultFileContentQueryOptions({
            agent: props.agent,
            path: props.filePath,
            vault,
            keyId: isVault ? vaultState.currentKeyId : null,
        }),
        select: (data) => data.content,
    });

    const revisionContentQuery = useQuery({
        ...gitRevisionContentQueryOptions(
            props.agent,
            props.filePath,
            props.revision ?? "",
        ),
        enabled: readOnly,
    });

    if (isVault) {
        return vaultContentQuery;
    }

    return readOnly ? revisionContentQuery : worktreeContentQuery;
}

/** Renders agent-verified images through the authenticated raw download URL. */
export function FileImageView(props: {
    agent: Agent;
    path: string;
    fileName: string;
    downloadUrl: string;
}) {
    return (
        <BrowserViewCard>
            <ViewCardHeader
                icon={<ImageIcon className="h-5 w-5" aria-hidden="true" />}
                eyebrow="Image"
                title={props.fileName}
                titleAriaLabel="File name"
                actions={
                    <PersistentPathActions
                        agent={props.agent}
                        path={props.path}
                        currentName={props.fileName}
                        entryType="file"
                        downloadUrl={props.downloadUrl}
                        downloadName={props.fileName}
                    />
                }
            />

            <div className="flex items-center justify-center p-4 @2xl:p-6">
                <img
                    src={props.downloadUrl}
                    alt={props.fileName}
                    className="max-h-[70vh] max-w-full rounded-xl object-contain"
                />
            </div>
        </BrowserViewCard>
    );
}
