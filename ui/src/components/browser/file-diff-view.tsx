import React from "react";
import { GitCompareArrows } from "lucide-react";
import type { ApiClient, Agent } from "#ui/api-client";
import { FilePageHeader } from "#ui/components/browser/file-page-header";
import { AgentPathFields } from "#ui/components/browser/sync";
import { getErrorMessage } from "#ui/components/browser/utils";

type FileDiffState =
    | { type: "idle" }
    | { type: "loading" }
    | { type: "success"; diff: string }
    | { type: "error"; message: string };

/** Compares the selected file against an editable file on any connected agent. */
export function FileDiffView(props: {
    api: ApiClient;
    agent: Agent;
    agents: Array<Agent>;
    agentId: string;
    path: string;
    fileName: string;
    filePath: string;
    downloadUrl: string;
}) {
    const availableAgents = props.agents.filter(
        (agent) => agent.status === "connected",
    );
    const defaultAgent =
        availableAgents.find((agent) => agent.id !== props.agentId) ??
        availableAgents[0];
    const [selectedAgentId, setSelectedAgentId] = React.useState(
        defaultAgent?.id ?? "",
    );
    const [selectedPath, setSelectedPath] = React.useState(props.filePath);
    const [state, setState] = React.useState<FileDiffState>({ type: "idle" });

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!selectedAgentId) {
            return;
        }

        setState({ type: "loading" });
        try {
            const response = await props.api.diffFiles(
                { agent: props.agentId, path: props.filePath },
                { agent: selectedAgentId, path: selectedPath },
            );
            setState({ type: "success", diff: response.unified_diff });
        } catch (error) {
            setState({
                type: "error",
                message: getErrorMessage(error, "Failed to generate diff"),
            });
        }
    };

    return (
        <div>
            <FilePageHeader
                agent={props.agent}
                agentId={props.agentId}
                path={props.path}
                fileName={props.fileName}
                downloadUrl={props.downloadUrl}
                activeView="diff"
            />

            <article className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
                <header className="border-b border-slate-800 p-6 md:p-8">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">
                        Compare file
                    </p>
                    <h1
                        aria-label="File name"
                        className="break-all text-2xl font-bold tracking-tight text-slate-50 md:text-3xl"
                    >
                        {props.fileName}
                    </h1>
                </header>

                <form className="grid gap-5 p-6 md:p-8" onSubmit={handleSubmit}>
                    <AgentPathFields
                        agents={availableAgents}
                        agentId={selectedAgentId}
                        path={selectedPath}
                        operation="Diff"
                        disabled={state.type === "loading"}
                        onAgentChange={setSelectedAgentId}
                        onPathChange={setSelectedPath}
                    />
                    <div>
                        <button
                            type="submit"
                            disabled={
                                state.type === "loading" || !selectedAgentId
                            }
                            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-950/30 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <GitCompareArrows className="h-4 w-4" />
                            {state.type === "loading"
                                ? "Generating diff..."
                                : "Generate diff"}
                        </button>
                    </div>
                </form>

                {state.type === "error" ? (
                    <p
                        role="alert"
                        className="border-t border-slate-800 p-6 text-sm text-red-300 md:p-8"
                    >
                        {state.message}
                    </p>
                ) : state.type === "success" ? (
                    <section
                        aria-label="File diff"
                        className="border-t border-slate-800 p-4 md:p-6"
                    >
                        {state.diff ? (
                            <pre className="max-h-[70vh] overflow-auto rounded-xl border border-slate-800 bg-slate-950/80 p-4 text-sm leading-6 text-slate-200">
                                <code>{state.diff}</code>
                            </pre>
                        ) : (
                            <p className="text-sm text-slate-400">
                                The files are identical.
                            </p>
                        )}
                    </section>
                ) : null}
            </article>
        </div>
    );
}
