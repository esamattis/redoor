import * as React from "react";
import {
    Outlet,
    Link,
    useLocation,
    useMatches,
    useRouter,
    useRouterState,
    createRootRouteWithContext,
} from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { X, Files, Trash2, LoaderCircle } from "lucide-react";
import {
    ApiClient,
    isLsDirectoryResponse,
    isLsFileResponse,
    type TransferProgressEntry,
    type ServerInfoResponse,
} from "#ui/api-client";
import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";

import {
    selectedFilesAtom,
    unselectFileAtom,
    clearSelectedFilesAtom,
    type SelectedPath,
} from "#ui/selected-files";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { Tooltip } from "#ui/components/tooltip";
import {
    TransferList,
    useLastEstimatedTransferPercentage,
} from "#ui/components/transfer-list";
import { CollapsibleBottomPanel } from "#ui/components/collapsible-bottom-panel";
import { TerminalPanel } from "#ui/components/terminal-panel";
import { getParentPath } from "#ui/utils/path";
import { GlobalFileImportHandler } from "#ui/components/global-file-import-handler";
import { UploadQueueManager } from "#ui/upload-queue";
import { rememberAgentTabLocationAtom } from "#ui/agent-tab-locations";
import {
    agentsQueryOptions,
    serverInfoQueryOptions,
    transfersQueryOptions,
} from "#ui/queries";
import { userStateQueryOptions } from "#ui/user-state";
import { UserStatePersistToast } from "#ui/components/user-state-persist-toast";
import { ThemeManager } from "#ui/components/theme-toggle";
import { isTerminalInputTarget, isTextEntryElement } from "#ui/utils/keyboard";
import { RefreshListener } from "#ui/refresh-listener";
import { emptyServerInfo } from "#ui/empty-server-info";
import { OverlayChromeLayout } from "#ui/components/overlay-chrome-layout";
import { ApplicationNavigation } from "#ui/components/application-navigation";
import { AgentNavigation } from "#ui/components/agent-navigation";
import {
    ContextualTopBar,
    type AgentViewContext,
} from "#ui/components/contextual-top-bar";

interface AppRouterContext {
    api: ApiClient;
    queryClient: QueryClient;
}

export const ding = () => {};

export type RootLoaderData = {
    agents: Awaited<ReturnType<ApiClient["listAgents"]>>;
    transferProgress: Awaited<ReturnType<ApiClient["getTransferProgress"]>>;
    serverInfo: ServerInfoResponse;
};

export function getAgentFromRootLoaderData(
    loaderData: RootLoaderData,
    agentId: string,
) {
    return loaderData.agents.find((agent) => agent.id === agentId);
}

export const Route = createRootRouteWithContext<AppRouterContext>()({
    loader: async ({ context, location }) => {
        if (location.pathname === "/login") {
            return {
                agents: [],
                transferProgress: { transfers: [] },
                serverInfo: emptyServerInfo,
            } satisfies RootLoaderData;
        }

        const [agents, transferProgress, serverInfo] = await Promise.all([
            context.queryClient.fetchQuery(agentsQueryOptions(context.api)),
            context.queryClient.fetchQuery(transfersQueryOptions(context.api)),
            context.queryClient.fetchQuery(serverInfoQueryOptions(context.api)),
            context.queryClient.fetchQuery(userStateQueryOptions(context.api)),
        ]);

        return {
            agents,
            transferProgress,
            serverInfo,
        } satisfies RootLoaderData;
    },
    component: RootRouteLayout,
});

/** Keeps the login form outside the authenticated application chrome. */
function RootRouteLayout() {
    const location = useLocation();
    return location.pathname === "/login" ? <Outlet /> : <RootLayout />;
}

