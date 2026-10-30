import React from "react";
import { useMutation } from "@tanstack/react-query";
import {
    ClipboardCopy,
    Download,
    LoaderCircle,
    MoreHorizontal,
    PanelLeftOpen,
    RefreshCw,
    Replace,
    Save,
    Search,
    ScanText,
    Trash2,
} from "lucide-react";
import { useAtom } from "jotai";
import type { Agent } from "#ui/api-client";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { Button } from "#ui/components/button";
import { BookmarkMenuButton } from "#ui/components/browser/bookmark-action";
import type { EditorSelection } from "#ui/components/browser/code-editor";
import { SelectPathMenuButton } from "#ui/components/browser/path-actions";
import { getImmediateParentPath } from "#ui/components/browser/utils";
import { ViewToolbar } from "#ui/components/browser/view-toolbar-slot";
import { Checkbox } from "#ui/components/checkbox";
import { FullWindowToggle } from "#ui/components/full-window-toggle";
import { IconButton } from "#ui/components/icon-button";
import { Toast } from "#ui/components/toast";
import { ToggleButton } from "#ui/components/toggle-button";
import { useAgentSearchNavigation } from "#ui/search-navigation";
import { openSideMenuAtom, sideMenuDrawerIds } from "#ui/side-menu-state";
import { useUserState } from "#ui/user-state";
import { cn } from "#ui/utils/cn";
import { getErrorMessage } from "#ui/utils/error";

/** Toolbar buttons share one size so the row reads as a single quiet strip. */
const toolbarButtonClassName = "h-8 w-8 rounded-md p-0";

/** Pressed toggles turn blue, like the search dialog's options, so their state is obvious. */
const toolbarToggleClassName =
    "h-8 w-8 text-slate-300 aria-pressed:bg-blue-500/20 aria-pressed:text-blue-300";

