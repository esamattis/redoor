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
    LogOut,
    Home,
    Menu,
    ScrollText,
    Users,
    Plus,
} from "lucide-react";
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
import { Dialog } from "#ui/components/dialog";
import { Tooltip } from "#ui/components/tooltip";
import { TransferList } from "#ui/components/transfer-list";
import { CollapsibleBottomPanel } from "#ui/components/collapsible-bottom-panel";
import { TerminalPanel } from "#ui/components/terminal-panel";
import { getParentPath } from "#ui/utils/path";
import { GlobalFileImportHandler } from "#ui/components/global-file-import-handler";
import { UploadQueueManager } from "#ui/upload-queue";
import {
    agentTabLocationsAtom,
    getAgentTabLocation,
    rememberAgentTabLocationAtom,
} from "#ui/agent-tab-locations";
import {
    agentStartStatesAtom,
    getStartErrorMessage,
} from "#ui/agent-start-state";
import {
    agentsQueryOptions,
    serverInfoQueryOptions,
    transfersQueryOptions,
} from "#ui/queries";
import { userStateQueryOptions } from "#ui/user-state";
import { UserStatePersistToast } from "#ui/components/user-state-persist-toast";
import { isTerminalInputTarget, isTextEntryElement } from "#ui/utils/keyboard";
import { RefreshListener } from "#ui/refresh-listener";

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

const emptyServerInfo: ServerInfoResponse = {
    app_name: "",
    agent_token: "",
    config_path: "",
    exe_path: "",
    auth_mode: "toml",
    external_ip: null,
    os: "",
    arch: "",
    version: "",
    git_rev: "",
    git_dirty: false,
    version_dirty: false,
    build_mode: "debug",
    build_date: "",
};

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

