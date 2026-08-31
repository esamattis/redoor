import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    getRouteApi,
    Link,
    type ShouldBlockFn,
    useBlocker,
    useLocation,
} from "@tanstack/react-router";
import {
    ClipboardCopy,
    Download,
    History,
    LoaderCircle,
    MoreHorizontal,
    RefreshCw,
    Replace,
    Save,
    Search,
    ScanText,
    X,
} from "lucide-react";
import { getBrowserUrl, type Agent } from "#ui/api-client";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { BrowserViewCard } from "#ui/components/browser-view-card";
import { Button } from "#ui/components/button";
import { BookmarkButton } from "#ui/components/browser/bookmark-action";
import {
    CodeEditor,
    type EditorSelection,
} from "#ui/components/browser/code-editor";
import type { EditorSearchHandle } from "#ui/components/browser/editor-search";
import {
    PersistentPathActions,
    SelectPathMenuButton,
} from "#ui/components/browser/path-actions";
import { getErrorMessage } from "#ui/components/browser/utils";
import { Checkbox } from "#ui/components/checkbox";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { FullWindowToggle } from "#ui/components/full-window-toggle";
import { IconButton } from "#ui/components/icon-button";
import { ResponsiveAnchoredDialog } from "#ui/components/responsive-anchored-dialog";
import { Toast } from "#ui/components/toast";
import { Tooltip } from "#ui/components/tooltip";
import { ToggleButton } from "#ui/components/toggle-button";
import { fileContentQueryOptions } from "#ui/queries";
import { useEditorRefreshRegistration } from "#ui/components/browser/refresh";
import { isTerminalInputTarget } from "#ui/utils/keyboard";
import {
    rememberRecentEditorFile,
    removeRecentEditorFile,
    useUserState,
    type RecentEditorFile,
} from "#ui/user-state";
import { syntaxLanguageFromFileName } from "#ui/utils/editor-language";
import { MarkdownPreview } from "#ui/components/browser/markdown-preview";

const agentRoute = getRouteApi("/agents/$agentId");

/** Renders one recent path compactly in the toolbar or as a full dialog row. */
function RecentEditorFileItem(props: {
    agentId: string;
    file: RecentEditorFile;
    variant: "inline" | "dialog";
    onRemove: (path: string) => void;
}) {
    const isDialog = props.variant === "dialog";
    return (
        <span
            className={
                isDialog
                    ? "flex min-w-0 items-center gap-1 rounded-md px-2 py-1 hover:bg-white/5"
                    : "hidden min-w-0 items-center gap-0.5 2xl:inline-flex"
            }
        >
            <Tooltip
                content={props.file.path}
                className={isDialog ? "min-w-0 flex-1" : undefined}
            >
                <Link
                    to={getBrowserUrl(props.agentId, props.file.path)}
                    aria-label={`Open ${props.file.name} from recent files`}
                    className={
                        isDialog
                            ? "block min-w-0 flex-1 truncate py-1 text-sm text-blue-400 hover:underline"
                            : "max-w-32 truncate px-1 text-xs text-blue-400 hover:underline"
                    }
                >
                    {props.file.name}
                </Link>
            </Tooltip>
            <IconButton
                type="button"
                label={`Remove ${props.file.name} from recent files`}
                onClick={() => props.onRemove(props.file.path)}
                className="h-6 w-6 shrink-0 rounded text-slate-500 hover:bg-white/5 hover:text-slate-200"
            >
                <X className="h-3 w-3" aria-hidden="true" />
            </IconButton>
        </span>
    );
}

