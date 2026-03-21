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
    Terminal,
    ChevronRight,
    HardDrive,
    FileText,
} from "lucide-react";
import { getParentPath, formatSize } from "../utils/path";
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
        const downloadUrl = isLsFileResponse(lsResult)
            ? agent.getDownloadUrl(lsResult.path, { cwd: details.cwd })
            : undefined;

        return {
            agentId: agent.id,
            agentName: agent.name,
            cwd: details.cwd,
            relativePath,
            fullPath,
            lsResult,
            downloadUrl,
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
            <div className="min-h-screen p-8">
                <div className="max-w-6xl mx-auto">
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
            <div className="min-h-screen p-8">
                <div className="max-w-6xl mx-auto">
                    <FileDetailView
                        agentId={agentId}
                        agentName={agentName}
                        relativePath={relativePath}
                        fileName={fileName}
                        lsResult={lsResult}
                        downloadUrl={data.downloadUrl!}
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
        <div className="mb-8">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <Breadcrumbs
                    agentId={agentId}
                    agentName={agentName}
                    relativePath={relativePath}
                />
                <div className="flex gap-3">
                    <Link
                        to="/agents/$agentId/browser/$"
                        params={{ agentId, _splat: parentPath ?? undefined }}
                        className="btn-secondary"
                        aria-disabled={isAtCwd}
                        style={{ opacity: isAtCwd ? 0.5 : 1 }}
                    >
                        <ArrowUp className="h-4 w-4" />
                        Parent Directory
                    </Link>
                    <Link
                        to="/agents/$agentId"
                        params={{ agentId }}
                        className="btn-primary"
                    >
                        <HardDrive className="h-4 w-4" />
                        Back to Agent
                    </Link>
                </div>
            </div>
            <div className="h-px bg-gradient-to-r from-[rgba(245,158,11,0.3)] via-[rgba(6,182,212,0.2)] to-transparent mt-6"></div>
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
        <div className="flex items-center gap-2 text-sm flex-wrap">
            <Link
                to="/agents/$agentId"
                params={{ agentId }}
                className="font-mono text-[#06b6d4] hover:text-[#f59e0b] transition-colors flex items-center gap-2"
            >
                <Terminal className="h-4 w-4" />
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
                        <ChevronRight className="h-4 w-4 text-[#475569]" />
                        {isLast ? (
                            <span className="font-mono text-[#f8fafc] font-medium">
                                {part}
                            </span>
                        ) : (
                            <Link
                                to="/agents/$agentId/browser/$"
                                params={{ agentId, _splat: accumulatedPath }}
                                className="font-mono text-[#06b6d4] hover:text-[#f59e0b] transition-colors"
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
        <div className="glass-card rounded-xl overflow-hidden">
            <table className="w-full">
                <thead>
                    <tr className="border-b border-[rgba(245,158,11,0.1)] bg-[rgba(245,158,11,0.02)]">
                        <th className="text-left p-4 font-heading text-xs font-semibold text-[#64748b] uppercase tracking-wider">
                            Type
                        </th>
                        <th className="text-left p-4 font-heading text-xs font-semibold text-[#64748b] uppercase tracking-wider">
                            Name
                        </th>
                        <th className="text-left p-4 font-heading text-xs font-semibold text-[#64748b] uppercase tracking-wider">
                            Size
                        </th>
                        <th className="text-left p-4 font-heading text-xs font-semibold text-[#64748b] uppercase tracking-wider">
                            Owner
                        </th>
                        <th className="text-left p-4 font-heading text-xs font-semibold text-[#64748b] uppercase tracking-wider">
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
            {files.length === 0 && (
                <div className="empty-state py-16">
                    <div className="relative inline-block mb-4">
                        <div className="absolute inset-0 bg-[#64748b] blur-xl opacity-20"></div>
                        <Folder className="h-12 w-12 text-[#64748b] relative" />
                    </div>
                    <h3 className="font-heading text-lg font-semibold text-[#f8fafc] mb-2">
                        Empty Directory
                    </h3>
                    <p className="font-mono text-sm text-[#64748b]">
                        This directory contains no files
                    </p>
                </div>
            )}
        </div>
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
            <tr className="border-b border-[rgba(245,158,11,0.05)] hover:bg-[rgba(245,158,11,0.03)] transition-colors cursor-pointer group">
                <td className="p-4">
                    <div className="w-10 h-10 rounded-lg bg-[rgba(245,158,11,0.1)] flex items-center justify-center">
                        <Folder className="h-5 w-5 text-[#f59e0b]" />
                    </div>
                </td>
                <td className="p-4">
                    <Link
                        to="/agents/$agentId/browser/$"
                        params={{ agentId, _splat: splatValue }}
                        className="font-mono text-[#06b6d4] hover:text-[#f59e0b] transition-colors font-medium flex items-center gap-2"
                    >
                        {entry.name}
                    </Link>
                </td>
                <td className="p-4 font-mono text-sm text-[#475569]">-</td>
                <td className="p-4 font-mono text-sm text-[#64748b]">
                    {entry.owner || entry.uid}
                </td>
                <td className="p-4 font-mono text-sm text-[#64748b]">
                    {entry.group || entry.gid}
                </td>
            </tr>
        );
    }

    return (
        <tr className="border-b border-[rgba(245,158,11,0.05)] hover:bg-[rgba(245,158,11,0.03)] transition-colors cursor-pointer group">
            <td className="p-4">
                <div className="w-10 h-10 rounded-lg bg-[rgba(6,182,212,0.1)] flex items-center justify-center">
                    <FileText className="h-5 w-5 text-[#06b6d4]" />
                </div>
            </td>
            <td className="p-4">
                <Link
                    to="/agents/$agentId/browser/$"
                    params={{ agentId, _splat: splatValue }}
                    className="font-mono text-[#f8fafc] hover:text-[#f59e0b] transition-colors"
                >
                    {entry.name}
                </Link>
            </td>
            <td className="p-4 font-mono text-sm text-[#64748b]">
                {formatSize(entry.size)}
            </td>
            <td className="p-4 font-mono text-sm text-[#64748b]">
                {entry.owner || entry.uid}
            </td>
            <td className="p-4 font-mono text-sm text-[#64748b]">
                {entry.group || entry.gid}
            </td>
        </tr>
    );
}