function RootLayout() {
    const { agents, transferProgress: initialTransferProgress } =
        Route.useLoaderData();
    const location = useLocation();
    const router = useRouter();
    const { api, queryClient } = Route.useRouteContext();
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
                (match) => match.routeId === "/agents/$agentId/",
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
        <div className="flex h-screen flex-col bg-[#0b0d12]">
            <RouteLoadingIndicator />
            <UserStatePersistToast />
            <GlobalFileImportHandler destination={importDestination} />
            <UploadQueueManager
                agents={agents}
                onUploadsChanged={() => router.invalidate()}
            />
            <TopTabStrip agents={sortedAgents} pathname={location.pathname} />
            <div className="flex min-h-0 flex-1 flex-col">
                <main className="flex-1 overflow-auto">
                    <Outlet />
                </main>
                <TerminalPanel
                    agents={agents}
                    activeTarget={activeTerminalTarget}
                />
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
 * Every retained agent gets a tab. The active tab connects to the content
 * area with a lifted look so it reads as the current page, mirroring how
 * Chrome / Edge present open tabs.
 */
function TopTabStrip(props: {
    agents: RootLoaderData["agents"];
    pathname: string;
}) {
    const agentTabLocations = useAtomValue(agentTabLocationsAtom);
    const setStartStates = useSetAtom(agentStartStatesAtom);
    const router = useRouter();
    const { api } = Route.useRouteContext();
    const [isMenuOpen, setIsMenuOpen] = React.useState(false);
    const menuButtonRef = React.useRef<HTMLButtonElement>(null);
    const startMutation = useMutation({
        mutationFn: (agent: RootLoaderData["agents"][number]) => agent.start(),
        onMutate: (agent) => {
            setStartStates((states) => ({
                ...states,
                [agent.id]: {
                    starting: true,
                    error: null,
                    autoRedirect: true,
                },
            }));
            void router.navigate({
                to: "/agents/$agentId",
                params: { agentId: agent.id },
            });
        },
        onSuccess: () => router.invalidate(),
        onError: (error, agent) => {
            setStartStates((states) => ({
                ...states,
                [agent.id]: {
                    starting: false,
                    error: getStartErrorMessage(error),
                    autoRedirect: true,
                },
            }));
        },
    });
    const logoutMutation = useMutation({
        mutationFn: () => api.logout(),
        onSuccess: () => {
            window.location.replace("/login");
        },
    });

    /** Opens status immediately, then starts the managed process without blocking navigation. */
    const openManagedAgent = (agent: RootLoaderData["agents"][number]) => {
        startMutation.mutate(agent);
    };

    return (
        <header
            aria-label="Primary navigation"
            className="flex min-h-0 min-w-0 items-end gap-1 border-b border-slate-800 bg-[#0f1218] px-3 pt-2"
        >
            <BrandMark />
            <div
                role="tablist"
                aria-label="Agents"
                className="flex min-h-0 min-w-0 flex-1 items-end gap-1 overflow-x-auto overscroll-x-contain pb-0"
            >
                {props.agents.length === 0 ? (
                    <span className="px-3 pb-2 text-sm text-slate-500">
                        No agents configured or connected
                    </span>
                ) : (
                    props.agents.map((agent) => {
                        const agentPrefix = `/agents/${encodeURIComponent(agent.id)}`;
                        const isActive =
                            props.pathname === agentPrefix ||
                            props.pathname.startsWith(`${agentPrefix}/`);
                        const canBrowse =
                            agent.status === "connected" && agent.cwd !== null;
                        const target = canBrowse
                            ? getAgentTabLocation(
                                  agentTabLocations,
                                  agent.id,
                                  agent.getBrowserUrl(agent.cwd),
                              )
                            : `/agents/${encodeURIComponent(agent.id)}`;
                        const shouldStart =
                            agent.managed &&
                            (agent.status === "stopped" ||
                                agent.status === "disconnected");
                        return (
                            <Link
                                key={agent.id}
                                to={target}
                                onClick={(event) => {
                                    if (shouldStart) {
                                        event.preventDefault();
                                        openManagedAgent(agent);
                                    }
                                }}
                                role="tab"
                                aria-label={`${agent.name}, ${agent.status}`}
                                aria-selected={isActive}
                                className={`group flex max-w-56 shrink-0 items-center gap-2 whitespace-nowrap rounded-t-lg border border-b-0 px-4 py-2 text-sm transition-colors ${
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
                <Tooltip content="Add SSH agent">
                    <Link
                        to="/agents/new"
                        aria-label="Add SSH agent"
                        className={`mb-1 flex shrink-0 items-center justify-center rounded-md border p-2 transition-colors ${
                            props.pathname === "/agents/new"
                                ? "border-blue-500/60 bg-blue-500/15 text-blue-300"
                                : "border-slate-700 text-slate-400 hover:border-slate-600 hover:bg-white/5 hover:text-slate-200"
                        }`}
                    >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                    </Link>
                </Tooltip>
            </div>
            <button
                ref={menuButtonRef}
                type="button"
                aria-label="Open menu"
                aria-haspopup="dialog"
                aria-expanded={isMenuOpen}
                onClick={() => setIsMenuOpen(true)}
                className="mb-1 flex shrink-0 items-center justify-center rounded p-2 text-slate-400 hover:bg-white/5 hover:text-slate-200"
            >
                <Menu className="h-5 w-5" />
            </button>
            <Dialog
                isOpen={isMenuOpen}
                title="Menu"
                closeAriaLabel="Close menu"
                isBusy={logoutMutation.isPending}
                anchorRef={menuButtonRef}
                onClose={() => {
                    if (!logoutMutation.isPending) {
                        setIsMenuOpen(false);
                    }
                }}
            >
                <ApplicationMenu
                    pathname={props.pathname}
                    isLoggingOut={logoutMutation.isPending}
                    onClose={() => setIsMenuOpen(false)}
                    onLogout={() => logoutMutation.mutate()}
                />
            </Dialog>
        </header>
    );
}

/** Keeps the dialog navigation markup separate from the tab-strip state and agent controls. */
function ApplicationMenu(props: {
    pathname: string;
    isLoggingOut: boolean;
    onClose: () => void;
    onLogout: () => void;
}) {
    const menuItems = [
        { to: "/", label: "Home", ariaLabel: "Server home", icon: Home },
        {
            to: "/agents",
            label: "Agents",
            ariaLabel: "Manage agents",
            icon: Users,
        },
        { to: "/logs", label: "Server logs", icon: ScrollText },
        { to: "/transfers", label: "Transfers", icon: ArrowLeftRight },
    ] as const;

    return (
        <nav aria-label="Application" className="mt-3 flex flex-col gap-1">
            {menuItems.map((item) => {
                const isActive =
                    item.to === "/transfers"
                        ? props.pathname.startsWith(item.to)
                        : props.pathname === item.to;
                const Icon = item.icon;
                return (
                    <Link
                        key={item.to}
                        to={item.to}
                        aria-label={
                            "ariaLabel" in item ? item.ariaLabel : undefined
                        }
                        aria-current={isActive ? "page" : undefined}
                        onClick={props.onClose}
                        className={`flex items-center gap-2.5 rounded px-3 py-2.5 text-sm transition-colors ${
                            isActive
                                ? "bg-white/5 text-slate-100"
                                : "text-slate-300 hover:bg-white/5 hover:text-slate-100"
                        }`}
                    >
                        <Icon
                            className="h-4 w-4 shrink-0 text-slate-400"
                            aria-hidden="true"
                        />
                        {item.label}
                    </Link>
                );
            })}
            <button
                type="button"
                onClick={props.onLogout}
                disabled={props.isLoggingOut}
                className="flex items-center gap-2.5 rounded px-3 py-2.5 text-left text-sm text-slate-300 hover:bg-white/5 hover:text-slate-100 disabled:cursor-wait disabled:opacity-60"
            >
                {props.isLoggingOut ? (
                    <LoaderCircle
                        className="h-4 w-4 shrink-0 animate-spin text-slate-400"
                        aria-hidden="true"
                    />
                ) : (
                    <LogOut
                        className="h-4 w-4 shrink-0 text-slate-400"
                        aria-hidden="true"
                    />
                )}
                {props.isLoggingOut ? "Logging out…" : "Log out"}
            </button>
        </nav>
    );
}

function BrandMark() {
    return (
        <Link
            to="/"
            tabIndex={-1}
            className="mr-2 flex shrink-0 items-center gap-2 px-2 pb-2 text-slate-200 hover:text-white"
        >
            <img
                src="/logo.svg"
                alt=""
                className="h-5 w-5"
                aria-hidden="true"
            />
            <span className="hidden text-sm font-semibold tracking-tight sm:inline">
                Redoor
            </span>
        </Link>
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
