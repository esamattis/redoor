import type { LsDirectoryResponse } from "#bindings/LsDirectoryResponse";
import type { LsFileResponse } from "#bindings/LsFileResponse";
import type { AgentListResponse } from "#bindings/AgentListResponse";
import type { AgentDetailsResponse } from "#bindings/AgentDetailsResponse";
import type { EchoRequest } from "#bindings/EchoRequest";
import type { EchoResponse } from "#bindings/EchoResponse";
import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import type { AgentConnectionStatus } from "#bindings/AgentConnectionStatus";
import type { StartAgentResponse } from "#bindings/StartAgentResponse";
import type { RetryAgentStartResponse } from "#bindings/RetryAgentStartResponse";
import type { ShutdownAgentResponse } from "#bindings/ShutdownAgentResponse";
import type { TransferDirection } from "#bindings/TransferDirection";
import type { TransferProgressEntry } from "#bindings/TransferProgressEntry";
import type { TransferProgressListResponse } from "#bindings/TransferProgressListResponse";
import type { TransferProgressState } from "#bindings/TransferProgressState";
import type { CancelTransferResponse } from "#bindings/CancelTransferResponse";
import type { UiEvent } from "#bindings/UiEvent";
import type { RawDeleteResponse } from "#bindings/RawDeleteResponse";
import type { FileEditResponse } from "#bindings/FileEditResponse";
import type { TrashListResponse } from "#bindings/TrashListResponse";
import type { EmptyTrashResponse } from "#bindings/EmptyTrashResponse";
import type { RestoreTrashItemRequest } from "#bindings/RestoreTrashItemRequest";
import type { RestoreTrashItemResponse } from "#bindings/RestoreTrashItemResponse";
import type { CreateDirectoryResponse } from "#bindings/CreateDirectoryResponse";
import type { CopyFileRequest } from "#bindings/CopyFileRequest";
import type { CopyFileResponse } from "#bindings/CopyFileResponse";
import type { CopyEndpoint } from "#bindings/CopyEndpoint";
import type { CopyExistingMode } from "#bindings/CopyExistingMode";
import type { MoveFileRequest } from "#bindings/MoveFileRequest";
import type { MoveFileResponse } from "#bindings/MoveFileResponse";
import type { TerminalSize } from "#bindings/TerminalSize";
import type { TerminalClientMessage } from "#bindings/TerminalClientMessage";
import type { TerminalServerMessage } from "#bindings/TerminalServerMessage";
import type { LoginRequest } from "#bindings/LoginRequest";
import type { LoginResponse } from "#bindings/LoginResponse";
import type { LogoutResponse } from "#bindings/LogoutResponse";
import type { MetadataResponse } from "#bindings/MetadataResponse";
import type { CreateOneTimeTokenResponse } from "#bindings/CreateOneTimeTokenResponse";
import type { OpenPathResponse } from "#bindings/OpenPathResponse";
import type { ServerInfoResponse } from "#bindings/ServerInfoResponse";
import type { ServerAuthMode } from "#bindings/ServerAuthMode";
import type { ServerBuildMode } from "#bindings/ServerBuildMode";
import type { BinaryIdentity } from "#bindings/BinaryIdentity";
import type { RestartResponse } from "#bindings/RestartResponse";
import type { UpgradeAgentResponse } from "#bindings/UpgradeAgentResponse";
import type { UpgradeAgentRequest } from "#bindings/UpgradeAgentRequest";
import type { LogEvent } from "#bindings/LogEvent";
import type { LogEntry } from "#bindings/LogEntry";
import type { LogErrorDetails } from "#bindings/LogErrorDetails";
import type { RenamePathRequest } from "#bindings/RenamePathRequest";
import type { RenamePathResponse } from "#bindings/RenamePathResponse";
import type { FileSearchResponse } from "#bindings/FileSearchResponse";
import type { FileSearchEntry } from "#bindings/FileSearchEntry";
import type { FindRequest } from "#bindings/FindRequest";
import type { GrepRequest } from "#bindings/GrepRequest";
import type { ContentGrepMatch } from "#bindings/ContentGrepMatch";
import type { ContentGrepResponse } from "#bindings/ContentGrepResponse";
import type { DiffEndpoint } from "#bindings/DiffEndpoint";
import type { DiffFilesRequest } from "#bindings/DiffFilesRequest";
import type { DiffFilesResponse } from "#bindings/DiffFilesResponse";
import type { CreateSshAgentRequest } from "#bindings/CreateSshAgentRequest";
import type { CreateSshAgentResponse } from "#bindings/CreateSshAgentResponse";
import type { ManagedSshAgentConfigurationResponse } from "#bindings/ManagedSshAgentConfigurationResponse";
import type { UpdateSshAgentResponse } from "#bindings/UpdateSshAgentResponse";
import type { CreateLocalAgentRequest } from "#bindings/CreateLocalAgentRequest";
import type { CreateLocalAgentResponse } from "#bindings/CreateLocalAgentResponse";
import type { ManagedLocalAgentConfigurationResponse } from "#bindings/ManagedLocalAgentConfigurationResponse";
import type { UpdateLocalAgentResponse } from "#bindings/UpdateLocalAgentResponse";
import type { DeleteManagedAgentResponse } from "#bindings/DeleteManagedAgentResponse";
import type { UpdateUserStateRequest } from "#bindings/UpdateUserStateRequest";
import type { UserStateResponse } from "#bindings/UserStateResponse";
import type { GitContextResponse } from "#bindings/GitContextResponse";
import type { GitStatusResponse } from "#bindings/GitStatusResponse";
import type { GitDiffResponse } from "#bindings/GitDiffResponse";
import type { GitDiffRequest } from "#bindings/GitDiffRequest";
import type { GitDiffMode } from "#bindings/GitDiffMode";
import type { DirectorySizeResponse } from "#bindings/DirectorySizeResponse";
import type { Level } from "#bindings/Level";
import type { LoggingLevelRequest } from "#bindings/LoggingLevelRequest";
import type { LoggingLevelResponse } from "#bindings/LoggingLevelResponse";
import {
    apiRequest,
    requireSuccessfulResponse,
    withAuthentication,
    type RequestContext,
} from "#ui/api-transport";
import * as apiPaths from "#ui/api-paths";