/** Makes the longer recent-file history available without crowding the editor toolbar. */
function RecentEditorFilesDialog(props: {
    isOpen: boolean;
    anchorRef: React.RefObject<HTMLElement | null>;
    agentId: string;
    recentFiles: RecentEditorFile[];
    onRemove: (path: string) => void;
    onClose: () => void;
}) {
    return (
        <ResponsiveAnchoredDialog
            isOpen={props.isOpen}
            title="Recent files"
            closeAriaLabel="Close recent files"
            desktopAnchorRef={props.anchorRef}
            onClose={props.onClose}
        >
            {props.recentFiles.length === 0 ? (
                <p className="mt-4 text-sm text-slate-400">No recent files.</p>
            ) : (
                <div className="mt-4 space-y-1">
                    {props.recentFiles.map((file) => (
                        <RecentEditorFileItem
                            key={file.path}
                            agentId={props.agentId}
                            file={file}
                            variant="dialog"
                            onRemove={props.onRemove}
                        />
                    ))}
                </div>
            )}
        </ResponsiveAnchoredDialog>
    );
}

/** Keeps save state and editor mutations inside the representation they affect. */
function FileEditActions(props: {
    statusMessage: string | null;
    hasError: boolean;
    isSaved: boolean;
    canEdit: boolean;
    isDirty: boolean;
    isSaving: boolean;
    bookmark: {
        agentId: string;
        path: string;
        name: string;
        entryType: "file";
    };
    selection: EditorSelection | null;
    recentFiles: RecentEditorFile[];
    preview?: boolean;
    onSave: () => void;
    onToggleSearch: () => void;
    onRemoveRecentFile: (path: string) => void;
    onPreviewChange?: (preview: boolean) => void;
}) {
    const navigate = agentRoute.useNavigate();
    const location = useLocation();
    const recentFilesButtonRef = React.useRef<HTMLButtonElement>(null);
    const [recentFilesOpen, setRecentFilesOpen] = React.useState(false);
    const copyMutation = useMutation({
        mutationFn: async () => {
            if (props.selection === null) {
                throw new Error("Select text in the editor before copying");
            }
            const reference = `\`\`\`${props.bookmark.path}#L${props.selection.startLine}
${props.selection.text}
\`\`\``;
            await navigator.clipboard.writeText(reference);
        },
    });

    return (
        <>
            <Tooltip content="Save file (Ctrl+S)">
                <Button
                    type="button"
                    aria-label="Save file"
                    onClick={props.onSave}
                    disabled={!props.canEdit || !props.isDirty}
                    isLoading={props.isSaving}
                    size="sm"
                    className="h-9 w-9 rounded-md p-0 font-semibold shadow-sm shadow-blue-950/30"
                >
                    <Save className="h-4 w-4" aria-hidden="true" />
                </Button>
            </Tooltip>
            <IconButton
                ref={recentFilesButtonRef}
                type="button"
                label="Recent files"
                onClick={() => setRecentFilesOpen(true)}
                className="h-9 w-9 rounded-md border border-slate-700 text-slate-200 hover:bg-white/5"
            >
                <History className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            {props.preview !== undefined && props.onPreviewChange ? (
                <ToggleButton
                    pressed={props.preview}
                    label="Preview"
                    tooltip={
                        props.preview
                            ? "Show the markdown editor"
                            : "Preview rendered markdown"
                    }
                    onClick={() => props.onPreviewChange?.(!props.preview)}
                >
                    <ScanText className="h-4 w-4" aria-hidden="true" />
                </ToggleButton>
            ) : null}
            <BookmarkButton bookmark={props.bookmark} />
            <IconButton
                type="button"
                label="Toggle search and replace"
                tooltip="Search and replace in the file (Ctrl+F)"
                onClick={props.onToggleSearch}
                className="h-9 w-9 rounded-md border border-slate-700 text-slate-200 hover:bg-white/5"
            >
                <Replace className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            <Tooltip content="Copy the selection as a fenced code block headed by path#Lline, ready to reference this file in prompts to AI agents.">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Copy selection with file reference"
                    disabled={props.selection === null}
                    isLoading={copyMutation.isPending}
                    onClick={() => copyMutation.mutate()}
                    className="h-9 w-9 rounded-md p-0 font-semibold"
                >
                    <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
                </Button>
            </Tooltip>
            <Tooltip content="Search the selected text from the git repository root when the file is in a worktree.">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Search selected text"
                    disabled={props.selection === null}
                    onClick={() => {
                        if (props.selection === null) {
                            return;
                        }
                        const params = new URLSearchParams(location.searchStr);
                        params.set("q", props.selection.text);
                        params.set("mode", "content");
                        params.set("gitroot", "true");
                        void navigate({
                            to: `${location.pathname}?${params.toString()}${location.hash}`,
                            replace: true,
                        });
                    }}
                    className="h-9 w-9 rounded-md p-0 font-semibold"
                >
                    <Search className="h-4 w-4" aria-hidden="true" />
                </Button>
            </Tooltip>
            {props.recentFiles.slice(0, 5).map((file) => (
                <RecentEditorFileItem
                    key={file.path}
                    agentId={props.bookmark.agentId}
                    file={file}
                    variant="inline"
                    onRemove={props.onRemoveRecentFile}
                />
            ))}
            {props.statusMessage ? (
                <span
                    role="status"
                    aria-label="File edit status"
                    aria-live="polite"
                    className={`px-2 text-sm ${
                        props.hasError
                            ? "text-red-300"
                            : props.isSaved
                              ? "text-emerald-300"
                              : "text-slate-400"
                    }`}
                >
                    {props.statusMessage}
                </span>
            ) : null}
            {copyMutation.isSuccess || copyMutation.isError ? (
                <Toast
                    tone={copyMutation.isError ? "error" : "success"}
                    icon={<ClipboardCopy className="h-4 w-4" />}
                    dismissAriaLabel="Dismiss copy reference message"
                    onDismiss={() => copyMutation.reset()}
                >
                    {copyMutation.isError
                        ? getErrorMessage(
                              copyMutation.error,
                              "Could not copy the file reference",
                          )
                        : "Copied selection with file reference"}
                </Toast>
            ) : null}
            <RecentEditorFilesDialog
                isOpen={recentFilesOpen}
                anchorRef={recentFilesButtonRef}
                agentId={props.bookmark.agentId}
                recentFiles={props.recentFiles}
                onRemove={props.onRemoveRecentFile}
                onClose={() => setRecentFilesOpen(false)}
            />
        </>
    );
}

