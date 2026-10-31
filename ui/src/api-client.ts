import type { ResumeMode } from "#bindings/ResumeMode";
import type { CopyPreflightRequest } from "#bindings/CopyPreflightRequest";
import type { CopyPreflightResponse } from "#bindings/CopyPreflightResponse";
import type { PartialsResponse } from "#bindings/PartialsResponse";
import type { PartialActionRequest } from "#bindings/PartialActionRequest";
import type { ResumePartialResponse } from "#bindings/ResumePartialResponse";
import type { DiscardPartialResponse } from "#bindings/DiscardPartialResponse";
import type { PauseTransferResponse } from "#bindings/PauseTransferResponse";
import type { ProtocolMismatchListResponse } from "#bindings/ProtocolMismatchListResponse";
import type { AgentListResponse } from "#bindings/AgentListResponse";
import type { AgentDetailsResponse } from "#bindings/AgentDetailsResponse";
import type { EchoRequest } from "#bindings/EchoRequest";
import type { EchoResponse } from "#bindings/EchoResponse";
import type { AgentInfoResponse } from "#bindings/AgentInfoResponse";
import type { DuplicateIdWarning } from "#bindings/DuplicateIdWarning";
import type { AgentConnectionStatus } from "#bindings/AgentConnectionStatus";
import type { StartAgentResponse } from "#bindings/StartAgentResponse";
import type { RetryAgentStartResponse } from "#bindings/RetryAgentStartResponse";
import type { ShutdownAgentResponse } from "#bindings/ShutdownAgentResponse";
import type { TransferProgressListResponse } from "#bindings/TransferProgressListResponse";
import type { CancelTransferResponse } from "#bindings/CancelTransferResponse";
import type { RawDeleteResponse } from "#bindings/RawDeleteResponse";
import type { RawUploadResponse } from "#bindings/RawUploadResponse";
import type { FileEditResponse } from "#bindings/FileEditResponse";
import type { TrashListResponse } from "#bindings/TrashListResponse";
import type { EmptyTrashResponse } from "#bindings/EmptyTrashResponse";
import type { RestoreTrashItemRequest } from "#bindings/RestoreTrashItemRequest";
import type { RestoreTrashItemResponse } from "#bindings/RestoreTrashItemResponse";
import type { CreateDirectoryResponse } from "#bindings/CreateDirectoryResponse";
import type { CreationOwnershipOptions } from "#bindings/CreationOwnershipOptions";
import type { CopyFileRequest } from "#bindings/CopyFileRequest";
import type { CopyFileResponse } from "#bindings/CopyFileResponse";
import type { CopyEndpoint } from "#bindings/CopyEndpoint";
import type { CopyExistingMode } from "#bindings/CopyExistingMode";
import type { MoveFileRequest } from "#bindings/MoveFileRequest";
import type { MoveFileResponse } from "#bindings/MoveFileResponse";
import type { TerminalSize } from "#bindings/TerminalSize";
import type { TerminalSessionList } from "#bindings/TerminalSessionList";
import type { CreateTerminalSessionRequest } from "#bindings/CreateTerminalSessionRequest";
import type { CreateTerminalSessionResponse } from "#bindings/CreateTerminalSessionResponse";
import type { CloseTerminalSessionResponse } from "#bindings/CloseTerminalSessionResponse";
import type { LoginRequest } from "#bindings/LoginRequest";
import type { LoginResponse } from "#bindings/LoginResponse";
import type { LoginMethodsResponse } from "#bindings/LoginMethodsResponse";
import type { LogoutResponse } from "#bindings/LogoutResponse";
import type { MetadataResponse } from "#bindings/MetadataResponse";
import type { CreateOneTimeTokenResponse } from "#bindings/CreateOneTimeTokenResponse";
import type { OpenPathResponse } from "#bindings/OpenPathResponse";
import type { ServerInfoResponse } from "#bindings/ServerInfoResponse";
import type { BinaryIdentity } from "#bindings/BinaryIdentity";
import type { RestartResponse } from "#bindings/RestartResponse";
import type { ServerUpgradeRequest } from "#bindings/ServerUpgradeRequest";
import type { ServerUpgradeResponse } from "#bindings/ServerUpgradeResponse";
import type { UpgradeAgentResponse } from "#bindings/UpgradeAgentResponse";
import type { UpgradeAgentRequest } from "#bindings/UpgradeAgentRequest";
import type { RenamePathRequest } from "#bindings/RenamePathRequest";
import type { RenamePathResponse } from "#bindings/RenamePathResponse";
import type { FileSearchResponse } from "#bindings/FileSearchResponse";
import type { FindRequest } from "#bindings/FindRequest";
import type { GrepRequest } from "#bindings/GrepRequest";
import type { ContentGrepResponse } from "#bindings/ContentGrepResponse";
import type { DiffEndpoint } from "#bindings/DiffEndpoint";
import type { DiffFilesRequest } from "#bindings/DiffFilesRequest";
import type { DiffFilesResponse } from "#bindings/DiffFilesResponse";
import type { CreateSshAgentRequest } from "#bindings/CreateSshAgentRequest";
import type { CreateSshAgentResponse } from "#bindings/CreateSshAgentResponse";
import type { ManagedSshAgentConfigurationResponse } from "#bindings/ManagedSshAgentConfigurationResponse";
import type { UpdateSshAgentResponse } from "#bindings/UpdateSshAgentResponse";
import type { UpdateSshAgentRequest } from "#bindings/UpdateSshAgentRequest";
import type { SshHostKeyResponse } from "#bindings/SshHostKeyResponse";
import type { EnrollSshKeyRequest } from "#bindings/EnrollSshKeyRequest";
import type { SshKeyEnrollmentResponse } from "#bindings/SshKeyEnrollmentResponse";
import type { SshKeyRemovalResponse } from "#bindings/SshKeyRemovalResponse";
import type { PinSshHostKeyRequest } from "#bindings/PinSshHostKeyRequest";
import type { SshHostKeyPinResponse } from "#bindings/SshHostKeyPinResponse";
import type { SshKeyStatusResponse } from "#bindings/SshKeyStatusResponse";
import type { RemoveSshKeyRequest } from "#bindings/RemoveSshKeyRequest";
import type { RewrapSshKeyRequest } from "#bindings/RewrapSshKeyRequest";
import type { VaultSshKeysResponse } from "#bindings/VaultSshKeysResponse";
import type { StartAgentRequest } from "#bindings/StartAgentRequest";
import type { DeleteSshAgentRequest } from "#bindings/DeleteSshAgentRequest";
import type { CreateLocalAgentRequest } from "#bindings/CreateLocalAgentRequest";
import type { CreateLocalAgentResponse } from "#bindings/CreateLocalAgentResponse";
import type { ManagedLocalAgentConfigurationResponse } from "#bindings/ManagedLocalAgentConfigurationResponse";
import type { UpdateLocalAgentResponse } from "#bindings/UpdateLocalAgentResponse";
import type { UpdateLocalAgentRequest } from "#bindings/UpdateLocalAgentRequest";
import type { DeleteManagedAgentResponse } from "#bindings/DeleteManagedAgentResponse";
import type { UpdateUserStateRequest } from "#bindings/UpdateUserStateRequest";
import type { EditorBufferResponse } from "#bindings/EditorBufferResponse";
import type { PutEditorBufferRequest } from "#bindings/PutEditorBufferRequest";
import type { PutEditorBufferResponse } from "#bindings/PutEditorBufferResponse";
import type { DeleteEditorBufferResponse } from "#bindings/DeleteEditorBufferResponse";
import type { UserStateResponse } from "#bindings/UserStateResponse";
import type { GitContextResponse } from "#bindings/GitContextResponse";
import type { GitStatusResponse } from "#bindings/GitStatusResponse";
import type { GitDirectoryEntriesResponse } from "#bindings/GitDirectoryEntriesResponse";
import type { GitFileBasesResponse } from "#bindings/GitFileBasesResponse";
import type { GitDiffResponse } from "#bindings/GitDiffResponse";
import type { GitDiffRequest } from "#bindings/GitDiffRequest";
import type { GitDiffMode } from "#bindings/GitDiffMode";
import type { GitRevisionTreeResponse } from "#bindings/GitRevisionTreeResponse";
import type { GitRevisionContentResponse } from "#bindings/GitRevisionContentResponse";
import type { GitCommitDiffResponse } from "#bindings/GitCommitDiffResponse";
import type { GitCommitNeighborsResponse } from "#bindings/GitCommitNeighborsResponse";
import type { GitLogResponse } from "#bindings/GitLogResponse";
import type { GitRefListResponse } from "#bindings/GitRefListResponse";
import type { GitBranchScope } from "#bindings/GitBranchScope";
import type { GitRefSort } from "#bindings/GitRefSort";
import type { GitWorktreeListResponse } from "#bindings/GitWorktreeListResponse";
import type { GitWorktreeStatusRequest } from "#bindings/GitWorktreeStatusRequest";
import type { GitWorktreeStatusResponse } from "#bindings/GitWorktreeStatusResponse";
import type { DirectorySizeResponse } from "#bindings/DirectorySizeResponse";
import type { AgentAccountsResponse } from "#bindings/AgentAccountsResponse";
import type { ChownPathRequest } from "#bindings/ChownPathRequest";
import type { ChownPathResponse } from "#bindings/ChownPathResponse";
import type { ChmodPathRequest } from "#bindings/ChmodPathRequest";
import type { ChmodPathResponse } from "#bindings/ChmodPathResponse";
import type { Level } from "#bindings/Level";
import type { LoggingLevelRequest } from "#bindings/LoggingLevelRequest";
import type { LoggingLevelResponse } from "#bindings/LoggingLevelResponse";
import type { AccessTokenListResponse } from "#bindings/AccessTokenListResponse";
import type { AccessTokenResponse } from "#bindings/AccessTokenResponse";
import type { AccessTokenSecretResponse } from "#bindings/AccessTokenSecretResponse";
import type { CreateAccessTokenRequest } from "#bindings/CreateAccessTokenRequest";
import type { DeleteAccessTokenResponse } from "#bindings/DeleteAccessTokenResponse";
import type { UpdateAccessTokenRequest } from "#bindings/UpdateAccessTokenRequest";
import type { VaultStatusResponse } from "#bindings/VaultStatusResponse";
import type { VaultUnlockMaterialResponse } from "#bindings/VaultUnlockMaterialResponse";
import type { CreateVaultRequest } from "#bindings/CreateVaultRequest";
import type { UpdateVaultRequest } from "#bindings/UpdateVaultRequest";
import type { AddVaultSlotRequest } from "#bindings/AddVaultSlotRequest";
import type { RenameVaultSlotRequest } from "#bindings/RenameVaultSlotRequest";
import type { VaultProof } from "#bindings/VaultProof";
import type { VaultSlotUsedResponse } from "#bindings/VaultSlotUsedResponse";
import type { RotateVaultRequest } from "#bindings/RotateVaultRequest";
import type { DestroyVaultKeyRequest } from "#bindings/DestroyVaultKeyRequest";
import type { VaultDocument } from "#bindings/VaultDocument";
import type { RestoreVaultBackupRequest } from "#bindings/RestoreVaultBackupRequest";
import type { VaultFileHeaderResponse } from "#bindings/VaultFileHeaderResponse";
import type { VaultFileWriteResponse } from "#bindings/VaultFileWriteResponse";
import type { VaultKeyWrap } from "#bindings/VaultKeyWrap";
import type { RewrapVaultFileRequest } from "#bindings/RewrapVaultFileRequest";
import type { ReencryptVaultFileRequest } from "#bindings/ReencryptVaultFileRequest";
import {
    apiRequest,
    authenticationHeaders,
    requireSuccessfulResponse,
    withAuthentication,
    type RequestContext,
} from "#ui/api-transport";
import * as apiPaths from "#ui/api-paths";
import type { LsResponse } from "#ui/ls-response";