/** Derives contextual view navigation strictly from already loaded route and agent data. */
function useAgentViewContext(
    agents: RootLoaderData["agents"],
    activeAgent: RootLoaderData["agents"][number] | undefined,
    pathname: string,
) {
    const browserViewLocation = useMatches({
        select: (matches) => {
            const browserMatch = matches.find(
                (match) => match.routeId === "/agents/$agentId/browser/$",
            );
            const browserData = browserMatch?.loaderData;
            if (!browserData?.lsResult) {
                return null;
            }
            if (isLsDirectoryResponse(browserData.lsResult)) {
                return {
                    kind: "directory" as const,
                    agentId: browserData.agentId,
                    path: browserData.path,
                };
            }
            if (isLsFileResponse(browserData.lsResult)) {
                return {
                    kind: "file" as const,
                    agentId: browserData.agentId,
                    path: browserData.path,
                };
            }
            return null;
        },
    });

    if (browserViewLocation) {
        const browserAgent = agents.find(
            (agent) => agent.id === browserViewLocation.agentId,
        );
        if (browserAgent) {
            return {
                kind: browserViewLocation.kind,
                agent: browserAgent,
                path: browserViewLocation.path,
            } satisfies AgentViewContext;
        }
    }
    if (activeAgent) {
        const agentPath = `/agents/${encodeURIComponent(activeAgent.id)}`;
        if (
            pathname === `${agentPath}/edit` &&
            activeAgent.configurationEditable
        ) {
            return {
                kind: "configuration",
                agent: activeAgent,
            } satisfies AgentViewContext;
        }
        if (activeAgent.status !== "connected" || activeAgent.cwd === null) {
            return null;
        }
        if (pathname === agentPath) {
            return {
                kind: "agent",
                agent: activeAgent,
            } satisfies AgentViewContext;
        }
        if (pathname === `${agentPath}/logs`) {
            return {
                kind: "logs",
                agent: activeAgent,
            } satisfies AgentViewContext;
        }
    }
    return null;
}

/** Polls only while managed startup can change shell navigation without a refresh event. */
function useManagedAgentRefresh(
    agents: RootLoaderData["agents"],
    router: ReturnType<typeof useRouter>,
) {
    React.useEffect(() => {
        if (
            !agents.some(
                (agent) => agent.managed && agent.status === "starting",
            )
        ) {
            return;
        }
        let invalidating = false;
        const timer = window.setInterval(() => {
            if (invalidating) return;
            invalidating = true;
            void router.invalidate().finally(() => {
                invalidating = false;
            });
        }, 1000);
        return () => window.clearInterval(timer);
    }, [agents, router]);
}