/** Keeps editor-specific preferences close to the surface they immediately affect. */
function EditorOptionsMenu(props: {
    agent: Agent;
    path: string;
    fileName: string;
    canEdit: boolean;
    isReloading: boolean;
    isSaving: boolean;
    downloadUrl: string;
    onReload: () => void;
}) {
    const [userState, setUserState] = useUserState();

    return (
        <ActionMenu
            label="Editor options"
            title="Editor options"
            closeAriaLabel="Close editor options"
            hideTitle={false}
            icon={<MoreHorizontal className="h-4 w-4" />}
            variant="icon"
        >
            {(close) => (
                <>
                    <ActionMenuButton
                        disabled={!props.canEdit || props.isSaving}
                        onClick={() => {
                            close();
                            props.onReload();
                        }}
                    >
                        {props.isReloading ? (
                            <LoaderCircle className="h-4 w-4 animate-spin text-slate-400" />
                        ) : (
                            <RefreshCw className="h-4 w-4 text-slate-400" />
                        )}
                        {props.isReloading ? "Reloading..." : "Reload"}
                    </ActionMenuButton>
                    <ActionMenuButton asChild>
                        <a
                            href={props.downloadUrl}
                            download={props.fileName}
                            onClick={close}
                        >
                            <Download className="h-4 w-4 text-slate-400" />
                            Download
                        </a>
                    </ActionMenuButton>
                    <div className="my-1 border-t border-slate-800" />
                    <SelectPathMenuButton
                        agent={props.agent}
                        path={props.path}
                        fileName={props.fileName}
                        entryType="file"
                        close={close}
                    />
                    <div className="my-1 border-t border-slate-800" />
                    <Checkbox
                        checked={userState.wrapEditorLines}
                        label="Wrap lines"
                        title={false}
                        className="w-full px-3 py-2"
                        onCheckedChange={(checked) => {
                            setUserState((current) => ({
                                ...current,
                                wrapEditorLines: checked,
                            }));
                        }}
                    >
                        Wrap lines
                    </Checkbox>
                    <Checkbox
                        checked={userState.vimMode}
                        label="Vim mode"
                        title={false}
                        className="w-full px-3 py-2"
                        onCheckedChange={(checked) => {
                            setUserState((current) => ({
                                ...current,
                                vimMode: checked,
                            }));
                        }}
                    >
                        Vim mode
                    </Checkbox>
                </>
            )}
        </ActionMenu>
    );
}

