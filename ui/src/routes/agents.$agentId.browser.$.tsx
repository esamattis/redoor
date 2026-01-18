import { createFileRoute, Link } from "@tanstack/react-router";
import { Folder, File, ArrowUp, AlertCircle } from "lucide-react";
import { getParentPath, formatSize } from "../utils/path";

export const Route = createFileRoute("/agents/$agentId/browser/$")({
    loader: async ({ params, context }) => {
        const agents = await context.api.listAgents();
        const agent = agents.find((a) => a.id === params.agentId);
        if (!agent) throw new Error(`Agent not found: ${params.agentId}`);

        const details = await agent.getDetails();
        const relativePath = params._splat || "";
        const fullPath = relativePath ? `${details.cwd}/${relativePath}` : details.cwd;
        const lsResult = await agent.ls(fullPath);

        return {
            agentId: agent.id,
            agentName: agent.name,
            cwd: details.cwd,
            relativePath,
            fullPath,
            files: lsResult.files,
        };
    },
    component: FileBrowser,
    errorComponent: FileBrowserError,
});

function FileBrowser() {
    const data = Route.useLoaderData();
    const { agentId, agentName, relativePath, files } = data;

    const isAtCwd = relativePath === "";
    const parentPath = getParentPath(relativePath);

    const directories = files.filter((f) => f.type === "directory");
    const regularFiles = files.filter((f) => f.type === "file");

    directories.sort((a, b) => a.name.localeCompare(b.name));
    regularFiles.sort((a, b) => a.name.localeCompare(b.name));

    const sortedFiles = [...directories, ...regularFiles];

    return (
        <div className="p-6">
            <div className="max-w-4xl mx-auto">
                <BrowserHeader
                    agentId={agentId}
                    agentName={agentName}
                    relativePath={relativePath}
                    isAtCwd={isAtCwd}
                    parentPath={parentPath}
                />
                <FileList
                    agentId={agentId}
                    relativePath={relativePath}
                    files={sortedFiles}
                    isAtCwd={isAtCwd}
                />
            </div>
        </div>
    );
}

function BrowserHeader(props: {
    agentId: string;
    agentName: string;
    relativePath: string;
    isAtCwd: boolean;
    parentPath: string | null;
}) {
    const { agentId, agentName, relativePath, isAtCwd, parentPath } = props;

    return (
        <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
                <Breadcrumbs
                    agentId={agentId}
                    agentName={agentName}
                    relativePath={relativePath}
                />
                <div className="flex gap-2">
                    <Link
                        to="/agents/$agentId/browser/$"
                        params={{ agentId, _splat: parentPath ?? undefined }}
                        className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={isAtCwd}
                    >
                        <ArrowUp className="h-4 w-4" />
                        Up
                    </Link>
                    <Link
                        to="/agents/$agentId"
                        params={{ agentId }}
                        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                    >
                        Back to Agent
                    </Link>
                </div>
            </div>
        </div>
    );
}