const { appendFilesystemPath, encodeFilesystemPath, getBrowserUrl } = apiPaths;

export { ApiError } from "#ui/api-transport";
export { encodeFilesystemPath, getBrowserUrl };

export type {
    LsDirectoryResponse,
    LsFileResponse,
    MetadataResponse,
    CreateOneTimeTokenResponse,
    DirectorySizeResponse,
    RawDeleteResponse,
    TrashListResponse,
    EmptyTrashResponse,
    RestoreTrashItemRequest,
    RestoreTrashItemResponse,
    CreateDirectoryResponse,
    TransferDirection,
    TransferProgressEntry,
    TransferProgressListResponse,
    TransferProgressState,
    CancelTransferResponse,
    UiEvent,
    CopyFileRequest,
    CopyFileResponse,
    CopyEndpoint,
    CopyExistingMode,
    MoveFileRequest,
    MoveFileResponse,
    TerminalSize,
    TerminalClientMessage,
    TerminalServerMessage,
    ServerInfoResponse,
    ServerAuthMode,
    ServerBuildMode,
    BinaryIdentity,
    RestartResponse,
    UpgradeAgentResponse,
    UpgradeAgentRequest,
    LogEvent,
    LogEntry,
    LogErrorDetails,
    AgentConnectionStatus,
    StartAgentResponse,
    RetryAgentStartResponse,
    ShutdownAgentResponse,
    RenamePathRequest,
    RenamePathResponse,
    FileSearchResponse,
    FileSearchEntry,
    ContentGrepMatch,
    ContentGrepResponse,
    DiffEndpoint,
    DiffFilesRequest,
    DiffFilesResponse,
    CreateSshAgentRequest,
    CreateSshAgentResponse,
    ManagedSshAgentConfigurationResponse,
    UpdateSshAgentResponse,
    CreateLocalAgentRequest,
    CreateLocalAgentResponse,
    ManagedLocalAgentConfigurationResponse,
    UpdateLocalAgentResponse,
    DeleteManagedAgentResponse,
    UpdateUserStateRequest,
    UserStateResponse,
    GitContextResponse,
    GitStatusResponse,
    GitDiffResponse,
    GitDiffMode,
    Level,
    LoggingLevelRequest,
    LoggingLevelResponse,
};

type CopyFileResponseJson = {
    copy_request_id: number;
};