/** Puts the editor exit on the rendered page so it stays with the markdown, not the toolbar. */
function CloseMarkdownPreviewButton(props: { onClose: () => void }) {
    return (
        <IconButton
            type="button"
            label="Close markdown preview"
            tooltip="Edit markdown"
            onClick={props.onClose}
            className="h-8 w-8 rounded-md bg-[#11141b]/90 text-slate-300 hover:bg-white/5 hover:text-slate-50"
        >
            <X className="h-4 w-4" aria-hidden="true" />
        </IconButton>
    );
}

/** Groups secondary editor controls at the trailing edge of the file card. */
function FileEditorSecondaryActions(props: {
    agent: Agent;
    path: string;
    fileName: string;
    canEdit: boolean;
    isReloading: boolean;
    isSaving: boolean;
    downloadUrl: string;
    isFullWindow: boolean;
    onToggleFullWindow: () => void;
    onReload: () => void;
}) {
    return (
        <div className="flex shrink-0 items-center gap-1">
            <FullWindowToggle
                targetName="editor"
                isFullWindow={props.isFullWindow}
                onToggle={props.onToggleFullWindow}
            />
            <EditorOptionsMenu
                agent={props.agent}
                path={props.path}
                fileName={props.fileName}
                canEdit={props.canEdit}
                isReloading={props.isReloading}
                isSaving={props.isSaving}
                downloadUrl={props.downloadUrl}
                onReload={props.onReload}
            />
        </div>
    );
}

/** Makes browser save invoke the editor unless another interactive surface owns it. */
function useFileSaveShortcut(onSave: () => void) {
    React.useEffect(() => {
        const handleSaveShortcut = (event: KeyboardEvent) => {
            if (
                !(
                    (event.ctrlKey || event.metaKey) &&
                    !event.altKey &&
                    event.key === "s"
                ) ||
                event.defaultPrevented ||
                isTerminalInputTarget(event.target)
            ) {
                return;
            }
            event.preventDefault();
            onSave();
        };

        window.addEventListener("keydown", handleSaveShortcut);
        return () => window.removeEventListener("keydown", handleSaveShortcut);
    }, [onSave]);
}