function RootLayout() {
    const { agents, transferProgress: initialTransferProgress } =
        Route.useLoaderData();
    const location = useLocation();
    const router = useRouter();
    const { api, queryClient } = Route.useRouteContext();
    const [openMenu, setOpenMenu] = React.useState<
        "application" | "agents" | null
    >(null);
    const applicationMenuTriggerRef = React.useRef<HTMLButtonElement>(null);
    const agentMenuTriggerRef = React.useRef<HTMLButtonElement>(null);
    const { data: transferProgress } = useQuery({
        ...transfersQueryOptions(api),
        initialData: initialTransferProgress,
    });
    const rememberAgentTabLocation = useSetAtom(rememberAgentTabLocationAtom);
    const importLocation = useMatches({
        select: (matches) => {
            const browserMatch = matches.find(
                (match) => match.routeId === "/agents/$agentId/browser/$",
            );
            const browserData = browserMatch?.loaderData;
            const lsResult = browserData?.lsResult;
            if (browserData && lsResult && isLsDirectoryResponse(lsResult)) {
                return {
                    agentId: browserData.agentId,
                    path: browserData.path,
                };
            }

            return null;
        },
    });
    const importAgent = importLocation
        ? agents.find((agent) => agent.id === importLocation.agentId)
        : undefined;
    const importDestination =
        importLocation &&
        importAgent?.status === "connected" &&
        importAgent.cwd !== null
            ? { agent: importAgent, path: importLocation.path }
            : null;
    const terminalCwd = useMatches({
        select: (matches) => {
            const browserMatch = matches.find(
                (match) => match.routeId === "/agents/$agentId/browser/$",
            );
            if (browserMatch?.loaderData) {
                const lsResult = browserMatch.loaderData.lsResult;
                // Missing paths still expose a cwd so the terminal can open near the attempted location.
                if (!lsResult) {
                    return browserMatch.loaderData.path;
                }
                return isLsFileResponse(lsResult)
                    ? getParentPath(browserMatch.loaderData.path)
                    : browserMatch.loaderData.path;
            }

            const detailsMatch = matches.find(
                (match) => match.routeId === "/agents/$agentId",
            );
            return detailsMatch?.loaderData?.kind === "connected"
                ? detailsMatch.loaderData.agent.cwd
                : null;
        },
    });
    const sortedAgents = React.useMemo(() => {
        return [...agents].sort((left, right) =>
            left.name.localeCompare(right.name),
        );
    }, [agents]);
    const activeAgent = agents.find((agent) => {
        const routePrefix = `/agents/${encodeURIComponent(agent.id)}`;
        return (
            location.pathname === routePrefix ||
            location.pathname.startsWith(`${routePrefix}/`)
        );
    });
    const activeTerminalTarget =
        activeAgent?.status === "connected" && activeAgent.cwd !== null
            ? {
                  agent: activeAgent,
                  cwd: terminalCwd ?? activeAgent.cwd,
              }
            : null;
    const agentViewContext = useAgentViewContext(
        agents,
        activeAgent,
        location.pathname,
    );
    const logoutMutation = useMutation({
        mutationFn: () => api.logout(),
        onSuccess: () => {
            window.location.replace("/login");
        },
    });

    React.useEffect(() => {
        const refreshListener = new RefreshListener(api, router, queryClient);
        refreshListener.start();
        return () => refreshListener.stop();
    }, [api, queryClient, router]);

    React.useEffect(() => {
        if (
            !activeAgent ||
            activeAgent.status !== "connected" ||
            !location.pathname.includes("/browser/")
        ) {
            return;
        }

        rememberAgentTabLocation({
            agentId: activeAgent.id,
            pathname: location.pathname,
        });
    }, [activeAgent, location.pathname, rememberAgentTabLocation]);

    useManagedAgentRefresh(agents, router);

    React.useEffect(() => {
        /** Lets Escape leave text controls globally. */
        const handleGlobalFocusKeys = (event: KeyboardEvent) => {
            const activeElement = document.activeElement;
            if (
                event.key === "Escape" &&
                (isTextEntryElement(activeElement) ||
                    isTerminalInputTarget(activeElement)) &&
                activeElement instanceof HTMLElement
            ) {
                // Search inputs and the shell keep Escape unless the application owns the key.
                event.preventDefault();
                activeElement.blur();
            }
        };

        window.addEventListener("keydown", handleGlobalFocusKeys);
        return () =>
            window.removeEventListener("keydown", handleGlobalFocusKeys);
    }, []);

    return (
        <div className="flex h-dvh overflow-hidden bg-[#0b0d12]">
            <ThemeManager />
            <RouteLoadingIndicator />
            <UserStatePersistToast />
            <GlobalFileImportHandler destination={importDestination} />
            <UploadQueueManager
                agents={agents}
                onUploadsChanged={() => router.invalidate()}
            />
            <ApplicationNavigation
                pathname={location.pathname}
                isOpen={openMenu === "application"}
                isLoggingOut={logoutMutation.isPending}
                triggerRef={applicationMenuTriggerRef}
                onClose={() => setOpenMenu(null)}
                onLogout={() => logoutMutation.mutate()}
            />
            <OverlayChromeLayout
                topChrome={
                    <ContextualTopBar
                        context={agentViewContext}
                        isApplicationMenuOpen={openMenu === "application"}
                        isAgentMenuOpen={openMenu === "agents"}
                        applicationTriggerRef={applicationMenuTriggerRef}
                        agentTriggerRef={agentMenuTriggerRef}
                        onOpenApplicationMenu={() => setOpenMenu("application")}
                        onOpenAgentMenu={() => setOpenMenu("agents")}
                    />
                }
                bottomChrome={
                    <>
                        <TerminalPanel
                            agents={agents}
                            activeTarget={activeTerminalTarget}
                        />
                        <SelectedFilesPanel agents={agents} />
                        <TransferProgressPanel
                            agents={agents}
                            transfers={transferProgress.transfers}
                        />
                    </>
                }
            >
                <Outlet />
            </OverlayChromeLayout>
            <AgentNavigation
                agents={sortedAgents}
                pathname={location.pathname}
                isOpen={openMenu === "agents"}
                triggerRef={agentMenuTriggerRef}
                onClose={() => setOpenMenu(null)}
            />
            <TanStackDevtools
                config={{
                    position: "bottom-right",
                }}
                plugins={[
                    {
                        name: "Tanstack Router",
                        render: <TanStackRouterDevtoolsPanel />,
                    },
                ]}
            />
        </div>
    );
}

