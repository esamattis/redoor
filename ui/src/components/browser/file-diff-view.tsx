import React from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileSearch, GitCompareArrows } from "lucide-react";
import type { ApiClient, Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { AgentPathFields } from "#ui/components/browser/sync";
import { Tooltip } from "#ui/components/tooltip";
import { getErrorMessage } from "#ui/components/browser/utils";

/** Compares the selected file against an editable file on any connected agent. */
export function FileDiffView(props: {
    api: ApiClient;
    agent: Agent;
    agents: Array<Agent>;
    agentId: string;
    fileName: string;
    filePath: string;
    downloadUrl: string;
}) {
    const navigate = useNavigate();
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
    const selectedAgent = availableAgents.find(
        (agent) => agent.id === selectedAgentId,
    );
    const canOpenTarget = Boolean(
        selectedAgent && selectedPath.startsWith("/"),
    );
    const diffMutation = useMutation({
        mutationFn: () =>
            props.api.diffFiles(
                { agent: props.agentId, path: props.filePath },
                { agent: selectedAgentId, path: selectedPath },
            ),
    });

    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!selectedAgentId) {
            return;
        }

        diffMutation.mutate();
    };

    /** Opens the editable comparison endpoint without carrying over the source diff view. */
    const handleOpenTarget = () => {
        if (!selectedAgent || !selectedPath.startsWith("/")) {
            return;
        }

        void navigate({
            to: selectedAgent.getBrowserUrl(selectedPath),
            search: {},
        });
    };

    return (
        <div>
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
                        disabled={diffMutation.isPending}
                        onAgentChange={setSelectedAgentId}
                        onPathChange={setSelectedPath}
                    />
                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            type="submit"
                            size="lg"
                            disabled={
                                diffMutation.isPending || !selectedAgentId
                            }
                            isLoading={diffMutation.isPending}
                            className="rounded-md text-sm font-semibold shadow-sm shadow-blue-950/30"
                        >
                            <GitCompareArrows className="h-4 w-4" />
                            {diffMutation.isPending
                                ? "Generating diff..."
                                : "Generate diff"}
                        </Button>
                        <Tooltip content="Open the selected comparison file">
                            <Button
                                type="button"
                                variant="secondary"
                                size="lg"
                                disabled={!canOpenTarget}
                                onClick={handleOpenTarget}
                                className="rounded-md bg-slate-950 text-sm font-semibold hover:border-slate-600 hover:bg-slate-900 hover:text-white"
                            >
                                <FileSearch className="h-4 w-4" />
                                Open target file
                            </Button>
                        </Tooltip>
                    </div>
                </form>

                {diffMutation.isError ? (
                    <p
                        role="alert"
                        className="border-t border-slate-800 p-6 text-sm text-red-300 md:p-8"
                    >
                        {getErrorMessage(
                            diffMutation.error,
                            "Failed to generate diff",
                        )}
                    </p>
                ) : diffMutation.isSuccess ? (
                    <section
                        aria-label="File diff"
                        className="border-t border-slate-800 p-4 md:p-6"
                    >
                        {diffMutation.data.unified_diff ? (
                            <pre className="max-h-[70vh] overflow-auto rounded-xl border border-slate-800 bg-slate-950/80 p-4 text-sm leading-6 text-slate-200">
                                <code>{diffMutation.data.unified_diff}</code>
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