/** Selects the editor body without coupling its loading states to draft ownership. */
function FileEditorSurface(props: {
    agentId: string;
    filePath: string;
    repositoryRoot: string | null;
    isPending: boolean;
    error?: Error;
    content: string;
    fileName: string;
    editable: boolean;
    vimMode: boolean;
    wrapLines: boolean;
    preview: boolean;
    scrollToLine?: number;
    searchHandleRef: React.RefObject<EditorSearchHandle | null>;
    onChange: (content: string) => void;
    onFocus: () => void;
    onSave: () => void;
    onSelectionChange: (selection: EditorSelection | null) => void;
    onClosePreview: () => void;
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
                    value={props.content}
                    fileName={props.fileName}
                    editable={props.editable}
                    vimMode={props.vimMode}
                    wrapLines={props.wrapLines}
                    scrollToLine={props.scrollToLine}
                    onChange={props.onChange}
                    onFocus={props.onFocus}
                    onSave={props.onSave}
                    onSelectionChange={props.onSelectionChange}
                    searchHandleRef={props.searchHandleRef}
                />
            </div>
            <div
                aria-hidden={!props.preview}
                className={
                    props.preview ? "relative flex min-h-0 flex-1" : "hidden"
                }
            >
                <MarkdownPreview
                    content={props.content}
                    agentId={props.agentId}
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
    return props.isDirty ? "Unsaved changes" : null;
}

/** Records editor visits and exposes up to ten prior files for the active agent. */
function useEditorUserState(props: {
    agentId: string;
    filePath: string;
    fileName: string;
}) {
    const [userState, setUserState] = useUserState();
    const recentFiles = (
        userState.recentEditorFilesByAgent[props.agentId] ?? []
    )
        .filter((file) => file.path !== props.filePath)
        .slice(0, 10);

    React.useEffect(() => {
        setUserState((current) => {
            const agentRecentFiles =
                current.recentEditorFilesByAgent[props.agentId] ?? [];
            const nextAgentRecentFiles = rememberRecentEditorFile(
                agentRecentFiles,
                { path: props.filePath, name: props.fileName },
            );
            if (nextAgentRecentFiles === agentRecentFiles) {
                return current;
            }
            return {
                ...current,
                recentEditorFilesByAgent: {
                    ...current.recentEditorFilesByAgent,
                    [props.agentId]: nextAgentRecentFiles,
                },
            };
        });
    }, [props.agentId, props.fileName, props.filePath, setUserState]);

    /** Removes the selected history entry while preserving histories for other agents. */
    const removeRecentFile = (path: string) => {
        setUserState((current) => ({
            ...current,
            recentEditorFilesByAgent: {
                ...current.recentEditorFilesByAgent,
                [props.agentId]: removeRecentEditorFile(
                    current.recentEditorFilesByAgent[props.agentId] ?? [],
                    path,
                ),
            },
        }));
    };

    return { userState, recentFiles, removeRecentFile };
}

/** Presents reload and navigation discard decisions without conflating their callbacks. */
function EditorConfirmations(props: {
    reloadOpen: boolean;
    navigationOpen: boolean;
    onCloseReload: () => void;
    onConfirmReload: () => void;
    onCloseNavigation: () => void;
    onConfirmNavigation: () => void;
}) {
    return (
        <>
            <ConfirmationDialog
                isOpen={props.reloadOpen}
                title="Discard unsaved changes?"
                description="Your edits have not been saved. Reloading this file will lose them."
                confirmLabel="Discard changes"
                onClose={props.onCloseReload}
                onConfirm={props.onConfirmReload}
            />
            <ConfirmationDialog
                isOpen={props.navigationOpen}
                title="Discard unsaved changes?"
                description="Your edits have not been saved. Leaving this page will lose them."
                confirmLabel="Discard changes"
                onClose={props.onCloseNavigation}
                onConfirm={props.onConfirmNavigation}
            />
        </>
    );
}

/**
 * Keeps editor route context explicit because previews need filesystem and repository paths.
 */
type FileEditViewProps = {
    agent: Agent;
    fileName: string;
    filePath: string;
    repositoryRoot: string | null;
    mimeType: string;
    downloadUrl: string;
    scrollToLine?: number;
    preview: boolean;
    onPreviewChange: (preview: boolean) => void;
};

/**
 * Edits file contents in a viewport-bounded CodeMirror with explicit save/reload.
 * scrollToLine is inbound-only so a ?line= URL can move the caret without writing back.
 */
export function FileEditView(props: FileEditViewProps) {
    const queryClient = useQueryClient();
    const editorUserState = useEditorUserState({
        agentId: props.agent.id,
        filePath: props.filePath,
        fileName: props.fileName,
    });
    const fileQuery = fileContentQueryOptions(props.agent, props.filePath);
    const contentQuery = useQuery(fileQuery);
    const [draft, setDraft] = React.useState<string | null>(null);
    const [selection, setSelection] = React.useState<EditorSelection | null>(
        null,
    );
    const [reloadConfirmationOpen, setReloadConfirmationOpen] =
        React.useState(false);
    const [isFullWindow, setIsFullWindow] = React.useState(false);
    const searchHandleRef = React.useRef<EditorSearchHandle | null>(null);
    const reloadPromiseRef = React.useRef<Promise<unknown> | null>(null);
    const saveMutation = useMutation({
        mutationFn: (nextContent: string) =>
            props.agent.editFile(
                props.filePath,
                new globalThis.File([nextContent], props.fileName, {
                    type: props.mimeType || "text/plain",
                }),
            ),
        onSuccess: (_, nextContent) => {
            queryClient.setQueryData(fileQuery.queryKey, nextContent);
            // Keep a newer draft so a save cannot wipe keystrokes typed during the edit.
            setDraft((current) =>
                current === null || current === nextContent ? null : current,
            );
        },
    });
    const savedContent = contentQuery.data ?? "";
    const content = draft ?? savedContent;
    const isDirty = draft !== null && draft !== savedContent;
    // Saving must not flip CodeMirror read-only, or Mod-s and :w steal editor focus.
    const canEdit = contentQuery.isSuccess;
    const isMarkdown =
        syntaxLanguageFromFileName(props.fileName) === "markdown";

    useEditorRefreshRegistration({
        agentId: props.agent.id,
        path: props.filePath,
        isDirty,
    });
    const navigationBlocker = useUnsavedEditorNavigationGuard(isDirty);

    const reloadFile = React.useCallback(() => {
        if (!canEdit || saveMutation.isPending || reloadPromiseRef.current) {
            return;
        }
        setDraft(null);
        saveMutation.reset();
        const reloadPromise = contentQuery.refetch().finally(() => {
            reloadPromiseRef.current = null;
        });
        reloadPromiseRef.current = reloadPromise;
    }, [canEdit, contentQuery, saveMutation]);

    const handleReload = () => {
        if (isDirty) {
            setReloadConfirmationOpen(true);
            return;
        }
        reloadFile();
    };

    const handleSave = React.useCallback(() => {
        if (!canEdit || saveMutation.isPending || !isDirty) {
            return;
        }
        saveMutation.mutate(content);
    }, [canEdit, content, isDirty, saveMutation]);

    useFileSaveShortcut(handleSave);

    const statusMessage = getFileEditorStatus({
        isLoading: contentQuery.isPending,
        loadError: contentQuery.isError ? contentQuery.error : undefined,
        isSaving: saveMutation.isPending,
        isSaved: saveMutation.isSuccess,
        saveError: saveMutation.isError ? saveMutation.error : undefined,
        isDirty,
    });

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <article
                aria-label="Editing panel"
                className={`flex min-h-0 flex-1 flex-col overflow-hidden border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20 ${
                    isFullWindow
                        ? "fixed inset-0 z-[60] rounded-none"
                        : "rounded-lg"
                }`}
            >
                <header className="shrink-0 border-b border-slate-800 p-4">
                    <h1 aria-label="File name" className="sr-only">
                        {props.fileName}
                    </h1>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center justify-start gap-2">
                            <FileEditActions
                                statusMessage={statusMessage}
                                hasError={
                                    contentQuery.isError || saveMutation.isError
                                }
                                isSaved={saveMutation.isSuccess}
                                canEdit={canEdit}
                                isDirty={isDirty}
                                isSaving={saveMutation.isPending}
                                bookmark={{
                                    agentId: props.agent.id,
                                    path: props.filePath,
                                    name: props.fileName,
                                    entryType: "file",
                                }}
                                selection={selection}
                                recentFiles={editorUserState.recentFiles}
                                preview={isMarkdown ? props.preview : undefined}
                                onSave={handleSave}
                                onToggleSearch={() => {
                                    if (!searchHandleRef.current?.close()) {
                                        searchHandleRef.current?.open();
                                    }
                                }}
                                onRemoveRecentFile={
                                    editorUserState.removeRecentFile
                                }
                                onPreviewChange={
                                    isMarkdown
                                        ? props.onPreviewChange
                                        : undefined
                                }
                            />
                        </div>
                        <FileEditorSecondaryActions
                            agent={props.agent}
                            path={props.filePath}
                            fileName={props.fileName}
                            canEdit={canEdit}
                            isReloading={contentQuery.isFetching}
                            isSaving={saveMutation.isPending}
                            downloadUrl={props.downloadUrl}
                            isFullWindow={isFullWindow}
                            onToggleFullWindow={() =>
                                setIsFullWindow((current) => !current)
                            }
                            onReload={handleReload}
                        />
                    </div>
                </header>

                <div className="flex min-h-0 flex-1 flex-col">
                    <FileEditorSurface
                        agentId={props.agent.id}
                        filePath={props.filePath}
                        repositoryRoot={props.repositoryRoot}
                        isPending={contentQuery.isPending}
                        error={
                            contentQuery.isError
                                ? contentQuery.error
                                : undefined
                        }
                        content={content}
                        fileName={props.fileName}
                        editable={canEdit}
                        vimMode={editorUserState.userState.vimMode}
                        wrapLines={editorUserState.userState.wrapEditorLines}
                        preview={isMarkdown && props.preview}
                        scrollToLine={props.scrollToLine}
                        onChange={(nextContent) => {
                            setDraft(nextContent);
                            if (saveMutation.isSuccess) saveMutation.reset();
                        }}
                        onFocus={() => {
                            if (!isDirty) reloadFile();
                        }}
                        onSave={handleSave}
                        onSelectionChange={setSelection}
                        searchHandleRef={searchHandleRef}
                        onClosePreview={() => props.onPreviewChange(false)}
                    />
                </div>
            </article>
            <EditorConfirmations
                reloadOpen={reloadConfirmationOpen}
                navigationOpen={navigationBlocker.status === "blocked"}
                onCloseReload={() => setReloadConfirmationOpen(false)}
                onConfirmReload={() => {
                    setReloadConfirmationOpen(false);
                    reloadFile();
                }}
                onCloseNavigation={() => navigationBlocker.reset?.()}
                onConfirmNavigation={() => navigationBlocker.proceed?.()}
            />
        </div>
    );
}

