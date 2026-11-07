import React from "react";
import {
    DecryptedDownloadMenuButton,
    useDecryptedDownload,
} from "#ui/components/vault/decrypted-download-button";
import { isVaultPath } from "#ui/vault/vault-path";
import {
    Download,
    LoaderCircle,
    MoreHorizontal,
    PanelLeftOpen,
    RefreshCw,
    Search,
    TextSearch,
    Save,
    ScanText,
    Trash2,
} from "lucide-react";
import { useAtom } from "jotai";
import type { Agent } from "#ui/api-client";
import { ActionMenu, ActionMenuButton } from "#ui/components/action-menu";
import { Button } from "#ui/components/button";
import { BookmarkMenuButton } from "#ui/components/browser/bookmark-action";
import type { FilePreviewKind } from "#ui/utils/sandboxed-preview-document";
import { SelectPathMenuButton } from "#ui/components/browser/path-actions";
import { RunInTerminalButton } from "#ui/components/browser/run-in-terminal-button";
import { getImmediateParentPath } from "#ui/components/browser/utils";
import { ViewToolbar } from "#ui/components/browser/view-toolbar-slot";
import { Checkbox } from "#ui/components/checkbox";
import { FullWindowToggle } from "#ui/components/full-window-toggle";
import { IconButton } from "#ui/components/icon-button";
import { ToggleButton } from "#ui/components/toggle-button";
import { openSideMenuAtom, sideMenuDrawerIds } from "#ui/side-menu-state";
import { useUserState } from "#ui/user-state";
import { cn } from "#ui/utils/cn";

/** Toolbar buttons share one size so the row reads as a single quiet strip. */
const toolbarButtonClassName = "h-8 w-8 rounded-md p-0";

/** Pressed toggles turn blue, like the search dialog's options, so their state is obvious. */
const toolbarToggleClassName =
    "h-8 w-8 text-slate-300 aria-pressed:bg-blue-500/20 aria-pressed:text-blue-300";