const { appendFilesystemPath, encodeFilesystemPath } = apiPaths;

/** Carries a file key on `fetch` requests, so keys never appear in URLs or logs. */
export const VAULT_KEY_HEADER = "Redoor-Vault-Key";

/** The revision a vault read returns and a save sends back. */
export const VAULT_REVISION_HEADER = "Redoor-Vault-Revision";

/** The key material of one encrypted write. */
export type VaultWriteKeys = {
    /** The new file key, base64url. */
    fileKey: string;
    /** The current generation, which wraps the file key. */
    keyId: string;
    wrap: VaultKeyWrap;
};

/** Headers of an encrypted write. */
function vaultWriteHeaders(keys: VaultWriteKeys) {
    return {
        "Content-Type": "application/octet-stream",
        [VAULT_KEY_HEADER]: keys.fileKey,
        "Redoor-Vault-Key-Id": keys.keyId,
        "Redoor-Vault-Wrap-Iv": keys.wrap.iv,
        "Redoor-Vault-Wrap-Ct": keys.wrap.ct,
    };
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

    /** Builds one agent filesystem REST URL while preserving encoded path separators. */
    private filesystemUrl(route: string, path: string): string {
        return `${this.baseUrl}${appendFilesystemPath(
            `/api/v1/agents/${encodeURIComponent(this.info.id)}/${route}`,
            path,
        )}`;
    }

    /** Builds a filesystem route URL that also names the Git revision it reads. */
    private revisionUrl(route: string, path: string, rev: string): string {
        return `${this.filesystemUrl(route, path)}?${new URLSearchParams({ rev }).toString()}`;
    }

    /** Builds a filesystem route URL with optional query values, leaving unset ones out. */
    private filesystemQueryUrl(
        route: string,
        path: string,
        query: Record<string, string | number | null>,
    ): string {
        const params = new URLSearchParams();

        for (const [key, value] of Object.entries(query)) {
            if (value !== null) {
                params.set(key, String(value));
            }
        }

        return `${this.filesystemUrl(route, path)}?${params.toString()}`;
    }

    /** Posts JSON to an agent route without repeating content-type boilerplate. */
    private postJson<T, B>(url: string, body: B): Promise<T> {
        return apiRequest<T>(
            url,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            },
            this.requestContext,
        );
    }

    /** Returns authentication headers for lower-level streaming tests and integrations. */
    getAuthHeaders(): Record<string, string> {
        return authenticationHeaders(this.requestContext);
    }

    /** Reads the threshold from the connected agent over its connection. */
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

    /**
     * The opaque device id that never changes, used for every request, cache key and stored
     * reference so a rename cannot point them at another device.
     */
    get id(): string {
        return this.info.id;
    }

    /** The editable name shown to people and used in UI URLs; never stored as a reference. */
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

    /** Indicates whether this connection checks write preconditions, which vault writes need. */
    get supportsUploadPreconditions(): boolean {
        return this.info.supports_upload_preconditions;
    }

    /** Indicates whether this connection can move entries to its platform trash. */
    get supportsMoveToTrash(): boolean {
        return this.info.supports_move_to_trash || this.info.supports_trash;
    }

    /** Effective UID from registration; null until first connect. */
    get uid(): number | null {
        return this.info.uid;
    }

    /** Whether the latest session's effective UID is root. */
    get isRoot(): boolean {
        return this.info.is_root;
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

    /** Identifies the current agent connection so process restarts can await a replacement. */
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

    /**
     * Set while several machines are using this device's id, so the UI can explain why one
     * of them is refused and how to give the clone its own id.
     */
    get duplicateId(): DuplicateIdWarning | null {
        return this.info.duplicate_id;
    }

    /** Returns binary identity from the latest registration, if any. */
    get binary(): BinaryIdentity | null {
        return this.info.binary;
    }

    /** Reports whether this session can launch paths in its graphical desktop. */
    get supportsNativeOpen(): boolean {
        return this.info.supports_native_open;
    }

    /**
     * Requests desired-running without waiting for process preparation or registration. A
     * device whose SSH key is encrypted with the vault needs the key's file key in `request`
     * unless the server still holds the key from an earlier start.
     */
    async start(request?: StartAgentRequest): Promise<StartAgentResponse> {
        return apiRequest(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/start`,
            request === undefined
                ? { method: "POST" }
                : {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(request),
                  },
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
            this.filesystemUrl("open", path),
            { method: "POST" },
            this.requestContext,
        );
    }

    async ls(path: string): Promise<LsResponse> {
        return apiRequest<LsResponse>(
            this.filesystemUrl("ls", path),
            undefined,
            this.requestContext,
        );
    }

    /** Discovers repository availability and classifies one browser path. */
    async gitContext(path: string): Promise<GitContextResponse> {
        return apiRequest<GitContextResponse>(
            this.filesystemUrl("git/context", path),
            undefined,
            this.requestContext,
        );
    }

    /**
     * Returns bounded repository status below one literal directory path. The signal lets a
     * caller that leaves stop the agent's walk.
     */
    async gitStatus(
        path: string,
        options: { signal?: AbortSignal } = {},
    ): Promise<GitStatusResponse> {
        return apiRequest<GitStatusResponse>(
            this.filesystemUrl("git/status", path),
            { signal: options.signal },
            this.requestContext,
        );
    }

    /**
     * Reads the Git state of each entry of one directory for the file list's status column.
     * Separate from the listing because the status walk can take much longer than listing,
     * and the signal lets leaving the directory stop the walk on the agent.
     */
    async gitDirectoryEntries(
        path: string,
        options: { signal?: AbortSignal } = {},
    ): Promise<GitDirectoryEntriesResponse> {
        return apiRequest<GitDirectoryEntriesResponse>(
            this.filesystemUrl("git/entries", path),
            { signal: options.signal },
            this.requestContext,
        );
    }

    /**
     * Reads the committed and staged text of one file for the editor's Git gutter, which
     * compares them with its buffer. Separate from the file content so opening a file never
     * waits for Git, and the signal lets leaving the file stop the read on the agent.
     */
    async gitFileBases(
        path: string,
        options: { signal?: AbortSignal } = {},
    ): Promise<GitFileBasesResponse> {
        return apiRequest<GitFileBasesResponse>(
            this.filesystemUrl("git/file-bases", path),
            { signal: options.signal },
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

    /** Describes a path as committed at a revision: a tree listing or a file's facts. */
    async gitRevisionTree(
        path: string,
        rev: string,
    ): Promise<GitRevisionTreeResponse> {
        return apiRequest<GitRevisionTreeResponse>(
            this.revisionUrl("git/tree", path, rev),
            undefined,
            this.requestContext,
        );
    }

    /** Reads a committed text file for the read-only editor. */
    async gitRevisionContent(
        path: string,
        rev: string,
    ): Promise<GitRevisionContentResponse> {
        return apiRequest<GitRevisionContentResponse>(
            this.revisionUrl("git/blob", path, rev),
            undefined,
            this.requestContext,
        );
    }

    /**
     * Lists one page of the commits that changed a path, newest first. Without a revision
     * the history starts at HEAD.
     */
    async gitLog(
        path: string,
        options: { rev: string | null; skip: number; limit: number },
    ): Promise<GitLogResponse> {
        return apiRequest<GitLogResponse>(
            this.filesystemQueryUrl("git/log", path, options),
            undefined,
            this.requestContext,
        );
    }

    /**
     * Lists one page of the repository's branches or tags, most recently committed first or by
     * name. `scope` narrows branches to local or remote-tracking ones; without it both are
     * listed, and tags ignore it.
     */
    async gitRefs(
        path: string,
        kind: "branches" | "tags",
        options: {
            sort: GitRefSort;
            scope?: GitBranchScope;
            skip: number;
            limit: number;
        },
    ): Promise<GitRefListResponse> {
        return apiRequest<GitRefListResponse>(
            this.filesystemQueryUrl(`git/${kind}`, path, {
                ...options,
                scope: options.scope ?? null,
            }),
            undefined,
            this.requestContext,
        );
    }

    /**
     * Lists the main and linked worktrees of the repository containing a path, main first
     * and then the most recently active, with each one's branch and HEAD commit.
     */
    async gitWorktrees(path: string): Promise<GitWorktreeListResponse> {
        return apiRequest<GitWorktreeListResponse>(
            this.filesystemUrl("git/worktrees", path),
            undefined,
            this.requestContext,
        );
    }

    /**
     * Counts the uncommitted changes of the checkouts containing the paths in one request.
     * Separate from the worktree list because it walks every file of each checkout, and the
     * agent answers within a few seconds with the checkouts it managed to count, so a path
     * missing from the response has to be asked for again.
     */
    async gitWorktreeStatus(
        paths: string[],
        options: { signal?: AbortSignal } = {},
    ): Promise<GitWorktreeStatusResponse> {
        const request: GitWorktreeStatusRequest = { paths };

        return apiRequest<GitWorktreeStatusResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/git/worktree-status`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
                signal: options.signal,
            },
            this.requestContext,
        );
    }

    /** Shows what the commit a revision names changed below a path. */
    async gitCommitDiff(
        path: string,
        rev: string,
    ): Promise<GitCommitDiffResponse> {
        return apiRequest<GitCommitDiffResponse>(
            this.revisionUrl("git/commit-diff", path, rev),
            undefined,
            this.requestContext,
        );
    }

    /** Finds the commits before and after the one a revision names in a path's history. */
    async gitCommitNeighbors(
        path: string,
        rev: string,
    ): Promise<GitCommitNeighborsResponse> {
        return apiRequest<GitCommitNeighborsResponse>(
            this.revisionUrl("git/commit-neighbors", path, rev),
            undefined,
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
            directoriesOnly?: boolean;
            signal?: AbortSignal;
        },
    ): Promise<FileSearchResponse> {
        const request: FindRequest = {
            query,
            timeout: options.timeoutSeconds,
            include_hidden: options.includeHidden,
            respect_gitignore: options.respectGitignore,
            case_sensitivity: options.caseSensitivity ?? "smart",
            directories_only: options.directoriesOnly ?? false,
        };

        return apiRequest<FileSearchResponse>(
            this.filesystemUrl("find", path),
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
            this.filesystemUrl("grep", path),
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
            this.filesystemUrl("metadata", path),
            undefined,
            this.requestContext,
        );
    }

    /** Loads host users and groups only when a root details view needs owner/group selects. */
    async accounts(): Promise<AgentAccountsResponse> {
        return apiRequest<AgentAccountsResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/accounts`,
            undefined,
            this.requestContext,
        );
    }

    /** Changes owner and/or group of one existing path without recursing. */
    async chown(
        path: string,
        request: Partial<ChownPathRequest>,
    ): Promise<ChownPathResponse> {
        const url = apiPaths.appendOwnerAndGroup(
            new URL(this.filesystemUrl("chown", path)),
            request,
        );

        return apiRequest<ChownPathResponse>(
            url.toString(),
            { method: "POST" },
            this.requestContext,
        );
    }

    /** Replaces the ordinary rwx bits of one existing path without recursing. */
    async chmod(path: string, permissions: number): Promise<ChmodPathResponse> {
        return this.postJson(this.filesystemUrl("chmod", path), {
            permissions,
        } satisfies ChmodPathRequest);
    }

    /** Calculates recursive regular-file bytes only when directory details request it. */
    async calculateDirectorySize(path: string): Promise<DirectorySizeResponse> {
        return apiRequest<DirectorySizeResponse>(
            this.filesystemUrl("directory-size", path),
            { method: "POST" },
            this.requestContext,
        );
    }

    /** Creates an anonymous download credential only after an explicit sharing action. */
    async createOneTimeToken(
        path: string,
    ): Promise<CreateOneTimeTokenResponse> {
        return apiRequest<CreateOneTimeTokenResponse>(
            this.filesystemUrl("one-time-token", path),
            { method: "POST" },
            this.requestContext,
        );
    }

    /** Reads an encrypted file's plaintext header and revision; works while the vault is locked. */
    async vaultHeader(path: string): Promise<VaultFileHeaderResponse> {
        return apiRequest<VaultFileHeaderResponse>(
            this.filesystemUrl("vault/header", path),
            undefined,
            this.requestContext,
        );
    }

    /**
     * Reads an encrypted file's decrypted content. The file key travels in a header, never in the
     * URL. Returns the streamed response and the revision a later save must name.
     */
    async vaultRead(
        path: string,
        fileKey: string,
    ): Promise<{ response: Response; revision: string }> {
        const response = await fetch(
            this.filesystemUrl("vault/read", path),
            withAuthentication(
                {
                    method: "POST",
                    headers: { [VAULT_KEY_HEADER]: fileKey },
                    cache: "no-store",
                },
                this.requestContext,
            ),
        );

        await requireSuccessfulResponse(response, this.requestContext);

        return {
            response,
            revision: response.headers.get(VAULT_REVISION_HEADER) ?? "",
        };
    }

    /** Saves plaintext encrypted over the version the editor read. */
    async vaultSave(
        path: string,
        save: { content: Blob; keys: VaultWriteKeys; expectedRevision: string },
    ): Promise<VaultFileWriteResponse> {
        return apiRequest<VaultFileWriteResponse>(
            this.filesystemUrl("vault/edit", path),
            {
                method: "PUT",
                headers: {
                    ...vaultWriteHeaders(save.keys),
                    [VAULT_REVISION_HEADER]: save.expectedRevision,
                },
                body: save.content,
            },
            this.requestContext,
        );
    }

    /** Uploads content encrypted; also creates new encrypted files. */
    async vaultUpload(
        path: string,
        upload: {
            content: Blob;
            keys: VaultWriteKeys;
            on_existing?: CopyExistingMode;
            uploadRequestId?: string;
        },
    ): Promise<VaultFileWriteResponse> {
        const url = new URL(this.filesystemUrl("vault/raw", path));

        if (upload.on_existing != null) {
            url.searchParams.set("on_existing", upload.on_existing);
        }

        const headers = new Headers(vaultWriteHeaders(upload.keys));

        if (upload.uploadRequestId) {
            headers.set("X-Redoor-Upload-Request", upload.uploadRequestId);
        }

        return apiRequest<VaultFileWriteResponse>(
            url.toString(),
            { method: "PUT", headers, body: upload.content },
            this.requestContext,
        );
    }

    /** Moves an encrypted file to the current key generation without touching its content. */
    async vaultRewrap(
        path: string,
        request: RewrapVaultFileRequest,
    ): Promise<VaultFileWriteResponse> {
        return this.postJson(this.filesystemUrl("vault/rewrap", path), request);
    }

    /** Encrypts a file again with a new file key. */
    async vaultReencrypt(
        path: string,
        request: ReencryptVaultFileRequest,
    ): Promise<VaultFileWriteResponse> {
        return this.postJson(
            this.filesystemUrl("vault/reencrypt", path),
            request,
        );
    }

    /** The form action of a decrypted download, which takes the path in its body. */
    getVaultDownloadUrl(): string {
        return `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/vault/download`;
    }

    getRawUrl(path: string, options?: { download?: boolean }): string {
        let url = this.filesystemUrl("raw", path);

        if (options?.download) {
            url += "?download=1";
        }

        return url;
    }

    /**
     * Builds the download URL of a path as committed at a revision: a file's bytes, or a
     * directory as a .tar.gz. Pass the resolved commit id so the download cannot follow a
     * branch that moved after the page loaded.
     */
    getGitDownloadUrl(path: string, rev: string): string {
        return this.revisionUrl("git/download", path, rev);
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

    /**
     * Starts a shell on this device that lives on the server until its tab is closed, so a
     * reload or a network change can attach to it again.
     */
    async createTerminalSession(
        request: CreateTerminalSessionRequest,
    ): Promise<CreateTerminalSessionResponse> {
        if (!request.cwd.startsWith("/")) {
            throw new Error("Filesystem path must be absolute");
        }

        return this.postJson<
            CreateTerminalSessionResponse,
            CreateTerminalSessionRequest
        >(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/terminals`,
            request,
        );
    }

    async upload(
        path: string,
        file: File,
        options?: Partial<CreationOwnershipOptions> & {
            on_existing?: CopyExistingMode;
        },
    ): Promise<RawUploadResponse> {
        const url = apiPaths.appendOwnershipOptions(
            new URL(this.getRawUrl(path), this.baseUrl),
            options,
        );

        if (options?.on_existing != null) {
            url.searchParams.set("on_existing", options.on_existing);
        }

        return apiRequest<RawUploadResponse>(
            url.toString(),
            {
                method: "PUT",
                headers: {
                    "Content-Type": file.type || "application/octet-stream",
                },
                body: file,
            },
            this.requestContext,
        );
    }

    /** Rewrites one existing file inode through the dedicated editor endpoint. */
    async editFile(path: string, file: File): Promise<FileEditResponse> {
        return apiRequest<FileEditResponse>(
            this.filesystemUrl("edit", path),
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
        return this.postJson(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/trash/restore`,
            request,
        );
    }

    async createDirectory(
        path: string,
        ownership?: Partial<CreationOwnershipOptions>,
    ): Promise<CreateDirectoryResponse> {
        const url = apiPaths.appendOwnershipOptions(
            new URL(this.filesystemUrl("mkdir", path)),
            ownership,
        );

        const response = await fetch(
            url,
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

        return this.postJson(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(this.info.id)}/rename`,
            { dir, old: oldName, new: newName } satisfies RenamePathRequest,
        );
    }

    async copyTo(
        destination: CopyEndpoint,
        sourcePath: string,
        options?: {
            on_existing?: CopyExistingMode;
            resume?: ResumeMode;
            /** Copies the source as committed at this Git revision instead of the worktree. */
            sourceRev?: string;
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
            resume: options?.resume ?? "auto",
            source_rev: options?.sourceRev ?? null,
        };

        return apiRequest<CopyFileResponse>(
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
    }

    /** Starts a smart move that deletes the source only after destination publication. */
    async moveTo(
        destination: CopyEndpoint,
        sourcePath: string,
        options?: { on_existing?: CopyExistingMode; resume?: ResumeMode },
    ): Promise<MoveFileResponse> {
        encodeFilesystemPath(sourcePath);
        encodeFilesystemPath(destination.path);

        const request: MoveFileRequest = {
            source: { agent: this.info.id, path: sourcePath },
            dest: destination,
            on_existing: options?.on_existing ?? "error",
            resume: options?.resume ?? "auto",
        };

        return apiRequest<MoveFileResponse>(
            `${this.baseUrl}/api/v1/move`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext,
        );
    }

    async download(
        path: string,
        options?: {
            range?: [number | null, number | null];
            download?: boolean;
        },
    ): Promise<Response> {
        const url = this.getRawUrl(path, {
            download: options?.download,
        });

        const fetchOptions: RequestInit = {};

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
    private accessToken: string | null = null;
    private unauthorizedHandler: (() => void) | undefined;
    private agentClients = new WeakMap<AgentInfoResponse, Agent>();

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    /** Installs navigation behavior after the router exists, avoiding an API-to-router dependency. */
    setUnauthorizedHandler(handler: () => void): void {
        this.unauthorizedHandler = handler;
    }

    /** Returns authentication headers for direct streaming requests outside this wrapper. */
    getAuthHeaders(): Record<string, string> {
        return authenticationHeaders(this.requestContext());
    }

    /**
     * Authenticates later requests with an access token instead of a session, which is how
     * Node-based scripts and the integration tests act as the remote CLI or an MCP client.
     */
    setAccessToken(token: string | null): void {
        this.accessToken = token;
    }

    /** Shares current credentials and expiry handling with agents created by this client. */
    private requestContext(): RequestContext {
        return {
            getSessionCookie: () => this.sessionCookie,
            getAccessToken: () => this.accessToken,
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

    /** Lists the sign-in methods the public login page should offer. */
    async getLoginMethods(): Promise<LoginMethodsResponse> {
        return apiRequest<LoginMethodsResponse>(
            `${this.baseUrl}/api/v1/auth/methods`,
            undefined,
            this.requestContext(),
        );
    }

    /** Builds the browser navigation target that starts OIDC sign-in and returns to `redirect`. */
    getOidcLoginUrl(redirect: string): string {
        const params = new URLSearchParams({ redirect });

        return `${this.baseUrl}/api/v1/auth/oidc/login?${params.toString()}`;
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

    /**
     * Installs a release over the server binary. Resolves once installed; the server and its
     * local agents restart right after, so callers wait for the replacement process.
     */
    async upgradeServer(
        targetVersion: string | null,
    ): Promise<ServerUpgradeResponse> {
        const request: ServerUpgradeRequest = { target_version: targetVersion };

        return apiRequest<ServerUpgradeResponse>(
            `${this.baseUrl}/api/v1/server/upgrade`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
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

    /**
     * Fetches the plain inventory snapshot that the UI keeps in its query cache. Plain JSON
     * lets TanStack Query structurally share unchanged agents across refetches, which class
     * instances would defeat.
     */
    async listAgentInfos(): Promise<AgentInfoResponse[]> {
        const response = await apiRequest<AgentListResponse>(
            `${this.baseUrl}/api/v1/agents`,
            undefined,
            this.requestContext(),
        );

        return response.agents;
    }

    /**
     * Returns the request client for one inventory snapshot. Memoizing on the snapshot object
     * keeps the client's identity stable for as long as the cache keeps that object, so memos
     * and effects that depend on an agent only rerun when its data really changed.
     */
    agentFor(info: AgentInfoResponse): Agent {
        const existing = this.agentClients.get(info);

        if (existing) {
            return existing;
        }

        const agent = new Agent(this.baseUrl, info, this.requestContext());
        this.agentClients.set(info, agent);

        return agent;
    }

    /** Lists agent request clients for scripts and tests that do not use the query cache. */
    async listAgents(): Promise<Agent[]> {
        const infos = await this.listAgentInfos();

        return infos.map((info) => this.agentFor(info));
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

    /** Probes the host key an SSH device presents, so the user can confirm it before any credential is sent. */
    async getSshHostKey(agentId: string): Promise<SshHostKeyResponse> {
        return apiRequest<SshHostKeyResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/ssh-host-key`,
            undefined,
            this.requestContext(),
        );
    }

    /** Re-pins an SSH device's host key after the user confirmed a change. */
    async pinSshHostKey(
        agentId: string,
        request: PinSshHostKeyRequest,
    ): Promise<SshHostKeyPinResponse> {
        return apiRequest<SshHostKeyPinResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/ssh-host-key/pin`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Sets up, or rotates, the redoor-managed SSH key of an SSH device. */
    async enrollSshKey(
        agentId: string,
        request: EnrollSshKeyRequest,
    ): Promise<SshKeyEnrollmentResponse> {
        return apiRequest<SshKeyEnrollmentResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/ssh-key`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /**
     * Removes the managed SSH key from the device (when reachable) and from the server. An
     * encrypted key needs its file key in `request` to log in, unless the server holds it.
     */
    async removeSshKey(
        agentId: string,
        request?: RemoveSshKeyRequest,
    ): Promise<SshKeyRemovalResponse> {
        return apiRequest<SshKeyRemovalResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/ssh-key`,
            request === undefined
                ? { method: "DELETE" }
                : {
                      method: "DELETE",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(request),
                  },
            this.requestContext(),
        );
    }

    /** Reads how an SSH device's managed key is stored: encrypted, held and its header. */
    async getSshKeyStatus(agentId: string): Promise<SshKeyStatusResponse> {
        return apiRequest<SshKeyStatusResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/ssh-key`,
            undefined,
            this.requestContext(),
        );
    }

    /** Moves an encrypted SSH key to the current vault generation. */
    async rewrapSshKey(
        agentId: string,
        request: RewrapSshKeyRequest,
    ): Promise<SshKeyStatusResponse> {
        return apiRequest<SshKeyStatusResponse>(
            `${this.baseUrl}/api/v1/agents/${encodeURIComponent(agentId)}/ssh-key/rewrap`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Lists the account's SSH keys encrypted with the vault, for rotation. */
    async listVaultSshKeys(): Promise<VaultSshKeysResponse> {
        return this.vaultRequest("/ssh-keys", "GET");
    }

    /** Replaces one stopped SSH-backed managed-agent configuration. */
    async updateSshAgent(
        agentId: string,
        request: UpdateSshAgentRequest,
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
        request: UpdateLocalAgentRequest,
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

    /**
     * Deletes through the collection that owns the managed-agent kind. An SSH device with an
     * encrypted key may send the key's file key, so its line is removed from the device.
     */
    async deleteManagedAgent(
        agentId: string,
        kind: "ssh" | "local",
        request?: DeleteSshAgentRequest,
    ): Promise<DeleteManagedAgentResponse> {
        const collection = kind === "local" ? "local-agents" : "agents";

        return apiRequest<DeleteManagedAgentResponse>(
            `${this.baseUrl}/api/v1/${collection}/${encodeURIComponent(agentId)}`,
            request === undefined
                ? { method: "DELETE" }
                : {
                      method: "DELETE",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(request),
                  },
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

    /** Discovers durable partials from the currently connected destination agents. */
    async listPartials(): Promise<PartialsResponse> {
        return apiRequest<PartialsResponse>(
            `${this.baseUrl}/api/v1/partials`,
            undefined,
            this.requestContext(),
        );
    }

    /** Checks metadata without making the dialog wait for prefix hashing. */
    async copyPreflight(
        request: CopyPreflightRequest,
    ): Promise<CopyPreflightResponse> {
        return apiRequest<CopyPreflightResponse>(
            `${this.baseUrl}/api/v1/copy/preflight`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Waits until the destination confirms the partial is durable. */
    async pauseTransfer(transferId: number): Promise<PauseTransferResponse> {
        return apiRequest<PauseTransferResponse>(
            `${this.baseUrl}/api/v1/transfers/${transferId}/pause`,
            { method: "POST" },
            this.requestContext(),
        );
    }

    /** An opaque manifest key creates a fresh transfer using signed endpoints. */
    async resumePartial(
        request: PartialActionRequest,
    ): Promise<ResumePartialResponse> {
        return apiRequest<ResumePartialResponse>(
            `${this.baseUrl}/api/v1/partials/resume`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Deletes agent-owned output after the user chooses to abandon it. */
    async discardPartial(
        request: PartialActionRequest,
    ): Promise<DiscardPartialResponse> {
        return apiRequest<DiscardPartialResponse>(
            `${this.baseUrl}/api/v1/partials/discard`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    async cancelTransfer(transferId: number): Promise<CancelTransferResponse> {
        return apiRequest<CancelTransferResponse>(
            `${this.baseUrl}/api/v1/transfers/${encodeURIComponent(String(transferId))}`,
            { method: "DELETE" },
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

    /** Lists recent agent connections refused because they speak another protocol version. */
    async listProtocolMismatches(): Promise<ProtocolMismatchListResponse> {
        return apiRequest<ProtocolMismatchListResponse>(
            `${this.baseUrl}/api/v1/protocol-mismatches`,
            undefined,
            this.requestContext(),
        );
    }

    /** Lists secret-free metadata of every access token. */
    async listAccessTokens(): Promise<AccessTokenListResponse> {
        return apiRequest<AccessTokenListResponse>(
            `${this.baseUrl}/api/v1/tokens`,
            undefined,
            this.requestContext(),
        );
    }

    /** Mints an access token; the returned secret is never retained by this client. */
    async createAccessToken(
        request: CreateAccessTokenRequest,
    ): Promise<AccessTokenSecretResponse> {
        return apiRequest<AccessTokenSecretResponse>(
            `${this.baseUrl}/api/v1/tokens`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Replaces a token's policy while its clients keep using the same secret. */
    async updateAccessToken(
        tokenId: string,
        request: UpdateAccessTokenRequest,
    ): Promise<AccessTokenResponse> {
        return apiRequest<AccessTokenResponse>(
            `${this.baseUrl}/api/v1/tokens/${encodeURIComponent(tokenId)}`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Issues a new secret for the same token, invalidating the old one at once. */
    async rotateAccessToken(
        tokenId: string,
    ): Promise<AccessTokenSecretResponse> {
        return apiRequest<AccessTokenSecretResponse>(
            `${this.baseUrl}/api/v1/tokens/${encodeURIComponent(tokenId)}/rotate`,
            { method: "POST" },
            this.requestContext(),
        );
    }

    /** Revokes a token so every later request using it is rejected. */
    async deleteAccessToken(
        tokenId: string,
    ): Promise<DeleteAccessTokenResponse> {
        return apiRequest<DeleteAccessTokenResponse>(
            `${this.baseUrl}/api/v1/tokens/${encodeURIComponent(tokenId)}`,
            { method: "DELETE" },
            this.requestContext(),
        );
    }

    /** Reads the metadata of the access token this client authenticates with. */
    async getCurrentAccessToken(): Promise<AccessTokenResponse> {
        return apiRequest<AccessTokenResponse>(
            `${this.baseUrl}/api/v1/tokens/current`,
            undefined,
            this.requestContext(),
        );
    }

    /** Sends a JSON vault request. */
    private vaultRequest<T, B extends object = object>(
        route: string,
        method: string,
        body?: B,
    ): Promise<T> {
        return apiRequest<T>(
            `${this.baseUrl}/api/v1/vault${route}`,
            body === undefined
                ? { method }
                : {
                      method,
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(body),
                  },
            this.requestContext(),
        );
    }

    /** Reads whether a vault exists, without any wrapped keys. */
    async getVault(): Promise<VaultStatusResponse> {
        return this.vaultRequest("", "GET");
    }

    /** Reads the wrapped keys an unlock needs. */
    async getVaultUnlockMaterial(): Promise<VaultUnlockMaterialResponse> {
        return this.vaultRequest("/unlock-material", "GET");
    }

    /** Creates the vault from keys the browser generated. */
    async createVault(
        request: CreateVaultRequest,
    ): Promise<VaultStatusResponse> {
        return this.vaultRequest("", "POST", request);
    }

    /** Renames the vault. */
    async updateVault(
        request: UpdateVaultRequest,
    ): Promise<VaultStatusResponse> {
        return this.vaultRequest("", "PATCH", request);
    }

    /** Adds a slot wrapping the current key. */
    async addVaultSlot(
        request: AddVaultSlotRequest,
    ): Promise<VaultStatusResponse> {
        return this.vaultRequest("/slots", "POST", request);
    }

    /** Renames a slot. */
    async renameVaultSlot(
        slotId: string,
        request: RenameVaultSlotRequest,
    ): Promise<VaultStatusResponse> {
        return this.vaultRequest(
            `/slots/${encodeURIComponent(slotId)}`,
            "PATCH",
            request,
        );
    }

    /** Removes a slot. */
    async removeVaultSlot(
        slotId: string,
        request: VaultProof,
    ): Promise<VaultStatusResponse> {
        return this.vaultRequest(
            `/slots/${encodeURIComponent(slotId)}`,
            "DELETE",
            request,
        );
    }

    /** Records that a slot unlocked the vault. */
    async markVaultSlotUsed(slotId: string): Promise<VaultSlotUsedResponse> {
        return this.vaultRequest(
            `/slots/${encodeURIComponent(slotId)}/used`,
            "POST",
        );
    }

    /** Replaces the vault key, chain and slots in one step. */
    async rotateVault(
        request: RotateVaultRequest,
    ): Promise<VaultStatusResponse> {
        return this.vaultRequest("/rotate", "POST", request);
    }

    /** Destroys an older key generation. */
    async destroyVaultKey(
        keyId: string,
        request: DestroyVaultKeyRequest,
    ): Promise<VaultStatusResponse> {
        return this.vaultRequest(
            `/keys/${encodeURIComponent(keyId)}/destroy`,
            "POST",
            request,
        );
    }

    /** Reads the backup document. */
    async exportVaultBackup(): Promise<VaultDocument> {
        return this.vaultRequest("/backup", "GET");
    }

    /** The URL that downloads the backup as a file. */
    getVaultBackupUrl(): string {
        return `${this.baseUrl}/api/v1/vault/backup`;
    }

    /** Replaces the vault with a backup. */
    async restoreVaultBackup(
        request: RestoreVaultBackupRequest,
    ): Promise<VaultStatusResponse> {
        return this.vaultRequest("/backup", "PUT", request);
    }

    /** Lists every terminal session of the server, so a reloaded window restores its tabs. */
    async listTerminalSessions(): Promise<TerminalSessionList> {
        return apiRequest<TerminalSessionList>(
            `${this.baseUrl}/api/v1/terminals`,
            undefined,
            this.requestContext(),
        );
    }

    /** Stops a session's shell and forgets it, for a closed tab. */
    async deleteTerminalSession(
        id: string,
    ): Promise<CloseTerminalSessionResponse> {
        return apiRequest<CloseTerminalSessionResponse>(
            `${this.baseUrl}/api/v1/terminals/${encodeURIComponent(id)}`,
            { method: "DELETE" },
            this.requestContext(),
        );
    }

    /** Builds the socket that attaches this window to a session, taking it over. */
    getTerminalSessionWebSocketUrl(id: string, size: TerminalSize): string {
        const url = new URL(
            `/api/v1/terminals/${encodeURIComponent(id)}/ws`,
            this.baseUrl,
        );

        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("rows", String(size.rows));
        url.searchParams.set("cols", String(size.cols));

        return url.toString();
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
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
            },
            this.requestContext(),
        );
    }

    /** Loads the stored editor buffer of one open file; `buffer` is null when none exists. */
    async getEditorBuffer(key: string): Promise<EditorBufferResponse> {
        return apiRequest<EditorBufferResponse>(
            this.editorBufferUrl(key),
            undefined,
            this.requestContext(),
        );
    }

    /**
     * Stores an editor buffer (last writer wins) and returns its new version. `keepalive`
     * lets a small final write outlive a closing page.
     */
    async putEditorBuffer(
        key: string,
        request: PutEditorBufferRequest,
        keepalive = false,
    ): Promise<PutEditorBufferResponse> {
        return apiRequest<PutEditorBufferResponse>(
            this.editorBufferUrl(key),
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
                keepalive,
            },
            this.requestContext(),
        );
    }

    /** Forgets the stored buffer of a file that was closed. */
    async deleteEditorBuffer(key: string): Promise<DeleteEditorBufferResponse> {
        return apiRequest<DeleteEditorBufferResponse>(
            this.editorBufferUrl(key),
            { method: "DELETE" },
            this.requestContext(),
        );
    }

    /**
     * Encodes the key as base64url, so a file path's slashes stay inside one URL segment and
     * no proxy can normalize them away.
     */
    private editorBufferUrl(key: string) {
        let binary = "";

        for (const byte of new TextEncoder().encode(key)) {
            binary += String.fromCharCode(byte);
        }

        const encoded = btoa(binary)
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/, "");

        return `${this.baseUrl}/api/v1/user/editor-buffers/${encoded}`;
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
