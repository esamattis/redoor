import React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
    Folder,
    File,
    ArrowUp,
    AlertCircle,
    Download,
    ArrowLeft,
    Copy,
    Check,
} from "lucide-react";
import { getParentPath, formatSize, getRawDownloadUrl } from "../utils/path";
import {
    type LsResponse,
    isLsDirectoryResponse,
    isLsFileResponse,
    type LsFileResponse,
} from "../api-client";

export const Route = createFileRoute("/agents/$agentId/browser/$")({
    loader: async ({ params, context }) => {
        const agents = await context.api.listAgents();
        const agent = agents.find((a) => a.id === params.agentId);
        if (!agent) throw new Error(`Agent not found: ${params.agentId}`);

        const details = await agent.getDetails();
        const relativePath = params._splat || "";
        const fullPath = relativePath
            ? `${details.cwd}/${relativePath}`
            : details.cwd;
        const lsResult: LsResponse = await agent.ls(fullPath);

        return {
            agentId: agent.id,
            agentName: agent.name,
            cwd: details.cwd,
            relativePath,
            fullPath,
            lsResult,
        };
    },
    component: FileBrowser,
    errorComponent: FileBrowserError,
});

function FileBrowser() {
    const data = Route.useLoaderData();
    const { agentId, agentName, relativePath, lsResult, cwd } = data;

    const isAtCwd = relativePath === "";
    const parentPath = getParentPath(relativePath);

    if (isLsDirectoryResponse(lsResult)) {
        const directories = lsResult.files.filter(
            (f) => f.type === "directory",
        );
        const regularFiles = lsResult.files.filter((f) => f.type === "file");

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

    if (isLsFileResponse(lsResult)) {
        const fileName = relativePath.split("/").pop() || lsResult.path;
        return (
            <div className="p-6">
                <div className="max-w-4xl mx-auto">
                    <FileDetailView
                        agentId={agentId}
                        agentName={agentName}
                        relativePath={relativePath}
                        fileName={fileName}
                        lsResult={lsResult}
                        cwd={cwd}
                    />
                </div>
            </div>
        );
    }

    return null;
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
                accumulatedPath = accumulatedPath
                    ? `${accumulatedPath}/${part}`
                    : part;
                paths.push(accumulatedPath);
                const isLast = index === parts.length - 1;

                return (
                    <div key={index} className="flex items-center gap-2">
                        <span className="text-gray-400">/</span>
                        {isLast ? (
                            <span className="text-gray-900 font-medium">
                                {part}
                            </span>
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
                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                        Type
                    </th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                        Name
                    </th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                        Size
                    </th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                        Owner
                    </th>
                    <th className="text-left p-3 text-sm font-medium text-gray-600">
                        Group
                    </th>
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
    const splatValue = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;

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
            <td className="p-3">
                <Link
                    to="/agents/$agentId/browser/$"
                    params={{ agentId, _splat: splatValue }}
                    className="text-blue-600 font-medium hover:underline"
                >
                    {entry.name}
                </Link>
            </td>
            <td className="p-3 text-gray-500">{formatSize(entry.size)}</td>
            <td className="p-3 text-gray-500">{entry.owner || "-"}</td>
            <td className="p-3 text-gray-500">{entry.group || "-"}</td>
        </tr>
    );
}

function FileDetailView(props: {
    agentId: string;
    agentName: string;
    relativePath: string;
    fileName: string;
    lsResult: LsFileResponse;
    cwd: string;
}) {
    const { agentId, agentName, relativePath, fileName, lsResult, cwd } = props;
    const parentPath = getParentPath(relativePath);
    const rawDownloadUrl = getRawDownloadUrl(
        window.location.origin,
        agentId,
        lsResult.path,
        cwd,
    );

    const [copiedCommand, setCopiedCommand] = React.useState<string | null>(
        null,
    );

    const copyToClipboard = async (text: string, commandType: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopiedCommand(commandType);
            setTimeout(() => setCopiedCommand(null), 2000);
        } catch (err) {
            console.error("Failed to copy:", err);
        }
    };

    return (
        <div>
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
                            params={{
                                agentId,
                                _splat: parentPath ?? undefined,
                            }}
                            className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded hover:bg-gray-200"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Back
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

            <div className="bg-white border rounded-lg p-6">
                <div className="flex items-center gap-4 mb-6">
                    <div className="p-3 bg-blue-100 rounded-lg">
                        <File className="h-8 w-8 text-blue-600" />
                    </div>
                    <h1 className="text-2xl font-bold text-gray-900">
                        {fileName}
                    </h1>
                </div>

                <div className="space-y-4">
                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <p className="text-sm text-gray-500 mb-1">Size</p>
                            <p className="text-gray-900 font-medium">
                                {formatSize(
                                    BigInt(lsResult.size as unknown as number),
                                )}
                            </p>
                        </div>
                        <div>
                            <p className="text-sm text-gray-500 mb-1">Owner</p>
                            <p className="text-gray-900 font-medium">
                                {lsResult.owner || "-"}
                            </p>
                        </div>
                        <div>
                            <p className="text-sm text-gray-500 mb-1">Group</p>
                            <p className="text-gray-900 font-medium">
                                {lsResult.group || "-"}
                            </p>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <p className="text-sm text-gray-500 mb-1">UID</p>
                            <p className="text-gray-900 font-medium">
                                {lsResult.uid}
                            </p>
                        </div>
                        <div>
                            <p className="text-sm text-gray-500 mb-1">GID</p>
                            <p className="text-gray-900 font-medium">
                                {lsResult.gid}
                            </p>
                        </div>
                    </div>

                    <div>
                        <p className="text-sm text-gray-500 mb-1">Full Path</p>
                        <p className="text-gray-900 font-mono text-sm bg-gray-50 p-2 rounded">
                            {lsResult.path}
                        </p>
                    </div>

                    <div>
                        <p className="text-sm text-gray-500 mb-1">Download</p>
                        <a
                            href={rawDownloadUrl}
                            download={fileName}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
                        >
                            <Download className="h-4 w-4" />
                            Download File
                        </a>
                    </div>

                    <div>
                        <p className="text-sm text-gray-500 mb-2">
                            Command Line Downloads
                        </p>

                        {/* wget row */}
                        <div className="flex items-center gap-2 mb-2">
                            <code className="flex-1 text-sm font-mono bg-gray-50 p-2 rounded">
                                wget "{rawDownloadUrl}"
                            </code>
                            <button
                                onClick={() =>
                                    copyToClipboard(
                                        `wget "${rawDownloadUrl}"`,
                                        "wget",
                                    )
                                }
                                className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded"
                                aria-label="Copy wget command"
                            >
                                {copiedCommand === "wget" ? (
                                    <Check className="h-4 w-4 text-green-600" />
                                ) : (
                                    <Copy className="h-4 w-4" />
                                )}
                            </button>
                        </div>

                        {/* curl row */}
                        <div className="flex items-center gap-2">
                            <code className="flex-1 text-sm font-mono bg-gray-50 p-2 rounded">
                                curl -O "{rawDownloadUrl}"
                            </code>
                            <button
                                onClick={() =>
                                    copyToClipboard(
                                        `curl -O "${rawDownloadUrl}"`,
                                        "curl",
                                    )
                                }
                                className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded"
                                aria-label="Copy curl command"
                            >
                                {copiedCommand === "curl" ? (
                                    <Check className="h-4 w-4 text-green-600" />
                                ) : (
                                    <Copy className="h-4 w-4" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function FileBrowserError({ error }: { error: Error }) {
    const errorMessage = error.message.toLowerCase();

    if (
        errorMessage.includes("not found") ||
        errorMessage.includes("agent not found")
    ) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center flex flex-col items-center gap-2">
                    <AlertCircle className="h-12 w-12 text-red-500" />
                    <p className="text-gray-500">Agent not found</p>
                    <Link to="/" className="text-blue-600 hover:underline">
                        Back to agents
                    </Link>
                </div>
            </div>
        );
    }

    if (
        errorMessage.includes("no such file or directory") ||
        errorMessage.includes("directory not found")
    ) {
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