/** Names each previewable format the way readers know it, for the preview toggle's tooltip. */
const previewKindNames = {
    markdown: "markdown",
    html: "HTML",
    svg: "SVG",
} satisfies Record<FilePreviewKind, string>;

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
    /** Offers running the file in a terminal; the caller already excludes Git revisions. */
    executable: boolean;
    agent: Agent;
    preview?: boolean;
    previewKind: FilePreviewKind | null;
    onSave: () => void;
    onPreviewChange?: (preview: boolean) => void;
}) {
    const showsPreviewToggle =
        props.preview !== undefined &&
        props.previewKind !== null &&
        props.onPreviewChange !== undefined;

    return (
        <>
            {/* Leads the group, so the save state reads as a label for the editor's actions
                instead of splitting them from the window controls. */}
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
            {props.executable ? (
                <RunInTerminalButton
                    agent={props.agent}
                    filePath={props.bookmark.path}
                    // The terminal runs the file on the device, which lacks unsaved edits.
                    disabledReason={
                        props.isDirty
                            ? "Save the file before running it in a terminal"
                            : null
                    }
                    className={toolbarButtonClassName}
                />
            ) : null}
            {/* Only between the buttons and the preview toggle; alone it would sit beside the
                divider in front of the window controls. */}
            {!props.readOnly && showsPreviewToggle ? <ToolbarDivider /> : null}
            {showsPreviewToggle &&
            props.preview !== undefined &&
            props.previewKind !== null ? (
                <ToggleButton
                    pressed={props.preview}
                    label="Preview"
                    variant="subtle"
                    className={toolbarToggleClassName}
                    tooltip={
                        props.preview
                            ? `Show the ${previewKindNames[props.previewKind]} editor`
                            : `Preview rendered ${previewKindNames[props.previewKind]}`
                    }
                    onClick={() => props.onPreviewChange?.(!props.preview)}
                >
                    <ScanText className="h-4 w-4" aria-hidden="true" />
                </ToggleButton>
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
    /** Separate from canEdit: a locked encrypted file has no content yet, but deleting it needs no key. */
    canDelete: boolean;
    isReloading: boolean;
    isSaving: boolean;
    downloadUrl: string | null;
    /**
     * Repeat the editor context menu's find and selection search, because phones have no
     * right click or keyboard shortcut to reach them.
     */
    onFindInFile: (() => void) | null;
    onSearchDirectory: (() => void) | null;
    onReload: () => void;
    onDelete: () => void;
}) {
    const [userState, setUserState] = useUserState();
    const decrypted = useDecryptedDownload(props.agent, props.path);
    const isVaultFile = !props.readOnly && isVaultPath(props.path);

    return (
        <>
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
                        <ActionMenuButton
                            disabled={props.onFindInFile === null}
                            onClick={() => {
                                close();
                                props.onFindInFile?.();
                            }}
                        >
                            <TextSearch className="h-4 w-4 text-slate-400" />
                            Find in file
                        </ActionMenuButton>
                        <ActionMenuButton
                            disabled={props.onSearchDirectory === null}
                            onClick={() => {
                                close();
                                props.onSearchDirectory?.();
                            }}
                        >
                            <Search className="h-4 w-4 text-slate-400" />
                            Search selection in file&apos;s directory
                        </ActionMenuButton>
                        <div className="my-1 border-t border-slate-800" />
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
                                    {props.isReloading
                                        ? "Reloading..."
                                        : "Reload"}
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
                        {isVaultFile ? (
                            <DecryptedDownloadMenuButton
                                onClick={() => {
                                    close();
                                    decrypted.start();
                                }}
                            />
                        ) : null}
                        {props.readOnly ? null : (
                            <>
                                <ActionMenuButton
                                    tone="danger"
                                    disabled={
                                        !props.canDelete ||
                                        props.isSaving ||
                                        getImmediateParentPath(props.path) ===
                                            null
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
            {decrypted.toast}
        </>
    );
}

/** Groups secondary editor controls at the trailing edge of the file card. */
function FileEditorSecondaryActions(props: {
    agent: Agent;
    path: string;
    fileName: string;
    readOnly: boolean;
    canEdit: boolean;
    canDelete: boolean;
    isReloading: boolean;
    isSaving: boolean;
    downloadUrl: string | null;
    isFullWindow: boolean;
    onToggleFullWindow: () => void;
    onFindInFile: (() => void) | null;
    onSearchDirectory: (() => void) | null;
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
                canDelete={props.canDelete}
                isReloading={props.isReloading}
                isSaving={props.isSaving}
                downloadUrl={props.downloadUrl}
                onFindInFile={props.onFindInFile}
                onSearchDirectory={props.onSearchDirectory}
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
    /** Deleting only needs the path, so it can be allowed while the content is unavailable. */
    canDelete: boolean;
    isDirty: boolean;
    isSaving: boolean;
    agent: Agent;
    filePath: string;
    executable: boolean;
    preview: boolean | undefined;
    previewKind: FilePreviewKind | null;
    isReloading: boolean;
    downloadUrl: string | null;
    isFullWindow: boolean;
    onSave: () => void;
    /** Opens the editor's find panel; null while there is no editor to search. */
    onFindInFile: (() => void) | null;
    /** Searches the selection from the file's directory; null without a searchable one. */
    onSearchDirectory: (() => void) | null;
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
                            executable={props.executable}
                            agent={props.agent}
                            preview={props.preview}
                            previewKind={props.previewKind}
                            onSave={props.onSave}
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
                        canDelete={props.canDelete}
                        isReloading={props.isReloading}
                        isSaving={props.isSaving}
                        downloadUrl={props.downloadUrl}
                        isFullWindow={props.isFullWindow}
                        onToggleFullWindow={props.onToggleFullWindow}
                        onFindInFile={props.onFindInFile}
                        onSearchDirectory={props.onSearchDirectory}
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