/** Keeps save state and editor mutations inside the representation they affect. */
function FileEditActions(props: {
    /** A committed revision cannot be saved. */
    readOnly: boolean;
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
    preview?: boolean;
    isSearchOpen: boolean;
    onSave: () => void;
    onToggleSearch: () => void;
    onPreviewChange?: (preview: boolean) => void;
}) {
    const { updateSearch } = useAgentSearchNavigation();

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
            {props.readOnly ? null : (
                <Button
                    tooltip="Save file (Ctrl+S)"
                    type="button"
                    aria-label="Save file"
                    onClick={props.onSave}
                    disabled={!props.canEdit || !props.isDirty}
                    isLoading={props.isSaving}
                    // Only unsaved changes earn the solid button, so it doubles as a dirty marker.
                    variant={props.isDirty ? "primary" : "ghost"}
                    size="sm"
                    className={toolbarButtonClassName}
                >
                    <Save className="h-4 w-4" aria-hidden="true" />
                </Button>
            )}
            {props.readOnly ? null : <ToolbarDivider />}
            {props.preview !== undefined && props.onPreviewChange ? (
                <ToggleButton
                    pressed={props.preview}
                    label="Preview"
                    variant="subtle"
                    className={toolbarToggleClassName}
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
            <ToggleButton
                pressed={props.isSearchOpen}
                label="Toggle search and replace"
                tooltip={
                    props.isSearchOpen
                        ? "Close search and replace (Ctrl+F)"
                        : "Search and replace in the file (Ctrl+F)"
                }
                onClick={props.onToggleSearch}
                variant="subtle"
                className={toolbarToggleClassName}
            >
                <Replace className="h-4 w-4" aria-hidden="true" />
            </ToggleButton>
            <Button
                tooltip="Copy the selection as a fenced code block headed by path#Lline, ready to reference this file in prompts to AI agents."
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Copy selection with file reference"
                disabled={props.selection === null}
                isLoading={copyMutation.isPending}
                onClick={() => copyMutation.mutate()}
                className={toolbarButtonClassName}
            >
                <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
                tooltip="Search the selected text from the git repository root when the file is in a worktree."
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Search selected text"
                disabled={props.selection === null}
                onClick={() => {
                    if (props.selection === null) {
                        return;
                    }

                    void updateSearch({
                        q: props.selection.text,
                        mode: "content",
                        gitroot: true,
                    });
                }}
                className={toolbarButtonClassName}
            >
                <Search className="h-4 w-4" aria-hidden="true" />
            </Button>
            {props.statusMessage ? (
                <span
                    role="status"
                    aria-label="File edit status"
                    aria-live="polite"
                    className={`whitespace-nowrap px-2 text-xs ${
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

/** Keeps file operations and editor preferences close to the surface they affect. */
function EditorActionsMenu(props: {
    agent: Agent;
    path: string;
    fileName: string;
    /** Hides file operations, which would act on the working file rather than the revision. */
    readOnly: boolean;
    canEdit: boolean;
    isReloading: boolean;
    isSaving: boolean;
    downloadUrl: string | null;
    onReload: () => void;
    onDelete: () => void;
}) {
    const [userState, setUserState] = useUserState();

    return (
        <ActionMenu
            label="Editor actions"
            title="Editor actions"
            closeAriaLabel="Close editor actions"
            hideTitle={false}
            icon={<MoreHorizontal className="h-4 w-4" />}
            variant="icon"
        >
            {(close) => (
                <>
                    {props.readOnly ? null : (
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
                        </>
                    )}
                    {props.downloadUrl === null ? null : (
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
                    )}
                    {props.readOnly ? null : (
                        <>
                            <ActionMenuButton
                                tone="danger"
                                disabled={
                                    !props.canEdit ||
                                    props.isSaving ||
                                    getImmediateParentPath(props.path) === null
                                }
                                onClick={() => {
                                    close();
                                    props.onDelete();
                                }}
                            >
                                <Trash2 className="h-4 w-4" />
                                Delete file
                            </ActionMenuButton>
                            <div className="my-1 border-t border-slate-800" />
                            <SelectPathMenuButton
                                agent={props.agent}
                                path={props.path}
                                fileName={props.fileName}
                                entryType="file"
                                close={close}
                            />
                            <BookmarkMenuButton
                                bookmark={{
                                    agentId: props.agent.id,
                                    path: props.path,
                                    name: props.fileName,
                                    entryType: "file",
                                }}
                                close={close}
                            />
                            <div className="my-1 border-t border-slate-800" />
                        </>
                    )}
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

/** Groups secondary editor controls at the trailing edge of the file card. */
function FileEditorSecondaryActions(props: {
    agent: Agent;
    path: string;
    fileName: string;
    readOnly: boolean;
    canEdit: boolean;
    isReloading: boolean;
    isSaving: boolean;
    downloadUrl: string | null;
    isFullWindow: boolean;
    onToggleFullWindow: () => void;
    onReload: () => void;
    onDelete: () => void;
}) {
    return (
        <div className="flex shrink-0 items-center gap-0.5">
            <FullWindowToggle
                targetName="editor"
                isFullWindow={props.isFullWindow}
                onToggle={props.onToggleFullWindow}
            />
            <EditorActionsMenu
                agent={props.agent}
                path={props.path}
                fileName={props.fileName}
                readOnly={props.readOnly}
                canEdit={props.canEdit}
                isReloading={props.isReloading}
                isSaving={props.isSaving}
                downloadUrl={props.downloadUrl}
                onReload={props.onReload}
                onDelete={props.onDelete}
            />
        </div>
    );
}

/**
 * Reopens the shared application menu from inside the full-window editor, whose overlay
 * covers the persistent sidebar and the top bar's menu button. The menu is the only place
 * that lists open files, so the editor keeps a way to reach them without leaving the file.
 */
function OpenApplicationMenuButton() {
    const [openMenu, setOpenMenu] = useAtom(openSideMenuAtom);
    const isOpen = openMenu === "application";

    return (
        <IconButton
            type="button"
            label="Open application menu"
            tooltip="Open the open files panel"
            aria-haspopup="dialog"
            aria-controls={sideMenuDrawerIds.application}
            aria-expanded={isOpen}
            data-side-menu-opener={sideMenuDrawerIds.application}
            variant="ghost"
            size="lg"
            onClick={() => setOpenMenu(isOpen ? null : "application")}
            className="shrink-0"
        >
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
        </IconButton>
    );
}

/** Groups editor toolbar actions so the edit view can stay focused on buffer state. */
export function FileEditHeader(props: {
    readOnly: boolean;
    fileName: string;
    statusMessage: string | null;
    hasError: boolean;
    isSaved: boolean;
    canEdit: boolean;
    isDirty: boolean;
    isSaving: boolean;
    agent: Agent;
    filePath: string;
    selection: EditorSelection | null;
    preview: boolean | undefined;
    isSearchOpen: boolean;
    isReloading: boolean;
    downloadUrl: string | null;
    isFullWindow: boolean;
    onSave: () => void;
    onToggleSearch: () => void;
    onPreviewChange: ((preview: boolean) => void) | undefined;
    onToggleFullWindow: () => void;
    onReload: () => void;
    onDelete: () => void;
}) {
    return (
        // Outside full window the toolbar moves into the tab row, leaving only the name here.
        <header
            className={
                props.isFullWindow
                    ? "shrink-0 border-b border-slate-800 px-2 py-1.5"
                    : undefined
            }
        >
            <h1 aria-label="File name" className="sr-only">
                {props.fileName}
            </h1>
            <ViewToolbar inPlace={props.isFullWindow}>
                <div className="flex w-full min-w-0 items-center gap-1">
                    <div className="flex min-w-0 items-center gap-0.5">
                        {props.isFullWindow ? (
                            <>
                                <OpenApplicationMenuButton />
                                <ToolbarDivider />
                            </>
                        ) : null}
                        <FileEditActions
                            readOnly={props.readOnly}
                            statusMessage={props.statusMessage}
                            hasError={props.hasError}
                            isSaved={props.isSaved}
                            canEdit={props.canEdit}
                            isDirty={props.isDirty}
                            isSaving={props.isSaving}
                            bookmark={{
                                agentId: props.agent.id,
                                path: props.filePath,
                                name: props.fileName,
                                entryType: "file",
                            }}
                            selection={props.selection}
                            preview={props.preview}
                            isSearchOpen={props.isSearchOpen}
                            onSave={props.onSave}
                            onToggleSearch={props.onToggleSearch}
                            onPreviewChange={props.onPreviewChange}
                        />
                        {props.isFullWindow ? (
                            // The full-window editor covers the tab that names the file, so the
                            // name follows the editor actions that identify the buffer.
                            <span
                                aria-hidden="true"
                                className="min-w-0 truncate px-2 text-sm text-slate-300"
                            >
                                {props.fileName}
                            </span>
                        ) : null}
                    </div>
                    {/* A full-width row pushes the window controls to its end; beside the tabs
                        there is no room to push, so a divider separates the groups instead. */}
                    <span className="flex-1" />
                    <ToolbarDivider
                        className={
                            props.isFullWindow ? "hidden" : "hidden @2xl:block"
                        }
                    />
                    <FileEditorSecondaryActions
                        agent={props.agent}
                        path={props.filePath}
                        fileName={props.fileName}
                        readOnly={props.readOnly}
                        canEdit={props.canEdit}
                        isReloading={props.isReloading}
                        isSaving={props.isSaving}
                        downloadUrl={props.downloadUrl}
                        isFullWindow={props.isFullWindow}
                        onToggleFullWindow={props.onToggleFullWindow}
                        onReload={props.onReload}
                        onDelete={props.onDelete}
                    />
                </div>
            </ViewToolbar>
        </header>
    );
}

/** Separates toolbar groups without the weight of boxed buttons. */
function ToolbarDivider(props: { className?: string }) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                "mx-1 h-5 w-px shrink-0 bg-slate-700",
                props.className,
            )}
        />
    );
}