function Breadcrumbs(props: {
    agentId: string;
    agentName: string;
    relativePath: string;
}) {
    const { agentId, agentName, relativePath } = props;

    const parts = relativePath.split("/").filter((part) => part !== "");
    const paths: string[] = [];
    let accumulatedPath = "";

    return (
        <div className="flex items-center gap-2 text-sm">
            <Link
                to="/agents/$agentId"
                params={{ agentId }}
                className="text-blue-600 hover:underline"
            >
                {agentName}
            </Link>
            {parts.map((part, index) => {
                accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
                paths.push(accumulatedPath);
                const isLast = index === parts.length - 1;

                return (
                    <div key={index} className="flex items-center gap-2">
                        <span className="text-gray-400">/</span>
                        {isLast ? (
                            <span className="text-gray-900 font-medium">{part}</span>
                        ) : (
                            <Link
                                to="/agents/$agentId/browser/$"
                                params={{ agentId, _splat: accumulatedPath }}
                                className="text-blue-600 hover:underline font-medium"
                            >
                                {part}
                            </Link>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function FileList(props: {
    agentId: string;
    relativePath: string;
    files: Array<{
        name: string;
        type: string;
        size: bigint;
        owner: string | null;
        group: string | null;
        uid: number;
        gid: number;
    }>;
    isAtCwd: boolean;
}) {
    const { agentId, relativePath, files } = props;

    return (
        <table className="w-full bg-white border rounded-lg">
            <thead>
                <tr className="border-b bg-gray-50">
                    <th className="text-left p-3 text-sm font-medium text-gray-600">Type</th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">Name</th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">Size</th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">Owner</th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">Group</th>
                </tr>
            </thead>
            <tbody>
                {files.map((entry, index) => (
                    <FileEntry
                        key={index}
                        agentId={agentId}
                        relativePath={relativePath}
                        entry={entry}
                        isParent={false}
                    />
                ))}
            </tbody>
        </table>
    );
}

function FileEntry(props: {
    agentId: string;
    relativePath: string;
    entry: {
        name: string;
        type: string;
        size: bigint;
        owner: string | null;
        group: string | null;
        uid: number;
        gid: number;
    };
    isParent: boolean;
}) {
    const { agentId, relativePath, entry, isParent } = props;
    const isDirectory = entry.type === "directory" || isParent;
    const splatValue = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (isDirectory && !isParent) {
        return (
            <tr className="border-b hover:bg-gray-50">
                <td className="p-3">
                    <Folder className="h-5 w-5 text-blue-500" />
                </td>
                <td className="p-3">
                    <Link
                        to="/agents/$agentId/browser/$"
                        params={{ agentId, _splat: splatValue }}
                        className="flex items-center gap-3 text-blue-600 font-medium hover:underline"
                    >
                        {entry.name}
                    </Link>
                </td>
                <td className="p-3 text-gray-400">-</td>
                <td className="p-3 text-gray-500">{entry.owner || "-"}</td>
                <td className="p-3 text-gray-500">{entry.group || "-"}</td>
            </tr>
        );
    }

    return (
        <tr className="border-b hover:bg-gray-50">
            <td className="p-3">
                <File className="h-5 w-5 text-gray-400" />
            </td>
            <td className="p-3 text-gray-900">{entry.name}</td>
            <td className="p-3 text-gray-500">{formatSize(entry.size)}</td>
            <td className="p-3 text-gray-500">{entry.owner || "-"}</td>
            <td className="p-3 text-gray-500">{entry.group || "-"}</td>
        </tr>
    );
}

function FileBrowserError({ error }: { error: Error }) {
    const errorMessage = error.message.toLowerCase();

    if (errorMessage.includes("not found") || errorMessage.includes("agent not found")) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center flex flex-col items-center gap-2">
                    <AlertCircle className="h-12 w-12 text-red-500" />
                    <p className="text-gray-500">Agent not found</p>
                    <Link to="/" className="text-blue-600 hover:underline">Back to agents</Link>
                </div>
            </div>
        );
    }

    if (errorMessage.includes("no such file or directory") || errorMessage.includes("directory not found")) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center flex flex-col items-center gap-2">
                    <AlertCircle className="h-12 w-12 text-red-500" />
                    <p className="text-gray-500">Directory not found</p>
                </div>
            </div>
        );
    }

    if (errorMessage.includes("not a directory")) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center flex flex-col items-center gap-2">
                    <AlertCircle className="h-12 w-12 text-red-500" />
                    <p className="text-gray-500">Not a directory</p>
                </div>
            </div>
        );
    }

    if (errorMessage.includes("permission denied")) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center flex flex-col items-center gap-2">
                    <AlertCircle className="h-12 w-12 text-red-500" />
                    <p className="text-gray-500">Permission denied</p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center h-full">
            <div className="text-center flex flex-col items-center gap-2">
                <AlertCircle className="h-12 w-12 text-red-500" />
                <p className="text-gray-500">Error loading files</p>
                <p className="text-sm text-gray-400">{error.message}</p>
            </div>
        </div>
    );
}
