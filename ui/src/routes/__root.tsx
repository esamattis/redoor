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
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { ArrowUpDown, Files, SquareTerminal, X } from "lucide-react";
import {
    ApiClient,
    type TransferProgressEntry,
    type ServerInfoResponse,
} from "#ui/api-client";
import { isLsDirectoryResponse, isLsFileResponse } from "#ui/ls-response";
import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";

import {
    selectedFilesAtom,
    unselectFileAtom,
    clearSelectedFilesAtom,
    type SelectedPath,
} from "#ui/selected-files";
import { IconButton } from "#ui/components/icon-button";
import { Button } from "#ui/components/button";
import {
    TransferList,
    useLastEstimatedTransferPercentage,
} from "#ui/components/transfer-list";
import { TabbedBottomDrawer } from "#ui/components/collapsible-bottom-panel";
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
import {
    isEditorInputTarget,
    isTerminalInputTarget,
    isTextEntryElement,
    isVimEditorTarget,
} from "#ui/utils/keyboard";
import { RefreshListener } from "#ui/refresh-listener";
import { emptyServerInfo } from "#ui/empty-server-info";
import { OverlayChromeLayout } from "#ui/components/overlay-chrome-layout";
import { ApplicationNavigation } from "#ui/components/application-navigation";
import { AgentNavigation } from "#ui/components/agent-navigation";
import {
    ContextualTopBar,
    type AgentViewContext,
} from "#ui/components/contextual-top-bar";
import {
    bottomDrawerActivationAtom,
    type BottomDrawerTabId,
} from "#ui/bottom-drawer-state";
import { openSideMenuAtom, usePersistentSideMenus } from "#ui/side-menu-state";

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
        if (pathname === agentPath) {
            return {
                kind: "agent",
                agent: activeAgent,
            } satisfies AgentViewContext;
        }
        if (activeAgent.status !== "connected" || activeAgent.cwd === null) {
            return null;
        }
        if (pathname === `${agentPath}/logs`) {
            return {
                kind: "logs",
                agent: activeAgent,
            } satisfies AgentViewContext;
        }
        if (pathname === `${agentPath}/trash`) {
            return {
                kind: "trash",
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

/** Resolves the closest useful shell directory from the active route's loaded data. */
function useTerminalCwd() {
    return useMatches({
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
}

function RootLayout() {
    const { agents, transferProgress: initialTransferProgress } =
        Route.useLoaderData();
    const location = useLocation();
    const router = useRouter();
    const { api, queryClient } = Route.useRouteContext();
    const [openMenu, setOpenMenu] = useAtom(openSideMenuAtom);
    const [isTerminalFullWindow, setIsTerminalFullWindow] =
        React.useState(false);
    const isPersistentSideMenus = usePersistentSideMenus();
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
    const terminalCwd = useTerminalCwd();
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
        if (isPersistentSideMenus) {
            setOpenMenu(null);
        }
    }, [isPersistentSideMenus, setOpenMenu]);

    React.useEffect(() => {
        /** Lets Escape leave ordinary text controls without stealing keys from the shell. */
        const handleGlobalFocusKeys = (event: KeyboardEvent) => {
            const activeElement = document.activeElement;
            if (
                event.key === "Escape" &&
                (isTextEntryElement(activeElement) ||
                    isEditorInputTarget(activeElement)) &&
                !isVimEditorTarget(activeElement) &&
                !isVimEditorTarget(event.target) &&
                !isTerminalInputTarget(activeElement) &&
                activeElement instanceof HTMLElement
            ) {
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
                api={api}
            />
            <OverlayChromeLayout
                isBottomChromeFullWindow={isTerminalFullWindow}
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
                    <ApplicationBottomDrawer
                        agents={agents}
                        transfers={transferProgress.transfers}
                        activeTerminalTarget={activeTerminalTarget}
                        isTerminalFullWindow={isTerminalFullWindow}
                        onTerminalFullWindowChange={setIsTerminalFullWindow}
                    />
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

/** Owns shared tool state so the application shell only supplies loaded context. */
function ApplicationBottomDrawer(props: {
    agents: RootLoaderData["agents"];
    transfers: TransferProgressEntry[];
    activeTerminalTarget: {
        agent: RootLoaderData["agents"][number];
        cwd: string;
    } | null;
    isTerminalFullWindow: boolean;
    onTerminalFullWindowChange: (isFullWindow: boolean) => void;
}) {
    const selectedFiles = useAtomValue(selectedFilesAtom);
    const drawerActivation = useAtomValue(bottomDrawerActivationAtom);
    const [activeTab, setActiveTab] =
        React.useState<BottomDrawerTabId>("terminal");
    const [isCollapsed, setIsCollapsed] = React.useState(true);
    const lastActivationRef = React.useRef(0);
    const activeTransfers = props.transfers.filter(
        (transfer) =>
            transfer.state === "active" || transfer.state === "canceling",
    );
    const lastTransferPercentage = useLastEstimatedTransferPercentage(
        props.transfers,
    );
    const transferSummary = getTransferSummary(props.transfers);

    React.useEffect(() => {
        if (drawerActivation.sequence <= lastActivationRef.current) {
            return;
        }
        lastActivationRef.current = drawerActivation.sequence;
        setActiveTab(drawerActivation.tab);
        setIsCollapsed(false);
    }, [drawerActivation]);

    return (
        <TabbedBottomDrawer
            activeTab={activeTab}
            isCollapsed={isCollapsed}
            isFullWindow={props.isTerminalFullWindow}
            onActiveTabChange={setActiveTab}
            onCollapsedChange={setIsCollapsed}
            tabs={[
                {
                    id: "selected",
                    label: "Selected",
                    icon: <Files className="h-4 w-4" />,
                    badge: `${selectedFiles.length}`,
                    content: <SelectedFilesPane agents={props.agents} />,
                },
                {
                    id: "transfers",
                    label: "Transfers",
                    icon: <ArrowUpDown className="h-4 w-4" />,
                    badge:
                        lastTransferPercentage === null
                            ? transferSummary || "0"
                            : `${lastTransferPercentage}%`,
                    content: (
                        <TransferProgressPane
                            agents={props.agents}
                            transfers={activeTransfers}
                        />
                    ),
                },
                {
                    id: "terminal",
                    label: "Terminal",
                    icon: <SquareTerminal className="h-4 w-4" />,
                    content: (
                        <TerminalPanel
                            agents={props.agents}
                            activeTarget={props.activeTerminalTarget}
                            isVisible={!isCollapsed && activeTab === "terminal"}
                            isFullWindow={props.isTerminalFullWindow}
                            onFullWindowChange={
                                props.onTerminalFullWindowChange
                            }
                        />
                    ),
                },
            ]}
        />
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
    onClearSelectedFiles: () => void;
}) {
    return (
        <div className="flex items-center gap-2">
            <Button
                type="button"
                variant="subtle"
                aria-label="Clear all selected items"
                onClick={props.onClearSelectedFiles}
                className="inline-flex h-8 items-center justify-center rounded-md px-2 text-xs font-medium text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100 sm:px-2.5"
            >
                <X className="h-4 w-4 sm:hidden" aria-hidden="true" />
                <span className="hidden sm:inline">Clear all</span>
            </Button>
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
        <div className="h-full overflow-auto bg-[#11141b]">
            <ul className="divide-y divide-slate-800/70 md:hidden">
                {props.selectedFiles.map((file) => (
                    <li
                        key={`${file.agentId}:${file.path}`}
                        className="flex min-w-0 items-start gap-3 p-3"
                    >
                        <div className="min-w-0 flex-1">
                            <Link
                                to={
                                    props.agents
                                        .find(
                                            (agent) =>
                                                agent.id === file.agentId,
                                        )
                                        ?.getBrowserUrl(file.path) ?? "/"
                                }
                                className="block break-words text-sm font-medium text-blue-400 hover:underline"
                            >
                                {file.fileName}
                            </Link>
                            <p className="mt-1 text-xs text-slate-500">
                                {file.agentName}
                            </p>
                            <p className="mt-1 break-all font-mono text-xs leading-relaxed text-slate-400">
                                {file.path}
                            </p>
                        </div>
                        <IconButton
                            type="button"
                            label={`Unselect ${file.fileName}`}
                            tooltipClassName="shrink-0"
                            onClick={() =>
                                props.onUnselectFile({
                                    agentId: file.agentId,
                                    path: file.path,
                                })
                            }
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-300 transition-colors hover:bg-white/5"
                        >
                            <X className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                    </li>
                ))}
            </ul>
            <table className="hidden min-w-[44rem] w-full md:table">
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
                                <Button
                                    type="button"
                                    variant="secondary"
                                    aria-label={`Unselect ${file.fileName}`}
                                    onClick={() =>
                                        props.onUnselectFile({
                                            agentId: file.agentId,
                                            path: file.path,
                                        })
                                    }
                                    size="sm"
                                    className="py-1.5 text-xs"
                                >
                                    <X className="h-3.5 w-3.5" />
                                    Unselect
                                </Button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/**
 * Shows globally selected items inside the shared drawer without owning its chrome.
 */
function SelectedFilesPane(props: { agents: RootLoaderData["agents"] }) {
    const selectedFiles = useAtomValue(selectedFilesAtom);
    const unselectFile = useSetAtom(unselectFileAtom);
    const clearSelectedFiles = useSetAtom(clearSelectedFilesAtom);

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

    return (
        <div className="flex h-full min-h-0 flex-col">
            {selectedFiles.length > 0 ? (
                <div className="flex shrink-0 justify-end pb-2">
                    <SelectedFilesPanelActions
                        onClearSelectedFiles={clearSelectedFiles}
                    />
                </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-slate-800">
                {selectedFiles.length > 0 ? (
                    <SelectedFilesTable
                        agents={props.agents}
                        selectedFiles={sortedSelectedFiles}
                        onUnselectFile={unselectFile}
                    />
                ) : (
                    <div className="flex h-full items-center justify-center px-4 text-center text-sm text-slate-500">
                        Select files or directories to review them here.
                    </div>
                )}
            </div>
        </div>
    );
}

/** Summarizes all transfer states without allowing polling updates to activate the drawer. */
function getTransferSummary(transfers: TransferProgressEntry[]) {
    const activeTransfers = transfers.filter(
        (transfer) => transfer.state === "active",
    );
    return [
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
            activeTransfers.filter((transfer) => transfer.direction === "edit")
                .length,
            "editing",
        ],
        [
            activeTransfers.filter((transfer) => transfer.direction === "copy")
                .length,
            "copying",
        ],
        [
            activeTransfers.filter((transfer) => transfer.direction === "move")
                .length,
            "moving",
        ],
        [
            transfers.filter((transfer) => transfer.state === "completed")
                .length,
            "completed",
        ],
        [
            transfers.filter((transfer) => transfer.state === "errored").length,
            "errored",
        ],
        [
            transfers.filter((transfer) => transfer.state === "canceled")
                .length,
            "canceled",
        ],
    ]
        .filter(([count]) => count !== 0)
        .map(([count, label]) => `${count} ${label}`)
        .join(", ");
}

/** Shows active transfers inside the shared drawer while history remains on its route. */
function TransferProgressPane(props: {
    agents: Awaited<ReturnType<ApiClient["listAgents"]>>;
    transfers: TransferProgressEntry[];
}) {
    const { api } = Route.useRouteContext();
    return (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-slate-800">
            {props.transfers.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">
                    No active transfers.{" "}
                    <Link
                        to="/transfers"
                        className="text-blue-400 hover:underline"
                    >
                        View all
                    </Link>
                </div>
            ) : (
                <TransferList
                    api={api}
                    agents={props.agents}
                    transfers={props.transfers}
                />
            )}
        </div>
    );
}