/**
 * Blocks in-app navigation and tab close/refresh so a dirty buffer cannot disappear silently.
 */
function useUnsavedEditorNavigationGuard(isDirty: boolean) {
    const isDirtyRef = React.useRef(isDirty);
    isDirtyRef.current = isDirty;

    const shouldBlockFn: ShouldBlockFn = React.useCallback(
        (args) =>
            isDirtyRef.current &&
            !isPreviewOnlyNavigation(args.current, args.next),
        [],
    );
    const enableBeforeUnload = React.useCallback(() => isDirtyRef.current, []);

    return useBlocker({
        shouldBlockFn,
        enableBeforeUnload,
        withResolver: true,
    });
}

/** Lets a dirty markdown buffer change representation without treating it as leaving the file. */
function isPreviewOnlyNavigation(
    current: { pathname: string; search: object },
    next: { pathname: string; search: object },
) {
    if (current.pathname !== next.pathname) {
        return false;
    }
    const currentSearch = JSON.stringify(current.search);
    const nextSearch = JSON.stringify(next.search);
    const currentWithoutPreview = JSON.stringify(
        current.search,
        (key, value) => (key === "preview" ? undefined : value),
    );
    const nextWithoutPreview = JSON.stringify(next.search, (key, value) =>
        key === "preview" ? undefined : value,
    );
    return (
        currentSearch !== nextSearch &&
        currentWithoutPreview === nextWithoutPreview
    );
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
            <header className="border-b border-slate-800 p-6 md:p-8">
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                    Image
                </p>
                <div className="flex flex-wrap items-center gap-3">
                    <h1
                        aria-label="File name"
                        className="min-w-0 break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                    >
                        {props.fileName}
                    </h1>
                    <div className="ml-auto shrink-0">
                        <PersistentPathActions
                            agent={props.agent}
                            path={props.path}
                            currentName={props.fileName}
                            entryType="file"
                            downloadUrl={props.downloadUrl}
                            downloadName={props.fileName}
                        />
                    </div>
                </div>
            </header>

            <div className="flex items-center justify-center p-4 md:p-6">
                <img
                    src={props.downloadUrl}
                    alt={props.fileName}
                    className="max-h-[70vh] max-w-full rounded-xl object-contain"
                />
            </div>
        </BrowserViewCard>
    );
}