function FileDetailView(props: {
    agentId: string;
    agentName: string;
    relativePath: string;
    fileName: string;
    lsResult: LsFileResponse;
    downloadUrl: string;
}) {
    const {
        agentId,
        agentName,
        relativePath,
        fileName,
        lsResult,
        downloadUrl,
    } = props;
    const parentPath = getParentPath(relativePath);

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
            <div className="mb-8">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <Breadcrumbs
                        agentId={agentId}
                        agentName={agentName}
                        relativePath={relativePath}
                    />
                    <div className="flex gap-3">
                        <Link
                            to="/agents/$agentId/browser/$"
                            params={{
                                agentId,
                                _splat: parentPath ?? undefined,
                            }}
                            className="btn-secondary"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Back
                        </Link>
                        <Link
                            to="/agents/$agentId"
                            params={{ agentId }}
                            className="btn-primary"
                        >
                            <HardDrive className="h-4 w-4" />
                            Agent View
                        </Link>
                    </div>
                </div>
                <div className="h-px bg-gradient-to-r from-[rgba(245,158,11,0.3)] via-[rgba(6,182,212,0.2)] to-transparent mt-6"></div>
            </div>

            <div className="glass-card rounded-xl p-8">
                <div className="flex items-center gap-5 mb-8">
                    <div className="relative">
                        <div className="absolute inset-0 bg-[#06b6d4] blur-xl opacity-20"></div>
                        <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-[rgba(6,182,212,0.2)] to-[rgba(6,182,212,0.05)] border border-[rgba(6,182,212,0.3)] flex items-center justify-center">
                            <File className="h-8 w-8 text-[#06b6d4]" />
                        </div>
                    </div>
                    <div>
                        <h1 className="font-display text-2xl font-bold text-[#f8fafc] tracking-wide">
                            {fileName}
                        </h1>
                        <span className="badge badge-cyan mt-2">File</span>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                    <div className="glass-card rounded-xl p-5 border-[rgba(6,182,212,0.2)]">
                        <p className="font-mono text-xs text-[#64748b] uppercase tracking-wider mb-2">
                            File Size
                        </p>
                        <p className="font-display text-2xl font-bold text-[#f59e0b]">
                            {formatSize(
                                BigInt(lsResult.size as unknown as number),
                            )}
                        </p>
                    </div>
                    <div className="glass-card rounded-xl p-5 border-[rgba(168,85,247,0.2)]">
                        <p className="font-mono text-xs text-[#64748b] uppercase tracking-wider mb-2">
                            Owner / Group
                        </p>
                        <p className="font-mono text-lg text-[#f8fafc]">
                            {lsResult.owner || lsResult.uid} /{" "}
                            {lsResult.group || lsResult.gid}
                        </p>
                    </div>
                </div>

                <div className="space-y-6">
                    <div>
                        <p className="font-heading text-sm font-semibold text-[#64748b] uppercase tracking-wider mb-3">
                            Full Path
                        </p>
                        <div className="terminal-block font-mono text-sm text-[#06b6d4]">
                            {lsResult.path}
                        </div>
                    </div>

                    <div className="divider"></div>

                    <div>
                        <p className="font-heading text-sm font-semibold text-[#64748b] uppercase tracking-wider mb-4">
                            Download Options
                        </p>
                        <a
                            href={downloadUrl}
                            download={fileName}
                            className="btn-primary inline-flex"
                        >
                            <Download className="h-4 w-4" />
                            Download File
                        </a>
                    </div>

                    <div className="divider"></div>

                    <div>
                        <p className="font-heading text-sm font-semibold text-[#64748b] uppercase tracking-wider mb-4">
                            Command Line Downloads
                        </p>

                        <div className="space-y-4">
                            {/* wget row */}
                            <div className="flex items-center gap-3">
                                <div className="flex-1 terminal-block flex items-center justify-between">
                                    <code className="text-[#f8fafc]">
                                        wget "{downloadUrl}"
                                    </code>
                                </div>
                                <button
                                    onClick={() =>
                                        copyToClipboard(
                                            `wget "${downloadUrl}"`,
                                            "wget",
                                        )
                                    }
                                    className="p-3 rounded-lg bg-[#1a1a24] border border-[rgba(245,158,11,0.2)] text-[#64748b] hover:text-[#f59e0b] hover:border-[rgba(245,158,11,0.4)] transition-all"
                                    aria-label="Copy wget command"
                                >
                                    {copiedCommand === "wget" ? (
                                        <Check className="h-5 w-5 text-[#10b981]" />
                                    ) : (
                                        <Copy className="h-5 w-5" />
                                    )}
                                </button>
                            </div>

                            {/* curl row */}
                            <div className="flex items-center gap-3">
                                <div className="flex-1 terminal-block flex items-center justify-between">
                                    <code className="text-[#f8fafc]">
                                        curl -O "{downloadUrl}"
                                    </code>
                                </div>
                                <button
                                    onClick={() =>
                                        copyToClipboard(
                                            `curl -O "${downloadUrl}"`,
                                            "curl",
                                        )
                                    }
                                    className="p-3 rounded-lg bg-[#1a1a24] border border-[rgba(245,158,11,0.2)] text-[#64748b] hover:text-[#f59e0b] hover:border-[rgba(245,158,11,0.4)] transition-all"
                                    aria-label="Copy curl command"
                                >
                                    {copiedCommand === "curl" ? (
                                        <Check className="h-5 w-5 text-[#10b981]" />
                                    ) : (
                                        <Copy className="h-5 w-5" />
                                    )}
                                </button>
                            </div>
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
            <div className="min-h-screen flex items-center justify-center p-8">
                <div className="glass-card rounded-2xl p-12 text-center max-w-md">
                    <div className="relative inline-block mb-6">
                        <div className="absolute inset-0 bg-[#ef4444] blur-2xl opacity-20"></div>
                        <AlertCircle className="h-16 w-16 text-[#ef4444] relative" />
                    </div>
                    <h2 className="font-heading text-xl font-semibold text-[#f8fafc] mb-2">
                        Agent Not Found
                    </h2>
                    <p className="font-mono text-sm text-[#64748b] mb-6">
                        The requested agent could not be located
                    </p>
                    <Link to="/" className="btn-primary inline-flex">
                        Return to Dashboard
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
            <div className="min-h-screen flex items-center justify-center p-8">
                <div className="glass-card rounded-2xl p-12 text-center max-w-md">
                    <div className="relative inline-block mb-6">
                        <div className="absolute inset-0 bg-[#f59e0b] blur-2xl opacity-20"></div>
                        <Folder className="h-16 w-16 text-[#f59e0b] relative" />
                    </div>
                    <h2 className="font-heading text-xl font-semibold text-[#f8fafc] mb-2">
                        Directory Not Found
                    </h2>
                    <p className="font-mono text-sm text-[#64748b] mb-6">
                        The requested path does not exist
                    </p>
                </div>
            </div>
        );
    }

    if (errorMessage.includes("not a directory")) {
        return (
            <div className="min-h-screen flex items-center justify-center p-8">
                <div className="glass-card rounded-2xl p-12 text-center max-w-md">
                    <div className="relative inline-block mb-6">
                        <div className="absolute inset-0 bg-[#f59e0b] blur-2xl opacity-20"></div>
                        <File className="h-16 w-16 text-[#f59e0b] relative" />
                    </div>
                    <h2 className="font-heading text-xl font-semibold text-[#f8fafc] mb-2">
                        Not a Directory
                    </h2>
                    <p className="font-mono text-sm text-[#64748b] mb-6">
                        The specified path is a file, not a directory
                    </p>
                </div>
            </div>
        );
    }

    if (errorMessage.includes("permission denied")) {
        return (
            <div className="min-h-screen flex items-center justify-center p-8">
                <div className="glass-card rounded-2xl p-12 text-center max-w-md">
                    <div className="relative inline-block mb-6">
                        <div className="absolute inset-0 bg-[#ef4444] blur-2xl opacity-20"></div>
                        <AlertCircle className="h-16 w-16 text-[#ef4444] relative" />
                    </div>
                    <h2 className="font-heading text-xl font-semibold text-[#f8fafc] mb-2">
                        Access Denied
                    </h2>
                    <p className="font-mono text-sm text-[#64748b] mb-6">
                        You do not have permission to access this resource
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center p-8">
            <div className="glass-card rounded-2xl p-12 text-center max-w-md">
                <div className="relative inline-block mb-6">
                    <div className="absolute inset-0 bg-[#ef4444] blur-2xl opacity-20"></div>
                    <AlertCircle className="h-16 w-16 text-[#ef4444] relative" />
                </div>
                <h2 className="font-heading text-xl font-semibold text-[#f8fafc] mb-2">
                    Error Loading Files
                </h2>
                <p className="font-mono text-sm text-[#64748b] mb-4">
                    {error.message}
                </p>
            </div>
        </div>
    );
}