function RouteLoadingIndicator() {
    const isLoading = useRouterState({
        select: (state) => state.status === "pending",
    });
    const [isVisible, setIsVisible] = React.useState(false);

    React.useEffect(() => {
        if (!isLoading) {
            setIsVisible(false);
            return;
        }

        const showTimer = window.setTimeout(() => {
            setIsVisible(true);
        }, 250);

        return () => {
            window.clearTimeout(showTimer);
        };
    }, [isLoading]);

    return (
        <div
            aria-hidden={!isVisible}
            className={`pointer-events-none fixed inset-x-0 top-0 z-50 h-1 overflow-hidden transition-opacity duration-150 ${
                isVisible ? "opacity-100" : "opacity-0"
            }`}
        >
            <div className="route-loading-progress-bar h-full w-full bg-blue-500/10">
                <div className="route-loading-progress-bar__indicator h-full bg-blue-400" />
            </div>
        </div>
    );
}

/** Renders controls that operate on the complete selected-items list. */
function SelectedFilesPanelActions(props: {
    isDeleting: boolean;
    selectedFileCount: number;
    onOpenDeleteDialog: () => void;
    onClearSelectedFiles: () => void;
}) {
    return (
        <div className="flex items-center gap-2">
            {props.isDeleting ? (
                <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-red-500/10 text-red-400"
                    aria-label="Deleting selected items"
                    role="status"
                >
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                </span>
            ) : (
                <Tooltip content="Delete selected items">
                    <span className="inline-flex">
                        <button
                            type="button"
                            onClick={props.onOpenDeleteDialog}
                            disabled={props.selectedFileCount === 0}
                            aria-label="Delete selected items"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Trash2 className="h-4 w-4" />
                        </button>
                    </span>
                </Tooltip>
            )}

            <button
                type="button"
                onClick={props.onClearSelectedFiles}
                className="rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
            >
                Clear all
            </button>
        </div>
    );
}

