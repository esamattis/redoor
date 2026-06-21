import * as React from "react";
import {
    Outlet,
    Link,
    useLocation,
    useRouter,
    useRouterState,
    createRootRouteWithContext,
} from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import {
    HardDrive,
    Copy,
    X,
    Files,
    ChevronDown,
    ChevronUp,
    Trash2,
    LoaderCircle,
    ArrowLeftRight,
} from "lucide-react";
import {
    ApiClient,
    type TransferProgressEntry,
    type UiEvent,
    type Agent,
} from "../api-client";
import type { AnyRouter } from "@tanstack/react-router";

import {
    selectedFilesAtom,
    unselectFileAtom,
    clearSelectedFilesAtom,
} from "../selected-files";
import { Tooltip } from "../components/tooltip";
import { TransferList } from "../components/transfer-list";

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
    const sortedAgents = React.useMemo(() => {
        return [...agents].sort((left, right) =>
            left.name.localeCompare(right.name),
        );
    }, [agents]);

    return (
        <div className="flex h-screen flex-col bg-[#0b0d12]">
            <RouteLoadingIndicator />
            <TopTabStrip agents={sortedAgents} pathname={location.pathname} />
            <div className="flex min-h-0 flex-1 flex-col">
                <main className="flex-1 overflow-auto">
                    <Outlet />
                </main>
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
                                to="/agents/$agentId/browser/$"
                                params={{
                                    agentId: agent.id,
                                    _splat: undefined,
                                }}
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

function CollapsibleBottomPanel(props: {
    title: string;
    description: string;
    badge: React.ReactNode;
    actions?: React.ReactNode;
    icon?: React.ReactNode;
    children: React.ReactNode;
    defaultCollapsed?: boolean;
}) {
    const [isCollapsed, setIsCollapsed] = React.useState(
        props.defaultCollapsed ?? false,
    );

    return (
        <section className="sticky bottom-0 z-10 border-t border-slate-800 bg-[#11141b]/95 shadow-[0_-10px_30px_-12px_rgba(0,0,0,0.6)] backdrop-blur supports-[backdrop-filter]:bg-[#11141b]/80">
            <div>
                <div className="max-w-full bg-[#11141b]/90 p-4">
                    <div className="flex items-center justify-between gap-3 pb-3">
                        <div className="flex items-start gap-3">
                            {props.icon ? (
                                <div className="bg-blue-500/10 p-2 text-blue-300">
                                    {props.icon}
                                </div>
                            ) : null}
                            <div>
                                <h2 className="text-sm font-semibold text-slate-100">
                                    {props.title}
                                </h2>
                                <p className="text-xs text-slate-400">
                                    {props.description}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {props.badge}
                            {props.actions}
                            <button
                                type="button"
                                aria-label={`${isCollapsed ? "Expand" : "Minimize"} ${props.title}`}
                                aria-expanded={!isCollapsed}
                                onClick={() =>
                                    setIsCollapsed((value) => !value)
                                }
                                className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs font-medium text-slate-200 shadow-sm hover:bg-slate-700/60"
                            >
                                {isCollapsed ? (
                                    <ChevronUp className="h-3.5 w-3.5" />
                                ) : (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                )}
                                {isCollapsed ? "Expand" : "Minimize"}
                            </button>
                        </div>
                    </div>

                    {isCollapsed ? null : (
                        <div className="mt-4">{props.children}</div>
                    )}
                </div>
            </div>
        </section>
    );
}

type CopySelectedFilesState =
    | { type: "idle" }
    | { type: "copying"; itemCount: number }
    | { type: "success"; message: string }
    | { type: "error"; message: string };

type DeleteState =
    | { type: "idle" }
    | { type: "deleting" }
    | { type: "error"; message: string };

type BrowserContext = {
    agentId: string | null;
    relativePath: string;
    isDirectoryView: boolean;
};

function joinBrowserPath(directoryPath: string, fileName: string) {
    if (directoryPath.endsWith("/")) {
        return `${directoryPath}${fileName}`;
    }

    return `${directoryPath}/${fileName}`;
}

function getErrorMessage(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    return "Upload failed";
}

function getBrowserContextFromPathname(pathname: string): BrowserContext {
    const browserPathMatch = pathname.match(
        /^\/agents\/([^/]+)\/browser(?:\/(.*))?$/,
    );

    if (!browserPathMatch) {
        return {
            agentId: null,
            relativePath: "",
            isDirectoryView: false,
        };
    }

    const encodedAgentId = browserPathMatch[1];
    const relativePath = browserPathMatch[2] ?? "";

    if (relativePath === "") {
        return {
            agentId: encodedAgentId ? decodeURIComponent(encodedAgentId) : null,
            relativePath,
            isDirectoryView: true,
        };
    }

    const lastPathSegment = relativePath.split("/").pop() ?? "";
    const isDirectoryView = !lastPathSegment.includes(".");

    return {
        agentId: encodedAgentId ? decodeURIComponent(encodedAgentId) : null,
        relativePath,
        isDirectoryView,
    };
}

async function getCurrentDirectoryPath(
    agent: Agent | null,
    browserContext: BrowserContext,
): Promise<string | null> {
    if (!agent || !browserContext.isDirectoryView) {
        return null;
    }

    const details = await agent.getDetails();

    return browserContext.relativePath
        ? `${details.cwd}/${browserContext.relativePath}`
        : details.cwd;
}

/**
 * Shows the globally selected items and lets you copy or delete them from the
 * current browser context.
 */
function SelectedFilesPanel(props: { agents: RootLoaderData["agents"] }) {
    const router = useRouter();
    const selectedFiles = useAtomValue(selectedFilesAtom);
    const unselectFile = useSetAtom(unselectFileAtom);
    const clearSelectedFiles = useSetAtom(clearSelectedFilesAtom);
    const location = useLocation();
    const [copyState, setCopyState] = React.useState<CopySelectedFilesState>({
        type: "idle",
    });
    const [deleteState, setDeleteState] = React.useState<DeleteState>({
        type: "idle",
    });
    const [currentDirectoryPath, setCurrentDirectoryPath] = React.useState<
        string | null
    >(null);

    const browserContext = React.useMemo(
        () => getBrowserContextFromPathname(location.pathname),
        [location.pathname],
    );

    const currentAgent = React.useMemo(() => {
        if (!browserContext.agentId) {
            return null;
        }

        return (
            props.agents.find((agent) => agent.id === browserContext.agentId) ??
            null
        );
    }, [browserContext.agentId, props.agents]);

    React.useEffect(() => {
        let isMounted = true;

        async function loadCurrentDirectoryPath() {
            const directoryPath = await getCurrentDirectoryPath(
                currentAgent,
                browserContext,
            );

            if (isMounted) {
                setCurrentDirectoryPath(directoryPath);
            }
        }

        void loadCurrentDirectoryPath();

        return () => {
            isMounted = false;
        };
    }, [browserContext, currentAgent]);

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

    const statusMessage =
        copyState.type === "copying"
            ? `Copying ${copyState.itemCount} ${copyState.itemCount === 1 ? "item" : "items"}...`
            : copyState.type === "idle"
              ? null
              : copyState.message;
    const isCopying = copyState.type === "copying";

    const handleCopySelectedFiles = async () => {
        if (
            !currentAgent ||
            !currentDirectoryPath ||
            selectedFiles.length === 0
        ) {
            return;
        }

        setCopyState({
            type: "copying",
            itemCount: selectedFiles.length,
        });

        try {
            const agentsById = new Map(
                props.agents.map((agent) => [agent.id, agent]),
            );

            const results = await Promise.allSettled(
                selectedFiles.map((file) => {
                    const sourceAgent = agentsById.get(file.agentId);

                    if (!sourceAgent) {
                        return Promise.reject(
                            new Error(
                                `Source agent unavailable for selected item: ${file.agentId}`,
                            ),
                        );
                    }

                    return sourceAgent.copyTo(
                        {
                            agent: currentAgent.id,
                            path: joinBrowserPath(
                                currentDirectoryPath,
                                file.fileName,
                            ),
                        },
                        file.path,
                    );
                }),
            );

            const successfulCopies = selectedFiles.filter(
                (_file, index) => results[index]?.status === "fulfilled",
            );

            setCopyState({ type: "idle" });

            const failedCopies = results.filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );

            if (successfulCopies.length > 0) {
                successfulCopies.forEach((file) => {
                    unselectFile({
                        agentId: file.agentId,
                        path: file.path,
                    });
                });
            }

            if (failedCopies.length > 0) {
                const firstFailedCopy = failedCopies[0];
                const failureMessage = getErrorMessage(
                    firstFailedCopy ? firstFailedCopy.reason : undefined,
                ).replace(/^Upload failed$/, "Copy failed");

                setCopyState({
                    type: "error",
                    message:
                        successfulCopies.length > 0
                            ? `Copied ${successfulCopies.length} of ${selectedFiles.length} items. ${failureMessage}`
                            : failureMessage,
                });
                return;
            }

            setCopyState({
                type: "success",
                message:
                    selectedFiles.length === 1
                        ? `Copied ${selectedFiles[0]?.fileName ?? "item"}`
                        : `Copied ${selectedFiles.length} items`,
            });
        } catch (error) {
            setCopyState({
                type: "error",
                message: getErrorMessage(error).replace(
                    /^Upload failed$/,
                    "Copy failed",
                ),
            });
        }
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
        <CollapsibleBottomPanel
            title="Selected items"
            description="Files and directories selected for copy operations"
            icon={<Files className="h-4 w-4" />}
            badge={
                <span className="rounded-full border border-blue-500/30 bg-blue-500/15 px-2.5 py-1 text-xs font-medium text-blue-300">
                    {selectedFiles.length}{" "}
                    {selectedFiles.length === 1 ? "item" : "items"}
                </span>
            }
            actions={
                <div className="flex items-center gap-2">
                    {deleteState.type === "deleting" ? (
                        <span
                            className="inline-flex h-10 w-10 items-center justify-center rounded bg-red-600 text-white"
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
                                    onClick={handleDeleteSelectedFiles}
                                    disabled={selectedFiles.length === 0}
                                    aria-label="Delete selected items"
                                    className="inline-flex h-10 w-10 items-center justify-center rounded bg-red-600 text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Trash2 className="h-4 w-4" />
                                </button>
                            </span>
                        </Tooltip>
                    )}
                    {isCopying ? (
                        <span
                            className="inline-flex h-10 w-10 items-center justify-center rounded bg-blue-600 text-white"
                            aria-label="Copying selected items"
                            role="status"
                        >
                            <LoaderCircle className="h-4 w-4 animate-spin" />
                        </span>
                    ) : (
                        <Tooltip content="Copy selected items is only available while browsing a directory.">
                            <span className="inline-flex">
                                <button
                                    type="button"
                                    onClick={handleCopySelectedFiles}
                                    disabled={
                                        !browserContext.isDirectoryView ||
                                        !currentAgent ||
                                        !currentDirectoryPath ||
                                        selectedFiles.length === 0
                                    }
                                    aria-label="Copy selected items"
                                    className="inline-flex h-10 w-10 items-center justify-center rounded bg-blue-600 text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Copy className="h-4 w-4" />
                                </button>
                            </span>
                        </Tooltip>
                    )}
                    <button
                        type="button"
                        onClick={() => clearSelectedFiles()}
                        className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs font-medium text-slate-200 shadow-sm hover:bg-slate-700/60"
                    >
                        Clear all
                    </button>
                </div>
            }
        >
            {statusMessage ? (
                <p
                    role={copyState.type === "error" ? "alert" : "status"}
                    aria-live="polite"
                    className={`mb-3 text-sm ${
                        copyState.type === "error"
                            ? "text-red-400"
                            : "text-blue-300"
                    }`}
                >
                    {statusMessage}
                </p>
            ) : null}
            {deleteState.type === "error" ? (
                <p
                    role="alert"
                    className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                >
                    {deleteState.message}
                </p>
            ) : null}
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
                                        to="/agents/$agentId/browser/$"
                                        params={{
                                            agentId: file.agentId,
                                            _splat:
                                                file.relativePath || undefined,
                                        }}
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
                <span className="rounded-full border border-blue-500/30 bg-blue-500/15 px-2.5 py-1 text-xs font-medium text-blue-300">
                    {activeTransfers.length}{" "}
                    {activeTransfers.length === 1 ? "transfer" : "transfers"}
                </span>
            }
            actions={
                <Link
                    to="/transfers"
                    className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs font-medium text-slate-200 shadow-sm hover:bg-slate-700/60"
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
