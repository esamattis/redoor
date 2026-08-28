import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import {
    ClipboardCopy,
    Download,
    LoaderCircle,
    MoreHorizontal,
    RefreshCw,
    Save,
    Search,
} from "lucide-react";
import type { Agent } from "#ui/api-client";
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
import { Toast } from "#ui/components/toast";
import { Tooltip } from "#ui/components/tooltip";
import { fileContentQueryOptions } from "#ui/queries";
import { useEditorRefreshRegistration } from "#ui/components/browser/refresh";
import { isTerminalInputTarget } from "#ui/utils/keyboard";
import { useUserState } from "#ui/user-state";

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
    onSave: () => void;
}) {
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
                    className="h-9 w-9 rounded-md p-0 font-semibold shadow-sm shadow-blue-950/30 sm:w-auto sm:px-3.5"
                >
                    <Save className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden sm:inline">
                        {props.isSaving ? "Saving..." : "Save"}
                    </span>
                </Button>
            </Tooltip>
            <BookmarkButton bookmark={props.bookmark} />
            <Tooltip content="Copy the selection as a fenced code block headed by path#Lline, ready to reference this file in prompts to AI agents.">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Copy selection with file reference"
                    disabled={props.selection === null}
                    isLoading={copyMutation.isPending}
                    onClick={() => copyMutation.mutate()}
                    className="h-9 w-9 rounded-md p-0 font-semibold sm:w-auto sm:px-3.5"
                >
                    <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Copy reference</span>
                </Button>
            </Tooltip>
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
    isPending: boolean;
    error?: Error;
    content: string;
    fileName: string;
    editable: boolean;
    vimMode: boolean;
    wrapLines: boolean;
    scrollToLine?: number;
    searchHandleRef: React.RefObject<EditorSearchHandle | null>;
    onChange: (content: string) => void;
    onFocus: () => void;
    onSave: () => void;
    onSelectionChange: (selection: EditorSelection | null) => void;
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

/**
 * Edits file contents in a viewport-bounded CodeMirror with explicit save/reload.
 * scrollToLine is inbound-only so a ?line= URL can move the caret without writing back.
 */
export function FileEditView(props: {
    agent: Agent;
    fileName: string;
    filePath: string;
    mimeType: string;
    downloadUrl: string;
    scrollToLine?: number;
}) {
    const queryClient = useQueryClient();
    const [userState] = useUserState();
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
                                onSave={handleSave}
                            />
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <IconButton
                                type="button"
                                label="Toggle search and replace"
                                onClick={() => {
                                    if (!searchHandleRef.current?.close()) {
                                        searchHandleRef.current?.open();
                                    }
                                }}
                                className="h-8 w-8 shrink-0 rounded-md text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100 sm:hidden"
                            >
                                <Search
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                            </IconButton>
                            <FullWindowToggle
                                targetName="editor"
                                isFullWindow={isFullWindow}
                                onToggle={() =>
                                    setIsFullWindow((current) => !current)
                                }
                            />
                            <EditorOptionsMenu
                                agent={props.agent}
                                path={props.filePath}
                                fileName={props.fileName}
                                canEdit={canEdit}
                                isReloading={contentQuery.isFetching}
                                isSaving={saveMutation.isPending}
                                downloadUrl={props.downloadUrl}
                                onReload={handleReload}
                            />
                        </div>
                    </div>
                </header>

                <div className="flex min-h-0 flex-1 flex-col">
                    <FileEditorSurface
                        isPending={contentQuery.isPending}
                        error={
                            contentQuery.isError
                                ? contentQuery.error
                                : undefined
                        }
                        content={content}
                        fileName={props.fileName}
                        editable={canEdit}
                        vimMode={userState.vimMode}
                        wrapLines={userState.wrapEditorLines}
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
                    />
                </div>
            </article>
            <ConfirmationDialog
                isOpen={reloadConfirmationOpen}
                title="Discard unsaved changes?"
                description="Your edits have not been saved. Reloading this file will lose them."
                confirmLabel="Discard changes"
                onClose={() => setReloadConfirmationOpen(false)}
                onConfirm={() => {
                    setReloadConfirmationOpen(false);
                    reloadFile();
                }}
            />
            <ConfirmationDialog
                isOpen={navigationBlocker.status === "blocked"}
                title="Discard unsaved changes?"
                description="Your edits have not been saved. Leaving this page will lose them."
                confirmLabel="Discard changes"
                onClose={() => navigationBlocker.reset?.()}
                onConfirm={() => navigationBlocker.proceed?.()}
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

    const shouldBlockFn = React.useCallback(() => isDirtyRef.current, []);
    const enableBeforeUnload = React.useCallback(() => isDirtyRef.current, []);

    return useBlocker({
        shouldBlockFn,
        enableBeforeUnload,
        withResolver: true,
    });
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
