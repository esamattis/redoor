import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "#ui/api-client";
import { FilePageHeader } from "#ui/components/browser/file-page-header";
import { getErrorMessage } from "#ui/components/browser/utils";
import { fileContentQueryOptions } from "#ui/queries";
import { useEditorRefreshRegistration } from "#ui/components/browser/refresh";

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
    const queryClient = useQueryClient();
    const contentQuery = useQuery(
        fileContentQueryOptions(props.agent, props.filePath),
    );
    const [draft, setDraft] = React.useState<string | null>(null);
    const saveMutation = useMutation({
        mutationFn: (nextContent: string) =>
            props.agent.upload(
                props.filePath,
                new globalThis.File([nextContent], props.fileName, {
                    type: props.mimeType || "text/plain",
                }),
            ),
        onSuccess: (_, nextContent) => {
            queryClient.setQueryData(
                fileContentQueryOptions(props.agent, props.filePath).queryKey,
                nextContent,
            );
            setDraft(null);
        },
    });
    const savedContent = contentQuery.data ?? "";
    const content = draft ?? savedContent;
    const isDirty = draft !== null && draft !== savedContent;
    const canEdit = contentQuery.isSuccess && !saveMutation.isPending;

    useEditorRefreshRegistration({
        agentId: props.agent.id,
        path: props.filePath,
        isDirty,
    });

    const handleRestore = () => {
        if (!canEdit) {
            return;
        }
        setDraft(null);
        saveMutation.reset();
    };

    const handleSave = () => {
        if (!canEdit) {
            return;
        }
        saveMutation.mutate(content);
    };

    const statusMessage = contentQuery.isPending
        ? "Loading file..."
        : contentQuery.isError
          ? getErrorMessage(contentQuery.error, "Failed to load file")
          : saveMutation.isPending
            ? "Saving..."
            : saveMutation.isSuccess
              ? "Saved"
              : saveMutation.isError
                ? getErrorMessage(saveMutation.error, "Failed to save file")
                : isDirty
                  ? "Unsaved changes"
                  : null;

    return (
        <div>
            <FilePageHeader
                agent={props.agent}
                agentId={props.agentId}
                path={props.path}
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
                                contentQuery.isError || saveMutation.isError
                            }
                            isSaved={saveMutation.isSuccess}
                            canEdit={canEdit}
                            isDirty={isDirty}
                            isSaving={saveMutation.isPending}
                            onRestore={handleRestore}
                            onSave={() => {
                                handleSave();
                            }}
                        />
                    </div>
                </header>

                <div className="p-4 md:p-6">
                    {contentQuery.isPending ? (
                        <p className="text-sm text-slate-400">
                            Loading file...
                        </p>
                    ) : contentQuery.isError ? (
                        <p className="text-sm text-red-300">
                            {getErrorMessage(
                                contentQuery.error,
                                "Failed to load file",
                            )}
                        </p>
                    ) : (
                        <textarea
                            aria-label="File editor"
                            value={content}
                            onChange={(event) => {
                                setDraft(event.target.value);
                                if (saveMutation.isSuccess) {
                                    saveMutation.reset();
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