type MoveFileResponseJson = {
    move_request_id: number;
};

export type LsResponse = LsDirectoryResponse | LsFileResponse;

export function isLsDirectoryResponse(
    response: LsResponse,
): response is LsDirectoryResponse {
    return "files" in response;
}

export function isLsFileResponse(
    response: LsResponse,
): response is LsFileResponse {
    return !("files" in response);
}

export class Agent {
    private baseUrl: string;
    private info: AgentInfoResponse;
    private requestContext: RequestContext;

    constructor(
        baseUrl: string,
        info: AgentInfoResponse,
        requestContext: RequestContext = {},
    ) {
        this.baseUrl = baseUrl;
        this.info = info;
        this.requestContext = requestContext;
    }

    /** Returns authentication headers for lower-level streaming tests and integrations. */
    getAuthHeaders(): Record<string, string> {
        const sessionCookie = this.requestContext.getSessionCookie?.();
        return sessionCookie ? { Cookie: sessionCookie } : {};
    }

    /** Reads the threshold from the connected agent over its authoritative control socket. */
    async getLoggingLevel(): Promise<LoggingLevelResponse> {
        return apiRequest<LoggingLevelResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.id)}/logging-level`,
            undefined,
            this.requestContext,
        );
    }

    /** Changes logging admission without reconnecting this agent or its live viewer. */
    async updateLoggingLevel(level: Level): Promise<LoggingLevelResponse> {
        const request: LoggingLevelRequest = { level };
        return apiRequest<LoggingLevelResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.id)}/logging-level`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext,
        );
    }

    get id(): string {
        return this.info.id;
    }

    get name(): string {
        return this.info.name;
    }

    get cwd(): string | null {
        return this.info.cwd;
    }

    /** Indicates whether lifecycle controls are backed by a TOML supervisor. */
    get managed(): boolean {
        return this.info.managed;
    }

    /** Indicates whether this managed entry is backed by editable SSH TOML fields. */
    get configurationEditable(): boolean {
        return this.info.configuration_editable;
    }

    /** Indicates whether this connection implements move-to-trash, listing, and restore. */
    get supportsTrash(): boolean {
        return this.info.supports_trash;
    }

    /** Indicates whether this connection can move entries to its platform trash. */
    get supportsMoveToTrash(): boolean {
        return this.info.supports_move_to_trash || this.info.supports_trash;
    }

    /** Returns the configured SSH destination for inventory labels. */
    get sshTarget(): string | null {
        return this.info.ssh_target;
    }

    /** Returns the retained public lifecycle state. */
    get status(): AgentConnectionStatus {
        return this.info.status;
    }

    /** Returns the start of the current connection only. */
    get connectedAt(): number | null {
        return this.info.connected_at;
    }

    /** Identifies the current control socket so process restarts can await a replacement. */
    get connectionId(): string | null {
        return this.info.connection_id;
    }

    /** Returns the server-observed end of the most recent connection. */
    get lastSeenAt(): number | null {
        return this.info.last_seen_at;
    }

    /** Returns the latest managed startup or connection diagnostic. */
    get connectionIssue(): string | null {
        return this.info.connection_issue;
    }

    /** Returns sticky SSH start steps for the current attempt. */
    get provisioningStatus(): AgentInfoResponse["provisioning_status"] {
        return this.info.provisioning_status;
    }

    /** Returns binary identity from the latest registration, if any. */
    get binary(): BinaryIdentity | null {
        return this.info.binary;
    }

    /** Reports whether this session can complete the safe in-place upgrade protocol. */
    get supportsSelfExec(): boolean {
        return this.info.supports_self_exec;
    }

    /** Reports whether this session can launch paths in its graphical desktop. */
    get supportsNativeOpen(): boolean {
        return this.info.supports_native_open;
    }

    /** Requests desired-running without waiting for process preparation or registration. */
    async start(): Promise<StartAgentResponse> {
        return apiRequest(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/start`,
            { method: "POST" },
            this.requestContext,
        );
    }

    /** Cancels the current managed startup attempt before immediately beginning a clean one. */
    async retryStart(): Promise<RetryAgentStartResponse> {
        return apiRequest(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/retry-start`,
            { method: "POST" },
            this.requestContext,
        );
    }

    /** Waits for the managed supervisor to cancel work and reap its child. */
    async shutdown(): Promise<ShutdownAgentResponse> {
        return apiRequest(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/shutdown`,
            { method: "POST" },
            this.requestContext,
        );
    }

    /** Asks the connected agent process to replace itself with the same binary and arguments. */
    async restart(): Promise<RestartResponse> {
        return apiRequest(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/restart`,
            { method: "POST" },
            this.requestContext,
        );
    }

    /** Atomically installs a selected release and asks the agent to execute it in place. */
    async upgrade(targetVersion: string): Promise<UpgradeAgentResponse> {
        const request: UpgradeAgentRequest = {
            source: "published_release",
            target_version: targetVersion,
        };
        return apiRequest(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/upgrade`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
            },
            this.requestContext,
        );
    }

    /** Force-installs the exact running server executable on a matching architecture. */
    async forceInstallRunningBinary(): Promise<UpgradeAgentResponse> {
        const request: UpgradeAgentRequest = { source: "running_server" };
        return apiRequest(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/upgrade`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
            },
            this.requestContext,
        );
    }

    async getDetails(): Promise<AgentDetailsResponse> {
        return apiRequest(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}`,
            undefined,
            this.requestContext,
        );
    }

    /** Asks the agent desktop to open a file or directory with its native application. */
    async openPath(path: string): Promise<OpenPathResponse> {
        return apiRequest<OpenPathResponse>(
            `${this.baseUrl}${appendFilesystemPath(
                `/api/v1/agents/${encodeURIComponent(this.info.id)}/open`,
                path,
            )}`,
            { method: "POST" },
            this.requestContext,
        );
    }

    async ls(path: string): Promise<LsResponse> {
        return apiRequest<LsResponse>(
            `${this.baseUrl}${appendFilesystemPath(
                `/api/v1/agents/${encodeURIComponent(this.info.id)}/ls`,
                path,
            )}`,
            undefined,
            this.requestContext,
        );
    }

    /** Discovers repository availability and classifies one browser path. */
    async gitContext(path: string): Promise<GitContextResponse> {
        return apiRequest<GitContextResponse>(
            `${this.baseUrl}${appendFilesystemPath(
                `/api/v1/agents/${encodeURIComponent(this.info.id)}/git/context`,
                path,
            )}`,
            undefined,
            this.requestContext,
        );
    }

    /** Returns bounded repository status below one literal directory path. */
    async gitStatus(path: string): Promise<GitStatusResponse> {
        return apiRequest<GitStatusResponse>(
            `${this.baseUrl}${appendFilesystemPath(
                `/api/v1/agents/${encodeURIComponent(this.info.id)}/git/status`,
                path,
            )}`,
            undefined,
            this.requestContext,
        );
    }

    /** Compares ordered files with HEAD using either worktree or index contents. */
    async gitDiff(
        files: string[],
        mode: GitDiffMode,
    ): Promise<GitDiffResponse> {
        const request: GitDiffRequest = { files, mode };
        return apiRequest<GitDiffResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/git/diff`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext,
        );
    }

    /** Searches below one directory while allowing superseded UI requests to be cancelled. */
    async searchFiles(
        path: string,
        query: string,
        options: {
            timeoutSeconds: number;
            includeHidden: boolean;
            respectGitignore: boolean;
            caseSensitivity?: FindRequest["case_sensitivity"];
            signal?: AbortSignal;
        },
    ): Promise<FileSearchResponse> {
        const request: FindRequest = {
            agent: this.info.id,
            path,
            query,
            timeout: options.timeoutSeconds,
            include_hidden: options.includeHidden,
            respect_gitignore: options.respectGitignore,
            case_sensitivity: options.caseSensitivity ?? "smart",
        };
        return apiRequest<FileSearchResponse>(
            `${this.baseUrl}/api/v1/find`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
                signal: options.signal,
            },
            this.requestContext,
        );
    }

    /** Greps physical lines below one directory while allowing callers to abandon the REST wait. */
    async grepContent(
        path: string,
        query: string,
        options: {
            timeoutSeconds: number;
            includeHidden: boolean;
            respectGitignore: boolean;
            fixedString: boolean;
            caseSensitivity?: GrepRequest["case_sensitivity"];
            beforeContext?: number;
            afterContext?: number;
            signal?: AbortSignal;
        },
    ): Promise<ContentGrepResponse> {
        const request: GrepRequest = {
            agent: this.info.id,
            path,
            query,
            timeout: options.timeoutSeconds,
            include_hidden: options.includeHidden,
            respect_gitignore: options.respectGitignore,
            fixed_string: options.fixedString,
            case_sensitivity: options.caseSensitivity ?? "smart",
            before_context: options.beforeContext ?? 0,
            after_context: options.afterContext ?? 0,
        };
        return apiRequest<ContentGrepResponse>(
            `${this.baseUrl}/api/v1/grep`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
                signal: options.signal,
            },
            this.requestContext,
        );
    }

    async echo(
        message: string,
        random_sleep: boolean = false,
    ): Promise<EchoResponse> {
        const request: EchoRequest = { message, random_sleep };
        return apiRequest(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/echo`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
            },
            this.requestContext,
        );
    }

    async raw(path: string): Promise<ArrayBuffer> {
        const response = await this.download(path);
        return response.arrayBuffer();
    }

    /** Fetches agent-side file sniffing results including the UTF-8 editable gate. */
    async metadata(path: string): Promise<MetadataResponse> {
        return apiRequest<MetadataResponse>(
            `${this.baseUrl}${appendFilesystemPath(
                `/api/v1/agents/${encodeURIComponent(this.info.id)}/metadata`,
                path,
            )}`,
            undefined,
            this.requestContext,
        );
    }

    /** Calculates recursive regular-file bytes only when directory details request it. */
    async calculateDirectorySize(path: string): Promise<DirectorySizeResponse> {
        return apiRequest<DirectorySizeResponse>(
            `${this.baseUrl}${appendFilesystemPath(
                `/api/v1/agents/${encodeURIComponent(this.info.id)}/directory-size`,
                path,
            )}`,
            { method: "POST" },
            this.requestContext,
        );
    }

    /** Creates an anonymous download credential only after an explicit sharing action. */
    async createOneTimeToken(
        path: string,
    ): Promise<CreateOneTimeTokenResponse> {
        return apiRequest<CreateOneTimeTokenResponse>(
            `${this.baseUrl}${appendFilesystemPath(
                `/api/v1/agents/${encodeURIComponent(this.info.id)}/one-time-token`,
                path,
            )}`,
            { method: "POST" },
            this.requestContext,
        );
    }

    getRawUrl(path: string, options?: { download?: boolean }): string {
        let url = `${this.baseUrl}${appendFilesystemPath(
            `/api/v1/agents/${encodeURIComponent(this.info.id)}/raw`,
            path,
        )}`;
        if (options?.download) {
            url += "?download=1";
        }
        return url;
    }

    /** Returns a browser URL that keeps filesystem separators readable. */
    getBrowserUrl(path: string): string {
        return getBrowserUrl(this.info.id, path);
    }

    /** Builds the authenticated browser endpoint for one ephemeral agent log tunnel. */
    getLogsWebSocketUrl(): string {
        const url = new URL(
            `/api/v1/agents/${encodeURIComponent(this.info.id)}/logs/ws`,
            this.baseUrl,
        );
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.toString();
    }

    /** Builds one terminal socket with the directory captured by its UI tab. */
    getTerminalWebSocketUrl(size: TerminalSize, cwd: string): string {
        if (!cwd.startsWith("/")) {
            throw new Error("Filesystem path must be absolute");
        }
        const url = new URL(
            `/api/v1/agents/${encodeURIComponent(this.info.id)}/terminal/ws`,
            this.baseUrl,
        );
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("rows", String(size.rows));
        url.searchParams.set("cols", String(size.cols));
        url.searchParams.set("cwd", cwd);
        return url.toString();
    }

    async upload(path: string, file: File): Promise<Response> {
        const response = await fetch(
            this.getRawUrl(path),
            withAuthentication(
                {
                    method: "PUT",
                    headers: {
                        "Content-Type": file.type || "application/octet-stream",
                    },
                    body: file,
                },
                this.requestContext,
            ),
        );
        await requireSuccessfulResponse(response, this.requestContext);
        return response;
    }

    /** Rewrites one existing file inode through the dedicated editor endpoint. */
    async editFile(path: string, file: File): Promise<FileEditResponse> {
        const route = `/api/v1/agents/${encodeURIComponent(this.info.id)}/edit`;
        return apiRequest<FileEditResponse>(
            `${this.baseUrl}${appendFilesystemPath(route, path)}`,
            { method: "PUT", body: file },
            this.requestContext,
        );
    }

    async deleteFile(
        path: string,
        options?: { trash?: boolean },
    ): Promise<RawDeleteResponse> {
        const url = new URL(this.getRawUrl(path), this.baseUrl);
        if (options?.trash !== undefined) {
            url.searchParams.set("trash", String(options.trash));
        }
        const response = await fetch(
            url,
            withAuthentication({ method: "DELETE" }, this.requestContext),
        );
        await requireSuccessfulResponse(response, this.requestContext);
        return response.json();
    }

    /** Lists trash locations and items discovered by the agent at request time. */
    async listTrash(): Promise<TrashListResponse> {
        return apiRequest<TrashListResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/trash`,
            { method: "GET" },
            this.requestContext,
        );
    }

    /** Permanently removes every entry from all trash locations discovered by the agent. */
    async emptyTrash(): Promise<EmptyTrashResponse> {
        return apiRequest<EmptyTrashResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/trash`,
            { method: "DELETE" },
            this.requestContext,
        );
    }

    /** Restores one item selected from the opaque identifiers returned by `listTrash`. */
    async restoreTrashItem(
        request: RestoreTrashItemRequest,
    ): Promise<RestoreTrashItemResponse> {
        return apiRequest<RestoreTrashItemResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/trash/restore`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext,
        );
    }

    async createDirectory(path: string): Promise<CreateDirectoryResponse> {
        const response = await fetch(
            `${this.baseUrl}${appendFilesystemPath(
                `/api/v1/agents/${encodeURIComponent(this.info.id)}/mkdir`,
                path,
            )}`,
            withAuthentication(
                {
                    method: "POST",
                },
                this.requestContext,
            ),
        );
        await requireSuccessfulResponse(response, this.requestContext);
        return response.json();
    }

    /** Atomically changes one entry's name without allowing a directory move. */
    async renamePath(
        dir: string,
        oldName: string,
        newName: string,
    ): Promise<RenamePathResponse> {
        encodeFilesystemPath(dir);
        const request: RenamePathRequest = {
            dir,
            old: oldName,
            new: newName,
        };

        return apiRequest<RenamePathResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/rename`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext,
        );
    }

    async copyTo(
        destination: CopyEndpoint,
        sourcePath: string,
        options?: {
            on_existing?: CopyExistingMode;
        },
    ): Promise<CopyFileResponse> {
        encodeFilesystemPath(sourcePath);
        encodeFilesystemPath(destination.path);
        const request: CopyFileRequest = {
            source: {
                agent: this.info.id,
                path: sourcePath,
            },
            dest: destination,
            on_existing: options?.on_existing ?? "error",
        };

        const response = await apiRequest<CopyFileResponseJson>(
            `${this.baseUrl}/api/v1/copy`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
            },
            this.requestContext,
        );

        return {
            copy_request_id: response.copy_request_id,
        };
    }

    /** Starts a smart move that deletes the source only after destination publication. */
    async moveTo(
        destination: CopyEndpoint,
        sourcePath: string,
        options?: { on_existing?: CopyExistingMode },
    ): Promise<MoveFileResponse> {
        encodeFilesystemPath(sourcePath);
        encodeFilesystemPath(destination.path);
        const request: MoveFileRequest = {
            source: { agent: this.info.id, path: sourcePath },
            dest: destination,
            on_existing: options?.on_existing ?? "error",
        };
        const response = await apiRequest<MoveFileResponseJson>(
            `${this.baseUrl}/api/v1/move`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext,
        );
        return { move_request_id: response.move_request_id };
    }

    async download(
        path: string,
        options?: {
            range?: [number | null, number | null];
            method?: "GET" | "HEAD";
            download?: boolean;
        },
    ): Promise<Response> {
        const url = this.getRawUrl(path, {
            download: options?.download,
        });

        const fetchOptions: RequestInit = {};
        if (options?.method) {
            fetchOptions.method = options.method;
        }
        if (options?.range) {
            const [start, end] = options.range;
            if (start === null && end !== null) {
                // Suffix range: bytes=-N
                fetchOptions.headers = { Range: `bytes=-${end}` };
            } else if (end === null) {
                // Open-ended range: bytes=start-
                fetchOptions.headers = { Range: `bytes=${start}-` };
            } else if (end !== undefined) {
                // Full range: bytes=start-end
                fetchOptions.headers = { Range: `bytes=${start}-${end}` };
            }
        }

        const response = await fetch(
            url,
            withAuthentication(fetchOptions, this.requestContext),
        );

        // 416 Range Not Satisfiable is a valid response for range requests.
        if (response.status !== 416) {
            await requireSuccessfulResponse(response, this.requestContext);
        }

        return response;
    }
}

export class ApiClient {
    baseUrl: string;
    private sessionCookie: string | null = null;
    private unauthorizedHandler: (() => void) | undefined;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    /** Installs navigation behavior after the router exists, avoiding an API-to-router dependency. */
    setUnauthorizedHandler(handler: () => void): void {
        this.unauthorizedHandler = handler;
    }

    /** Returns authentication headers for direct streaming requests outside this wrapper. */
    getAuthHeaders(): Record<string, string> {
        return this.sessionCookie ? { Cookie: this.sessionCookie } : {};
    }

    /** Shares current cookie and expiry handling with agents created by this client. */
    private requestContext(): RequestContext {
        return {
            getSessionCookie: () => this.sessionCookie,
            onUnauthorized: () => this.unauthorizedHandler?.(),
        };
    }

    /** Establishes a browser cookie and captures it explicitly when running under Node fetch. */
    async login(username: string, password: string): Promise<LoginResponse> {
        const request: LoginRequest = { username, password };
        const response = await fetch(
            `${this.baseUrl}/api/v1/login`,
            withAuthentication(
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(request),
                },
                { getSessionCookie: () => this.sessionCookie },
            ),
        );
        await requireSuccessfulResponse(response, {});
        const setCookie = response.headers.get("set-cookie");
        if (setCookie) {
            this.sessionCookie = setCookie.split(";", 1)[0] ?? null;
        }
        return response.json();
    }

    /** Deletes the server-side session and forgets any Node-managed cookie. */
    async logout(): Promise<LogoutResponse> {
        const response = await apiRequest<LogoutResponse>(
            `${this.baseUrl}/api/v1/logout`,
            { method: "POST" },
            this.requestContext(),
        );
        this.sessionCookie = null;
        return response;
    }

    /** Asks the server to restart in place after validating its configuration. */
    async restartServer(): Promise<RestartResponse> {
        return apiRequest<RestartResponse>(
            `${this.baseUrl}/api/v1/server/restart`,
            { method: "POST" },
            this.requestContext(),
        );
    }

    getUiWebSocketUrl(): string {
        const url = new URL("/api/v1/ui/ws", this.baseUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.toString();
    }

    /** Builds the authenticated, route-scoped server-log socket URL. */
    getServerLogsWebSocketUrl(): string {
        const url = new URL("/api/v1/server/logs/ws", this.baseUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.toString();
    }

    /** Reads the server process's current runtime threshold. */
    async getServerLoggingLevel(): Promise<LoggingLevelResponse> {
        return apiRequest<LoggingLevelResponse>(
            `${this.baseUrl}/api/v1/server/logging-level`,
            undefined,
            this.requestContext(),
        );
    }

    /** Changes server logging admission while retaining the mounted live stream. */
    async updateServerLoggingLevel(
        level: Level,
    ): Promise<LoggingLevelResponse> {
        const request: LoggingLevelRequest = { level };
        return apiRequest<LoggingLevelResponse>(
            `${this.baseUrl}/api/v1/server/logging-level`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    async listAgents(): Promise<Agent[]> {
        const response = await apiRequest<AgentListResponse>(
            `${this.baseUrl}/api/v1/agents`,
            undefined,
            this.requestContext(),
        );
        return response.agents.map(
            (info) => new Agent(this.baseUrl, info, this.requestContext()),
        );
    }

    /** Persists and dynamically registers one dormant SSH-backed managed agent. */
    async createSshAgent(
        request: CreateSshAgentRequest,
    ): Promise<CreateSshAgentResponse> {
        return apiRequest<CreateSshAgentResponse>(
            `${this.baseUrl}/api/v1/agents`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Loads persisted SSH settings for a managed-agent edit form. */
    async getSshAgentConfiguration(
        agentId: string,
    ): Promise<ManagedSshAgentConfigurationResponse> {
        return apiRequest<ManagedSshAgentConfigurationResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/configuration`,
            undefined,
            this.requestContext(),
        );
    }

    /** Replaces one stopped SSH-backed managed-agent configuration. */
    async updateSshAgent(
        agentId: string,
        request: CreateSshAgentRequest,
    ): Promise<UpdateSshAgentResponse> {
        return apiRequest<UpdateSshAgentResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Persists and dynamically registers one dormant local managed agent. */
    async createLocalAgent(
        request: CreateLocalAgentRequest,
    ): Promise<CreateLocalAgentResponse> {
        return apiRequest<CreateLocalAgentResponse>(
            `${this.baseUrl}/api/v1/local-agents`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Loads persisted local settings for a managed-agent edit form. */
    async getLocalAgentConfiguration(
        agentId: string,
    ): Promise<ManagedLocalAgentConfigurationResponse> {
        return apiRequest<ManagedLocalAgentConfigurationResponse>(
            `${this.baseUrl}/api/v1/local-agents/${encodeURIComponent(agentId)}/configuration`,
            undefined,
            this.requestContext(),
        );
    }

    /** Replaces one stopped local managed-agent configuration. */
    async updateLocalAgent(
        agentId: string,
        request: CreateLocalAgentRequest,
    ): Promise<UpdateLocalAgentResponse> {
        return apiRequest<UpdateLocalAgentResponse>(
            `${this.baseUrl}/api/v1/local-agents/${encodeURIComponent(agentId)}`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Permanently removes one stopped managed-agent entry. */
    async deleteManagedAgent(
        agentId: string,
    ): Promise<DeleteManagedAgentResponse> {
        return apiRequest<DeleteManagedAgentResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}`,
            { method: "DELETE" },
            this.requestContext(),
        );
    }

    async getTransferProgress(): Promise<TransferProgressListResponse> {
        return apiRequest<TransferProgressListResponse>(
            `${this.baseUrl}/api/v1/transfers/progress`,
            undefined,
            this.requestContext(),
        );
    }

    async cancelTransfer(transferId: number): Promise<CancelTransferResponse> {
        return apiRequest<CancelTransferResponse>(
            `${this.baseUrl}/api/v1/transfers/${encodeURIComponent(String(transferId))}/cancel`,
            { method: "POST" },
            this.requestContext(),
        );
    }

    /** Generates a unified diff after both agents confirm their files are editable. */
    async diffFiles(
        left: DiffEndpoint,
        right: DiffEndpoint,
    ): Promise<DiffFilesResponse> {
        encodeFilesystemPath(left.path);
        encodeFilesystemPath(right.path);
        const request: DiffFilesRequest = { left, right };
        return apiRequest<DiffFilesResponse>(
            `${this.baseUrl}/api/v1/diff`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Returns server identity and agent bootstrap settings for the authenticated home page. */
    async getServerInfo(): Promise<ServerInfoResponse> {
        return apiRequest<ServerInfoResponse>(
            `${this.baseUrl}/api/v1/server`,
            undefined,
            this.requestContext(),
        );
    }

    /** Loads the opaque JSON document stored for the authenticated account. */
    async getUserState(): Promise<UserStateResponse> {
        return apiRequest<UserStateResponse>(
            `${this.baseUrl}/api/v1/user/state`,
            undefined,
            this.requestContext(),
        );
    }

    /** Replaces the authenticated account's persisted JSON document. */
    async updateUserState(
        request: UpdateUserStateRequest,
    ): Promise<UserStateResponse> {
        return apiRequest<UserStateResponse>(
            `${this.baseUrl}/api/v1/user/state`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    async waitForAgentNames(names: string[], timeoutMs = 5000): Promise<void> {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            const agents = await this.listAgents();
            const currentNames = agents.map((agent) => agent.name);
            if (names.every((name) => currentNames.includes(name))) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`Timed out waiting for agents: ${names.join(", ")}`);
    }

    /** Polls for live sockets now that listAgents also returns dormant inventory. */
    async waitForConnectedAgentNames(
        names: string[],
        timeoutMs: number = 5000,
    ): Promise<void> {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            const connectedNames = (await this.listAgents())
                .filter((agent) => agent.status === "connected")
                .map((agent) => agent.name);
            if (names.every((name) => connectedNames.includes(name))) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(
            `Timed out waiting for connected agents: ${names.join(", ")}`,
        );
    }
}
