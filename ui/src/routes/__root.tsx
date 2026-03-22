import * as React from "react";
import {
    Outlet,
    Link,
    useLocation,
    useRouter,
    createRootRouteWithContext,
} from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import {
    Cpu,
    HardDrive,
    ArrowDownToLine,
    ArrowUpFromLine,
    Copy,
    AlertCircle,
    X,
    Files,
    ChevronDown,
    ChevronUp,
    Trash2,
    LoaderCircle,
} from "lucide-react";
import {
    ApiClient,
    type TransferProgressEntry,
    type UiEvent,
    type Agent,
} from "../api-client";
import type { AnyRouter } from "@tanstack/react-router";

import { formatSize } from "../utils/path";
import {
    selectedFilesAtom,
    unselectFileAtom,
    clearSelectedFilesAtom,
} from "../selected-files";
import { Tooltip } from "../components/tooltip";

interface AppRouterContext {
    api: ApiClient;
}

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
        <div className="flex h-screen">
            <aside className="w-72 border-r bg-gray-50 flex flex-col">
                <div className="p-4 border-b bg-white flex items-center gap-2">
                    <Cpu className="h-6 w-6 text-blue-600" />
                    <h1 className="font-bold text-lg text-gray-800">Redoor</h1>
                </div>
                <div className="flex-1 overflow-auto">
                    {agents.length === 0 ? (
                        <div className="p-4 text-sm text-gray-500 text-center">
                            No agents connected
                        </div>
                    ) : (
                        <ul className="divide-y">
                            {sortedAgents.map((agent) => {
                                const isActive = location.pathname.startsWith(
                                    `/agents/${encodeURIComponent(agent.id)}/browser`,
                                );
                                return (
                                    <li key={agent.id}>
                                        <Link
                                            to="/agents/$agentId/browser/$"
                                            params={{
                                                agentId: agent.id,
                                                _splat: undefined,
                                            }}
                                            className={`px-4 py-3 hover:bg-gray-100 cursor-pointer flex items-center gap-3 ${
                                                isActive
                                                    ? "bg-blue-50 border-l-4 border-blue-500"
                                                    : ""
                                            }`}
                                        >
                                            <HardDrive className="h-4 w-4 text-gray-500" />
                                            <span className="text-sm font-medium text-gray-700">
                                                {agent.name}
                                            </span>
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </aside>
            <div className="flex-1 min-h-0 flex flex-col">
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
        <section className="sticky bottom-0 z-10 border-t border-blue-200/80 bg-white/95 shadow-[0_-10px_30px_-12px_rgba(59,130,246,0.35)] backdrop-blur supports-[backdrop-filter]:bg-white/80">
            <div>
                <div className="max-w-full bg-white/90 p-4">
                    <div className="flex items-center justify-between gap-3 pb-3">
                        <div className="flex items-start gap-3">
                            {props.icon ? (
                                <div className="bg-blue-50/70 p-2 text-blue-700">
                                    {props.icon}
                                </div>
                            ) : null}
                            <div>
                                <h2 className="text-sm font-semibold text-gray-900">
                                    {props.title}
                                </h2>
                                <p className="text-xs text-slate-600">
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
                                className="inline-flex items-center gap-2 rounded-md border border-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-blue-50"
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

    const selectedFilesForCurrentAgent = browserContext.agentId
        ? selectedFiles.filter(
              (file) => file.agentId === browserContext.agentId,
          )
        : [];
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
            const results = await Promise.allSettled(
                selectedFiles.map((file) =>
                    currentAgent.copyTo(
                        {
                            agent: currentAgent.id,
                            path: joinBrowserPath(
                                currentDirectoryPath,
                                file.fileName,
                            ),
                        },
                        file.path,
                    ),
                ),
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
                successfulDeletes.forEach((file) => {
                    unselectFile({
                        agentId: file.agentId,
                        path: file.path,
                    });
                });

                await router.invalidate();
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
                <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-800">
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
                                    className="inline-flex h-10 w-10 items-center justify-center rounded bg-red-600 text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
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
                                    className="inline-flex h-10 w-10 items-center justify-center rounded bg-blue-600 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <Copy className="h-4 w-4" />
                                </button>
                            </span>
                        </Tooltip>
                    )}
                    <button
                        type="button"
                        onClick={() => clearSelectedFiles()}
                        className="rounded-md border border-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-blue-50"
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
                            ? "text-red-600"
                            : "text-blue-800"
                    }`}
                >
                    {statusMessage}
                </p>
            ) : null}
            {deleteState.type === "error" ? (
                <p
                    role="alert"
                    className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                >
                    {deleteState.message}
                </p>
            ) : null}
            <div className="max-h-64 overflow-auto bg-white">
                <table className="w-full">
                    <thead className="sticky top-0 bg-gray-50">
                        <tr className="border-b">
                            <th className="p-3 text-left text-sm font-medium text-gray-600">
                                Agent
                            </th>
                            <th className="p-3 text-left text-sm font-medium text-gray-600">
                                Item
                            </th>
                            <th className="p-3 text-left text-sm font-medium text-gray-600">
                                Path
                            </th>
                            <th className="p-3 text-left text-sm font-medium text-gray-600">
                                Action
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {selectedFiles.map((file) => (
                            <tr
                                key={`${file.agentId}:${file.path}`}
                                className="border-b last:border-b-0 hover:bg-gray-50 align-top"
                            >
                                <td className="p-3">
                                    <div className="flex flex-col">
                                        <span className="text-sm font-medium text-gray-900">
                                            {file.agentName}
                                        </span>
                                        <span className="text-xs text-gray-500">
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
                                        className="text-sm font-medium text-blue-600 hover:underline"
                                    >
                                        {file.fileName}
                                    </Link>
                                </td>
                                <td className="p-3">
                                    <div className="break-all font-mono text-xs text-gray-700">
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
                                        className="inline-flex items-center gap-2 rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
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
    if (props.transfers.length === 0) {
        return null;
    }

    return (
        <CollapsibleBottomPanel
            title="Transfer progress"
            description="Active, completed, and failed transfers"
            badge={
                <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-800">
                    {props.transfers.length}{" "}
                    {props.transfers.length === 1 ? "transfer" : "transfers"}
                </span>
            }
        >
            <div className="max-h-64 overflow-auto bg-white">
                <table className="w-full bg-white">
                    <thead className="sticky top-0 bg-gray-50">
                        <tr className="border-b">
                            <th className="text-left p-3 text-sm font-medium text-gray-600">
                                Agent
                            </th>
                            <th className="text-left p-3 text-sm font-medium text-gray-600">
                                Direction
                            </th>
                            <th className="text-left p-3 text-sm font-medium text-gray-600">
                                Path
                            </th>
                            <th className="text-left p-3 text-sm font-medium text-gray-600">
                                Progress
                            </th>
                            <th className="text-left p-3 text-sm font-medium text-gray-600">
                                Status
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {props.transfers.map((transfer) => {
                            const agent = props.agents.find(
                                (entry) => entry.id === transfer.agent_id,
                            );
                            const sourceAgent = transfer.source
                                ? props.agents.find(
                                      (entry) =>
                                          entry.id === transfer.source?.agent,
                                  )
                                : undefined;
                            const destAgent = transfer.dest
                                ? props.agents.find(
                                      (entry) =>
                                          entry.id === transfer.dest?.agent,
                                  )
                                : undefined;

                            return (
                                <tr
                                    key={transfer.request_id.toString()}
                                    className="border-b last:border-b-0 hover:bg-gray-50 align-top"
                                >
                                    <td className="p-3">
                                        <div className="flex flex-col">
                                            <span className="text-sm font-medium text-gray-900">
                                                {transfer.direction === "copy"
                                                    ? `${sourceAgent?.name ?? transfer.source?.agent} -> ${destAgent?.name ?? transfer.dest?.agent}`
                                                    : (agent?.name ??
                                                      transfer.agent_id)}
                                            </span>
                                            <span className="text-xs text-gray-500">
                                                {transfer.direction === "copy"
                                                    ? `${transfer.source?.agent} -> ${transfer.dest?.agent}`
                                                    : transfer.agent_id}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="p-3">
                                        <span
                                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                                                transfer.direction === "upload"
                                                    ? "bg-blue-50 text-blue-700"
                                                    : "bg-emerald-50 text-emerald-700"
                                            }`}
                                        >
                                            {transfer.direction === "upload" ? (
                                                <ArrowUpFromLine className="h-3.5 w-3.5" />
                                            ) : transfer.direction ===
                                              "download" ? (
                                                <ArrowDownToLine className="h-3.5 w-3.5" />
                                            ) : (
                                                <Copy className="h-3.5 w-3.5" />
                                            )}
                                            {transfer.direction === "upload"
                                                ? "Upload"
                                                : transfer.direction ===
                                                    "download"
                                                  ? "Download"
                                                  : "Copy"}
                                        </span>
                                    </td>
                                    <td className="p-3">
                                        {transfer.direction === "copy" ? (
                                            <div className="space-y-1 font-mono text-xs text-gray-700 break-all">
                                                <div>
                                                    {transfer.source?.path}
                                                </div>
                                                <div className="text-gray-400">
                                                    -&gt;
                                                </div>
                                                <div>{transfer.dest?.path}</div>
                                            </div>
                                        ) : (
                                            <div className="font-mono text-xs text-gray-700 break-all">
                                                {transfer.path}
                                            </div>
                                        )}
                                    </td>
                                    <td className="p-3">
                                        <div className="flex flex-col gap-1 text-sm text-gray-700">
                                            <span>
                                                {formatSize(
                                                    transfer.transferred_bytes,
                                                )}{" "}
                                                /{" "}
                                                {formatSize(
                                                    transfer.total_bytes,
                                                )}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="p-3">
                                        <div className="flex flex-col gap-1">
                                            <span
                                                className={`text-sm font-medium ${
                                                    transfer.state === "errored"
                                                        ? "text-red-600"
                                                        : transfer.state ===
                                                            "completed"
                                                          ? "text-emerald-700"
                                                          : "text-gray-900"
                                                }`}
                                            >
                                                {transfer.state}
                                            </span>
                                            {transfer.error ? (
                                                <span className="inline-flex items-start gap-1 text-xs text-red-600">
                                                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                                    <span className="break-words">
                                                        {transfer.error}
                                                    </span>
                                                </span>
                                            ) : null}
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </CollapsibleBottomPanel>
    );
}
