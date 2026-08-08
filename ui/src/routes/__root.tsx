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
import {
    HardDrive,
    X,
    Files,
    Trash2,
    LoaderCircle,
    ArrowLeftRight,
} from "lucide-react";
import {
    ApiClient,
    isLsFileResponse,
    type TransferProgressEntry,
    type UiEvent,
} from "../api-client";
import type { AnyRouter } from "@tanstack/react-router";

import {
    selectedFilesAtom,
    unselectFileAtom,
    clearSelectedFilesAtom,
} from "../selected-files";
import { ConfirmationDialog } from "../components/confirmation-dialog";
import { Tooltip } from "../components/tooltip";
import { TransferList } from "../components/transfer-list";
import { CollapsibleBottomPanel } from "../components/collapsible-bottom-panel";
import { TerminalPanel } from "../components/terminal-panel";
import { getParentPath } from "../utils/path";
import {
    agentTabLocationsAtom,
    getAgentTabLocation,
    rememberAgentTabLocationAtom,
} from "../agent-tab-locations";

interface AppRouterContext {
    api: ApiClient;
}

export const ding = () => {};

export type RootLoaderData = {
    agents: Awaited<ReturnType<ApiClient["listAgents"]>>;
    transferProgress: Awaited<ReturnType<ApiClient["getTransferProgress"]>>;
};

export function getAgentFromRootLoaderData(
    loaderData: RootLoaderData,
    agentId: string,
) {
    return loaderData.agents.find((agent) => agent.id === agentId);
}

export class RefreshListener {
    private api: ApiClient;
    private router: AnyRouter;

    constructor(api: ApiClient, router: AnyRouter) {
        this.api = api;
        this.router = router;
    }
    private reconnectTimer: number | null = null;
    private websocket: WebSocket | null = null;
    private invalidateInFlight: Promise<void> | null = null;
    private invalidateQueued = false;
    private unsubscribeFromResolved: (() => void) | null = null;
    private started = false;

    start() {
        if (this.started) {
            return;
        }

        this.started = true;
        this.connect();
    }

    stop() {
        this.started = false;

        if (this.reconnectTimer !== null) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.websocket?.close();
        this.websocket = null;
        this.unsubscribeFromResolved?.();
        this.unsubscribeFromResolved = null;
        this.invalidateInFlight = null;
        this.invalidateQueued = false;
    }

    private runInvalidate() {
        if (!this.started) {
            return;
        }

        if (this.invalidateInFlight) {
            this.invalidateQueued = true;
            return;
        }

        if (this.router.state.status === "pending") {
            this.invalidateQueued = true;
            if (!this.unsubscribeFromResolved) {
                const unsubscribe = this.router.subscribe("onResolved", () => {
                    unsubscribe();
                    this.unsubscribeFromResolved = null;
                    if (this.invalidateQueued && this.started) {
                        // Let the user navigation commit before refreshing its destination loaders.
                        this.invalidateQueued = false;
                        this.runInvalidate();
                    }
                });
                this.unsubscribeFromResolved = unsubscribe;
            }
            return;
        }

        this.invalidateInFlight = this.router
            .invalidate()
            .catch(() => {})
            .then(
                () => new Promise<void>((resolve) => setTimeout(resolve, 200)),
            )
            .finally(() => {
                this.invalidateInFlight = null;

                if (this.invalidateQueued && this.started) {
                    // A refresh arrived while the previous invalidation was still running,
                    // so immediately drain the queued follow-up pass once the current one settles.
                    this.invalidateQueued = false;
                    this.runInvalidate();
                }
            });
    }

    private connect() {
        if (!this.started) {
            return;
        }

        this.websocket = new WebSocket(this.api.getUiWebSocketUrl());

        this.websocket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") {
                return;
            }

            let message: UiEvent;

            try {
                message = JSON.parse(event.data) as UiEvent;
            } catch {
                return;
            }

            if (message.type === "refresh") {
                this.runInvalidate();
            }
        });

        this.websocket.addEventListener("error", () => {
            this.websocket?.close();
        });

        this.websocket.addEventListener("close", () => {
            this.websocket = null;

            if (this.started) {
                this.reconnectTimer = window.setTimeout(() => {
                    this.reconnectTimer = null;
                    this.connect();
                }, 1000);
            }
        });
    }
}

