import React from "react";
import type { Agent } from "#ui/api-client";
import { FilePageHeader } from "#ui/components/browser/file-page-header";
import { getErrorMessage } from "#ui/components/browser/utils";

type FileEditLoadState =
    | { type: "loading" }
    | { type: "ready" }
    | { type: "error"; message: string };

type FileEditSaveState =
    | { type: "idle" }
    | { type: "saving" }
    | { type: "saved" }
    | { type: "error"; message: string };

/** Keeps save state and editor mutations inside the representation they affect. */
function FileEditActions(props: {
    statusMessage: string | null;
    hasError: boolean;
    isSaved: boolean;
    canEdit: boolean;
    isDirty: boolean;
    isSaving: boolean;
    onRestore: () => void;
    onSave: () => void;
}) {
    return (
        <>
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
            <button
                type="button"
                aria-label="Restore file contents"
                onClick={props.onRestore}
                disabled={!props.canEdit || !props.isDirty}
                className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
                Restore
            </button>
            <button
                type="button"
                aria-label="Save file"
                onClick={props.onSave}
                disabled={!props.canEdit || !props.isDirty}
                className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm shadow-blue-950/30 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
                {props.isSaving ? "Saving..." : "Save"}
            </button>
        </>
    );
}

/** Edits plain-text file contents in one textarea with explicit save/restore. */
export function FileEditView(props: {
    agent: Agent;
    agentId: string;
    path: string;
    fileName: string;
    filePath: string;
    mimeType: string;
    downloadUrl: string;
}) {
    const agentRef = React.useRef(props.agent);
    agentRef.current = props.agent;
    const [loadState, setLoadState] = React.useState<FileEditLoadState>({
        type: "loading",
    });
    const [saveState, setSaveState] = React.useState<FileEditSaveState>({
        type: "idle",
    });
    const [savedContent, setSavedContent] = React.useState("");
    const [content, setContent] = React.useState("");

    React.useEffect(() => {
        let cancelled = false;

        const loadContent = async () => {
            setLoadState({ type: "loading" });
            setSaveState({ type: "idle" });

            try {
                // Read through a ref so route loader identity changes do not wipe in-progress edits.
                const response = await agentRef.current.download(
                    props.filePath,
                );
                const text = await response.text();
                if (cancelled) {
                    return;
                }
                setSavedContent(text);
                setContent(text);
                setLoadState({ type: "ready" });
            } catch (error) {
                if (cancelled) {
                    return;
                }
                setLoadState({
                    type: "error",
                    message: getErrorMessage(error, "Failed to load file"),
                });
            }
        };

        void loadContent();

        return () => {
            cancelled = true;
        };
    }, [props.filePath]);

    const isDirty = content !== savedContent;
    const isSaving = saveState.type === "saving";
    const canEdit = loadState.type === "ready" && !isSaving;

    const handleRestore = () => {
        if (!canEdit) {
            return;
        }
        setContent(savedContent);
        setSaveState({ type: "idle" });
    };

    const handleSave = async () => {
        if (!canEdit) {
            return;
        }

        setSaveState({ type: "saving" });

        try {
            await agentRef.current.upload(
                props.filePath,
                new globalThis.File([content], props.fileName, {
                    type: props.mimeType || "text/plain",
                }),
            );
            setSavedContent(content);
            setSaveState({ type: "saved" });
        } catch (error) {
            setSaveState({
                type: "error",
                message: getErrorMessage(error, "Failed to save file"),
            });
        }
    };

    const statusMessage =
        loadState.type === "loading"
            ? "Loading file..."
            : loadState.type === "error"
              ? loadState.message
              : saveState.type === "saving"
                ? "Saving..."
                : saveState.type === "saved"
                  ? "Saved"
                  : saveState.type === "error"
                    ? saveState.message
                    : isDirty
                      ? "Unsaved changes"
                      : null;

    return (
        <div>
            <FilePageHeader
                agent={props.agent}
                agentId={props.agentId}
                path={props.path}
                fileName={props.fileName}
                downloadUrl={props.downloadUrl}
                activeView="view"
            />

            <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
                <header className="border-b border-slate-800 p-6 md:p-8">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                        Edit file
                    </p>
                    <h1
                        aria-label="File name"
                        className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                    >
                        {props.fileName}
                    </h1>
                    <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                        <FileEditActions
                            statusMessage={statusMessage}
                            hasError={
                                loadState.type === "error" ||
                                saveState.type === "error"
                            }
                            isSaved={saveState.type === "saved"}
                            canEdit={canEdit}
                            isDirty={isDirty}
                            isSaving={isSaving}
                            onRestore={handleRestore}
                            onSave={() => {
                                void handleSave();
                            }}
                        />
                    </div>
                </header>

                <div className="p-4 md:p-6">
                    {loadState.type === "loading" ? (
                        <p className="text-sm text-slate-400">
                            Loading file...
                        </p>
                    ) : loadState.type === "error" ? (
                        <p className="text-sm text-red-300">
                            {loadState.message}
                        </p>
                    ) : (
                        <textarea
                            aria-label="File editor"
                            value={content}
                            onChange={(event) => {
                                setContent(event.target.value);
                                if (saveState.type === "saved") {
                                    setSaveState({ type: "idle" });
                                }
                            }}
                            disabled={!canEdit}
                            spellCheck={false}
                            className="min-h-[70vh] w-full resize-y rounded-xl border border-slate-700 bg-slate-950/80 p-4 font-mono text-sm leading-6 text-slate-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                    )}
                </div>
            </article>
        </div>
    );
}

/** Renders agent-verified images through the authenticated raw download URL. */
export function FileImageView(props: {
    agent: Agent;
    agentId: string;
    path: string;
    fileName: string;
    downloadUrl: string;
}) {
    return (
        <div>
            <FilePageHeader
                agent={props.agent}
                agentId={props.agentId}
                path={props.path}
                fileName={props.fileName}
                downloadUrl={props.downloadUrl}
                activeView="view"
            />

            <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
                <header className="border-b border-slate-800 p-6 md:p-8">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                        Image
                    </p>
                    <h1
                        aria-label="File name"
                        className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                    >
                        {props.fileName}
                    </h1>
                </header>

                <div className="flex items-center justify-center p-4 md:p-6">
                    <img
                        src={props.downloadUrl}
                        alt={props.fileName}
                        className="max-h-[70vh] max-w-full rounded-xl object-contain"
                    />
                </div>
            </article>
        </div>
    );
}

/** Explains that the agent did not mark this path as text-editable or image-viewable. */
export function UnsupportedFileView(props: {
    agent: Agent;
    agentId: string;
    path: string;
    fileName: string;
    downloadUrl: string;
}) {
    return (
        <div>
            <FilePageHeader
                agent={props.agent}
                agentId={props.agentId}
                path={props.path}
                fileName={props.fileName}
                downloadUrl={props.downloadUrl}
                activeView="view"
            />

            <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
                <header className="border-b border-slate-800 p-6 md:p-8">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                        Unsupported file
                    </p>
                    <h1
                        aria-label="File name"
                        className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                    >
                        {props.fileName}
                    </h1>
                </header>

                <div className="p-6 md:p-8">
                    <p
                        aria-label="Unsupported file type"
                        className="text-sm text-slate-300"
                    >
                        Viewing this file type is not supported
                    </p>
                </div>
            </article>
        </div>
    );
}