/** Displays selected paths in their scan-friendly order with per-item removal controls. */
function SelectedFilesTable(props: {
    agents: RootLoaderData["agents"];
    selectedFiles: SelectedPath[];
    onUnselectFile: (file: Pick<SelectedPath, "agentId" | "path">) => void;
}) {
    return (
        <div className="max-h-64 overflow-auto bg-[#11141b]">
            <table className="w-full">
                <thead className="sticky top-0 bg-[#1a1f2a]">
                    <tr className="border-b border-slate-800">
                        <th className="p-3 text-left text-sm font-medium text-slate-400">
                            Agent
                        </th>
                        <th className="p-3 text-left text-sm font-medium text-slate-400">
                            Item
                        </th>
                        <th className="p-3 text-left text-sm font-medium text-slate-400">
                            Path
                        </th>
                        <th className="p-3 text-left text-sm font-medium text-slate-400">
                            Action
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {props.selectedFiles.map((file) => (
                        <tr
                            key={`${file.agentId}:${file.path}`}
                            className="border-b border-slate-800/60 last:border-b-0 hover:bg-white/5 align-top"
                        >
                            <td className="p-3">
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium text-slate-100">
                                        {file.agentName}
                                    </span>
                                    <span className="text-xs text-slate-500">
                                        {file.agentId}
                                    </span>
                                </div>
                            </td>
                            <td className="p-3">
                                <Link
                                    to={
                                        props.agents
                                            .find(
                                                (agent) =>
                                                    agent.id === file.agentId,
                                            )
                                            ?.getBrowserUrl(file.path) ?? "/"
                                    }
                                    className="text-sm font-medium text-blue-400 hover:underline"
                                >
                                    {file.fileName}
                                </Link>
                            </td>
                            <td className="p-3">
                                <div className="break-all font-mono text-xs text-slate-300">
                                    {file.path}
                                </div>
                            </td>
                            <td className="p-3">
                                <button
                                    type="button"
                                    aria-label={`Unselect ${file.fileName}`}
                                    onClick={() =>
                                        props.onUnselectFile({
                                            agentId: file.agentId,
                                            path: file.path,
                                        })
                                    }
                                    className="inline-flex items-center gap-2 rounded border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5"
                                >
                                    <X className="h-3.5 w-3.5" />
                                    Unselect
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function getErrorMessage(cause: unknown) {
    if (cause instanceof Error) {
        return cause.message;
    }

    return "Upload failed";
}

/**
 * Shows the globally selected items so they can be reviewed, cleared, or deleted.
 */
function SelectedFilesPanel(props: { agents: RootLoaderData["agents"] }) {
    const router = useRouter();
    const selectedFiles = useAtomValue(selectedFilesAtom);
    const unselectFile = useSetAtom(unselectFileAtom);
    const clearSelectedFiles = useSetAtom(clearSelectedFilesAtom);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);
    const deleteMutation = useMutation({
        mutationFn: async (files: SelectedPath[]) => {
            const agentsById = new Map(
                props.agents.map((agent) => [agent.id, agent]),
            );
            const results = await Promise.allSettled(
                files.map((file) => {
                    const agent = agentsById.get(file.agentId);
                    if (!agent) {
                        return Promise.reject(
                            new Error(
                                `Agent unavailable for selected item: ${file.agentId}`,
                            ),
                        );
                    }
                    return agent.deleteFile(file.path);
                }),
            );
            const successfulDeletes = files.filter(
                (_file, index) => results[index]?.status === "fulfilled",
            );
            const failedDeletes = results.filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );

            if (successfulDeletes.length > 0) {
                await router.invalidate();
                await router.load();
                successfulDeletes.forEach((file) => {
                    unselectFile({ agentId: file.agentId, path: file.path });
                });
            }

            if (failedDeletes.length > 0) {
                const firstFailedDelete = failedDeletes[0];
                const failureMessage = getErrorMessage(
                    firstFailedDelete ? firstFailedDelete.reason : undefined,
                ).replace(/^Upload failed$/, "Delete failed");
                throw new Error(
                    successfulDeletes.length > 0
                        ? `Deleted ${successfulDeletes.length} of ${files.length} items. ${failureMessage}`
                        : failureMessage,
                );
            }
        },
        onSuccess: () => {
            setIsDeleteDialogOpen(false);
        },
    });

    if (selectedFiles.length === 0) {
        return null;
    }

    // Sort selected files case-insensitively with dot-prefixed items first so
    // the list is stable and easy to scan.
    const sortedSelectedFiles = [...selectedFiles].sort((a, b) => {
        const aIsDot = a.fileName.startsWith(".");
        const bIsDot = b.fileName.startsWith(".");
        if (aIsDot !== bIsDot) {
            return aIsDot ? -1 : 1;
        }
        return a.fileName.localeCompare(b.fileName, undefined, {
            sensitivity: "base",
        });
    });

    /** Keeps destructive confirmation visible while its request is in flight. */
    const closeDeleteDialog = () => {
        if (deleteMutation.isPending) {
            return;
        }

        setIsDeleteDialogOpen(false);
        deleteMutation.reset();
    };

    const handleDeleteSelectedFiles = () => {
        if (selectedFiles.length === 0) {
            return;
        }
        deleteMutation.mutate([...selectedFiles]);
    };

    return (
        <>
            <CollapsibleBottomPanel
                title="Selected items"
                description="Files and directories selected for copy operations"
                icon={<Files className="h-4 w-4" />}
                badge={
                    <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-400">
                        {selectedFiles.length}{" "}
                        {selectedFiles.length === 1 ? "item" : "items"}
                    </span>
                }
                actions={
                    <SelectedFilesPanelActions
                        isDeleting={deleteMutation.isPending}
                        selectedFileCount={selectedFiles.length}
                        onOpenDeleteDialog={() => {
                            deleteMutation.reset();
                            setIsDeleteDialogOpen(true);
                        }}
                        onClearSelectedFiles={clearSelectedFiles}
                    />
                }
            >
                <SelectedFilesTable
                    agents={props.agents}
                    selectedFiles={sortedSelectedFiles}
                    onUnselectFile={unselectFile}
                />
            </CollapsibleBottomPanel>

            <ConfirmationDialog
                isOpen={isDeleteDialogOpen}
                title={`Delete ${selectedFiles.length === 1 ? "this item" : "these items"}?`}
                description={`This permanently deletes ${selectedFiles.length} selected ${selectedFiles.length === 1 ? "item" : "items"} from the agent filesystem.`}
                confirmLabel={
                    selectedFiles.length === 1
                        ? "Delete item"
                        : `Delete ${selectedFiles.length} items`
                }
                busyLabel="Deleting..."
                isBusy={deleteMutation.isPending}
                errorMessage={
                    deleteMutation.isError
                        ? getErrorMessage(deleteMutation.error).replace(
                              /^Upload failed$/,
                              "Delete failed",
                          )
                        : null
                }
                onClose={closeDeleteDialog}
                onConfirm={handleDeleteSelectedFiles}
            />
        </>
    );
}

function TransferProgressPanel(props: {
    agents: Awaited<ReturnType<ApiClient["listAgents"]>>;
    transfers: TransferProgressEntry[];
}) {
    const activeTransfers = props.transfers.filter(
        (transfer) => transfer.state === "active",
    );
    const lastTransferPercentage = useLastEstimatedTransferPercentage(
        props.transfers,
    );
    const summary = [
        [
            activeTransfers.filter(
                (transfer) => transfer.direction === "download",
            ).length,
            "downloading",
        ],
        [
            activeTransfers.filter(
                (transfer) => transfer.direction === "upload",
            ).length,
            "uploading",
        ],
        [
            activeTransfers.filter((transfer) => transfer.direction === "copy")
                .length,
            "copying",
        ],
        [
            props.transfers.filter((transfer) => transfer.state === "completed")
                .length,
            "completed",
        ],
        [
            props.transfers.filter((transfer) => transfer.state === "errored")
                .length,
            "errored",
        ],
    ]
        .filter(([count]) => count !== 0)
        .map(([count, label]) => `${count} ${label}`)
        .join(", ");

    return (
        <CollapsibleBottomPanel
            title="Transfers"
            titleSuffix={
                lastTransferPercentage === null
                    ? undefined
                    : ` ${lastTransferPercentage}%`
            }
            defaultCollapsed
            badge={
                <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-400">
                    {summary || "No transfers"}
                </span>
            }
            actions={
                <Link
                    to="/transfers"
                    className="rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                >
                    View all
                </Link>
            }
        >
            <div className="max-h-64">
                <TransferList
                    agents={props.agents}
                    transfers={activeTransfers}
                />
            </div>
        </CollapsibleBottomPanel>
    );
}