export const Route = createRootRouteWithContext<AppRouterContext>()({
    loader: async ({ context }) => {
        const [agents, transferProgress] = await Promise.all([
            context.api.listAgents(),
            context.api.getTransferProgress(),
        ]);

        return {
            agents,
            transferProgress,
        } satisfies RootLoaderData;
    },
    component: RootLayout,
});

function RootLayout() {
    const { agents, transferProgress } = Route.useLoaderData();
    const location = useLocation();
    const rememberAgentTabLocation = useSetAtom(rememberAgentTabLocationAtom);
    const terminalCwd = useMatches({
        select: (matches) => {
            const browserMatch = matches.find(
                (match) => match.routeId === "/agents/$agentId/browser/$",
            );
            if (browserMatch?.loaderData) {
                return isLsFileResponse(browserMatch.loaderData.lsResult)
                    ? getParentPath(browserMatch.loaderData.path)
                    : browserMatch.loaderData.path;
            }

            const detailsMatch = matches.find(
                (match) => match.routeId === "/agents/$agentId/",
            );
            return detailsMatch?.loaderData?.cwd ?? null;
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

    React.useEffect(() => {
        if (!activeAgent) {
            return;
        }

        rememberAgentTabLocation({
            agentId: activeAgent.id,
            pathname: location.pathname,
        });
    }, [activeAgent, location.pathname, rememberAgentTabLocation]);

    return (
        <div className="flex h-screen flex-col bg-[#0b0d12]">
            <RouteLoadingIndicator />
            <TopTabStrip agents={sortedAgents} pathname={location.pathname} />
            <div className="flex min-h-0 flex-1 flex-col">
                <main className="flex-1 overflow-auto">
                    <Outlet />
                </main>
                {activeAgent && terminalCwd ? (
                    <TerminalPanel
                        key={activeAgent.id}
                        agent={activeAgent}
                        cwd={terminalCwd}
                    />
                ) : null}
                <SelectedFilesPanel agents={agents} />
                <TransferProgressPanel
                    agents={agents}
                    transfers={transferProgress.transfers}
                />
            </div>
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

/**
 * Browser-style tab strip that replaced the old vertical sidebar.
 *
 * Each connected agent gets its own tab plus a trailing Transfers tab. The
 * active tab connects to the content area with a lifted look so it reads as
 * the current page, mirroring how Chrome / Edge present open tabs.
 */
function TopTabStrip(props: {
    agents: RootLoaderData["agents"];
    pathname: string;
}) {
    const agentTabLocations = useAtomValue(agentTabLocationsAtom);
    const transfersActive = props.pathname.startsWith("/transfers");

    return (
        <header
            aria-label="Primary navigation"
            className="flex min-h-0 items-end gap-1 border-b border-slate-800 bg-[#0f1218] px-3 pt-2"
        >
            <BrandMark />
            <div
                role="tablist"
                aria-label="Agents and transfers"
                className="flex min-h-0 items-end gap-1 overflow-x-auto pb-0"
            >
                {props.agents.length === 0 ? (
                    <span className="px-3 pb-2 text-sm text-slate-500">
                        No agents connected
                    </span>
                ) : (
                    props.agents.map((agent) => {
                        const agentPrefix = `/agents/${encodeURIComponent(agent.id)}`;
                        const isActive =
                            props.pathname.startsWith(agentPrefix) &&
                            !transfersActive;
                        return (
                            <Link
                                key={agent.id}
                                to={getAgentTabLocation(
                                    agentTabLocations,
                                    agent.id,
                                    agent.getBrowserUrl(agent.cwd),
                                )}
                                role="tab"
                                aria-selected={isActive}
                                className={`group flex max-w-56 items-center gap-2 whitespace-nowrap rounded-t-lg border border-b-0 px-4 py-2 text-sm transition-colors ${
                                    isActive
                                        ? "border-slate-700 bg-[#161a23] text-slate-100 shadow-[0_-2px_0_0_rgb(59,130,246)_inset]"
                                        : "border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200"
                                }`}
                            >
                                <HardDrive
                                    className={`h-4 w-4 shrink-0 ${
                                        isActive
                                            ? "text-blue-400"
                                            : "text-slate-500 group-hover:text-slate-300"
                                    }`}
                                />
                                <span className="truncate font-medium">
                                    {agent.name}
                                </span>
                            </Link>
                        );
                    })
                )}
                <Link
                    to="/transfers"
                    role="tab"
                    aria-selected={transfersActive}
                    className={`group flex items-center gap-2 whitespace-nowrap rounded-t-lg border border-b-0 px-4 py-2 text-sm transition-colors ${
                        transfersActive
                            ? "border-slate-700 bg-[#161a23] text-slate-100 shadow-[0_-2px_0_0_rgb(59,130,246)_inset]"
                            : "border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200"
                    }`}
                >
                    <ArrowLeftRight
                        className={`h-4 w-4 shrink-0 ${
                            transfersActive
                                ? "text-blue-400"
                                : "text-slate-500 group-hover:text-slate-300"
                        }`}
                    />
                    <span className="font-medium">Transfers</span>
                </Link>
            </div>
        </header>
    );
}

function BrandMark() {
    return (
        <div className="mr-2 flex shrink-0 items-center gap-2 px-2 pb-2 text-slate-200">
            <img
                src="/logo.svg"
                alt=""
                className="h-5 w-5"
                aria-hidden="true"
            />
            <span className="text-sm font-semibold tracking-tight">Redoor</span>
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

type DeleteState =
    | { type: "idle" }
    | { type: "deleting" }
    | { type: "error"; message: string };

function getErrorMessage(error: unknown) {
    if (error instanceof Error) {
        return error.message;
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
    const [deleteState, setDeleteState] = React.useState<DeleteState>({
        type: "idle",
    });
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = React.useState(false);

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
        if (deleteState.type === "deleting") {
            return;
        }

        setIsDeleteDialogOpen(false);
        setDeleteState({ type: "idle" });
    };

    const handleDeleteSelectedFiles = async () => {
        if (selectedFiles.length === 0) {
            return;
        }

        setDeleteState({ type: "deleting" });

        try {
            const agentsById = new Map(
                props.agents.map((agent) => [agent.id, agent]),
            );

            const results = await Promise.allSettled(
                selectedFiles.map((file) => {
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

            const successfulDeletes = selectedFiles.filter(
                (_file, index) => results[index]?.status === "fulfilled",
            );
            const failedDeletes = results.filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );

            if (successfulDeletes.length > 0) {
                await router.invalidate();
                // Force the active route loaders to run now so the directory listing
                // reflects the deleted files before we assert on the updated UI state.
                await router.load();

                successfulDeletes.forEach((file) => {
                    unselectFile({
                        agentId: file.agentId,
                        path: file.path,
                    });
                });
            }

            if (failedDeletes.length > 0) {
                const firstFailedDelete = failedDeletes[0];
                const failureMessage = getErrorMessage(
                    firstFailedDelete ? firstFailedDelete.reason : undefined,
                ).replace(/^Upload failed$/, "Delete failed");

                setDeleteState({
                    type: "error",
                    message:
                        successfulDeletes.length > 0
                            ? `Deleted ${successfulDeletes.length} of ${selectedFiles.length} items. ${failureMessage}`
                            : failureMessage,
                });
                return;
            }

            setIsDeleteDialogOpen(false);
            setDeleteState({ type: "idle" });
        } catch (error) {
            setDeleteState({
                type: "error",
                message: getErrorMessage(error).replace(
                    /^Upload failed$/,
                    "Delete failed",
                ),
            });
        }
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
                    <div className="flex items-center gap-2">
                        {deleteState.type === "deleting" ? (
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
                                        onClick={() => {
                                            setDeleteState({ type: "idle" });
                                            setIsDeleteDialogOpen(true);
                                        }}
                                        disabled={selectedFiles.length === 0}
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
                            onClick={() => clearSelectedFiles()}
                            className="rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                        >
                            Clear all
                        </button>
                    </div>
                }
            >
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
                            {sortedSelectedFiles.map((file) => (
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
                                                            agent.id ===
                                                            file.agentId,
                                                    )
                                                    ?.getBrowserUrl(
                                                        file.path,
                                                    ) ?? "/"
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
                                                unselectFile({
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
                isBusy={deleteState.type === "deleting"}
                errorMessage={
                    deleteState.type === "error" ? deleteState.message : null
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

    if (activeTransfers.length === 0) {
        return null;
    }

    return (
        <CollapsibleBottomPanel
            title="Active transfers"
            description="Currently running file transfers"
            badge={
                <span className="rounded-md bg-slate-800 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-400">
                    {activeTransfers.length}{" "}
                    {activeTransfers.length === 1 ? "transfer" : "transfers"}
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
