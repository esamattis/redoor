import * as React from "react";
import { LoaderCircle, Server, TerminalSquare } from "lucide-react";

import type {
    CreateLocalAgentRequest,
    CreateSshAgentRequest,
    ManagedLocalAgentConfigurationResponse,
    ManagedSshAgentConfigurationResponse,
} from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Password } from "#ui/components/password";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { TextField } from "#ui/components/text-field";
import { Tooltip } from "#ui/components/tooltip";

type FormState = Record<
    | "target"
    | "username"
    | "sshPort"
    | "name"
    | "remoteBin"
    | "home"
    | "log"
    | "password",
    string
>;

/** Distinguishes the two TOML-backed agent kinds the shared form can persist. */
export type ManagedAgentKind = "local" | "ssh";

/** Auth is inferred from password presence because GET never returns the secret itself. */
type SshAuthMode = "key" | "password";

/** Carries the kind-specific GET payload so edit can populate the matching field set. */
export type ManagedAgentFormConfiguration =
    | { kind: "ssh"; value: ManagedSshAgentConfigurationResponse }
    | { kind: "local"; value: ManagedLocalAgentConfigurationResponse };

/** Posts the matching create/update API instead of forcing one request shape. */
export type ManagedAgentSubmitRequest =
    | { kind: "ssh"; request: CreateSshAgentRequest }
    | { kind: "local"; request: CreateLocalAgentRequest };

/** Converts persisted nullable settings into controlled inputs shared by add and edit views. */
function initialForm(configuration?: ManagedAgentFormConfiguration): FormState {
    if (configuration?.kind === "local") {
        return {
            target: "",
            username: "",
            sshPort: "",
            name: configuration.value.name ?? "",
            remoteBin: "",
            home: configuration.value.home ?? "",
            log: configuration.value.log ?? "",
            password: "",
        };
    }
    return {
        target: configuration?.value.target ?? "",
        username: configuration?.value.username ?? "",
        sshPort: configuration?.value.ssh_port?.toString() ?? "",
        name: configuration?.value.name ?? "",
        remoteBin: configuration?.value.remote_bin ?? "",
        home: configuration?.value.home ?? "",
        log: configuration?.value.log ?? "",
        password: "",
    };
}

/** Picks the radio that matches durable state so edit does not imply a password the server never stored. */
function initialAuthMode(
    mode: "add" | "edit",
    configuration?: ManagedAgentFormConfiguration,
): SshAuthMode {
    if (
        mode === "edit" &&
        configuration?.kind === "ssh" &&
        configuration.value.has_password === true
    ) {
        return "password";
    }
    return "key";
}

/** Add defaults to SSH so existing SSH-only flows keep their field set until the operator switches. */
function initialKind(
    configuration?: ManagedAgentFormConfiguration,
): ManagedAgentKind {
    return configuration?.kind ?? "ssh";
}

/** Builds the local POST/PUT body from trimmed optional inputs. */
function localSubmitRequest(form: FormState): ManagedAgentSubmitRequest {
    const optional = (value: string) => value.trim() || null;
    return {
        kind: "local",
        request: {
            name: optional(form.name),
            home: optional(form.home),
            log: optional(form.log),
        },
    };
}

type SshSubmitResult =
    | { ok: true; request: ManagedAgentSubmitRequest }
    | { ok: false; error: string };

/** Validates SSH-only fields and returns the matching request or a form-level error. */
function sshSubmitRequest(
    form: FormState,
    authMode: SshAuthMode,
    hasStoredPassword: boolean,
): SshSubmitResult {
    const optional = (value: string) => value.trim() || null;
    const target = form.target.trim();
    if (!target) {
        return { ok: false, error: "SSH target is required" };
    }
    const sshPort = form.sshPort ? Number(form.sshPort) : null;
    if (
        sshPort !== null &&
        (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65_535)
    ) {
        return { ok: false, error: "SSH port must be between 1 and 65535" };
    }
    if (authMode === "password" && !form.password && !hasStoredPassword) {
        return { ok: false, error: "SSH password is required" };
    }
    return {
        ok: true,
        request: {
            kind: "ssh",
            request: {
                target,
                username: optional(form.username),
                ssh_port: sshPort,
                name: optional(form.name),
                remote_bin: optional(form.remoteBin),
                home: optional(form.home),
                log: optional(form.log),
                password:
                    authMode === "password" ? form.password || null : null,
                clear_password: authMode === "key",
            },
        },
    };
}

/** Collects and validates the SSH or local settings used by both managed-agent workflows. */
export function ManagedAgentForm(props: {
    mode: "add" | "edit";
    configuration?: ManagedAgentFormConfiguration;
    configPath: string;
    isSubmitting: boolean;
    isDisabled?: boolean;
    submitLabel?: string;
    submittingLabel?: string;
    submitDescription?: string;
    submitTooltip?: string;
    mutationError: string | null;
    onSubmit: (request: ManagedAgentSubmitRequest) => void;
    onChange: () => void;
    children?: React.ReactNode;
}) {
    const [form, setForm] = React.useState<FormState>(() =>
        initialForm(props.configuration),
    );
    const [kind, setKind] = React.useState<ManagedAgentKind>(() =>
        initialKind(props.configuration),
    );
    const [authMode, setAuthMode] = React.useState<SshAuthMode>(() =>
        initialAuthMode(props.mode, props.configuration),
    );
    const [validationError, setValidationError] = React.useState<string | null>(
        null,
    );
    const hasStoredPassword =
        props.configuration?.kind === "ssh" &&
        props.configuration.value.has_password === true;

    /** Updates one controlled field and clears stale submission feedback. */
    const update = (field: keyof FormState, value: string) => {
        setForm((current) => ({ ...current, [field]: value }));
        setValidationError(null);
        props.onChange();
    };

    /** Switching kinds on add drops the other field set so a later save cannot mix them. */
    const updateKind = (nextKind: ManagedAgentKind) => {
        setKind(nextKind);
        setValidationError(null);
        props.onChange();
    };

    /** Switching to key mode drops the typed secret so a later password-mode save cannot reuse it. */
    const updateAuthMode = (mode: SshAuthMode) => {
        setAuthMode(mode);
        if (mode === "key") {
            setForm((current) => ({ ...current, password: "" }));
        }
        setValidationError(null);
        props.onChange();
    };

    /** Converts blank optional inputs to null so TOML only receives explicit settings. */
    const submit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (kind === "local") {
            props.onSubmit(localSubmitRequest(form));
            return;
        }
        const result = sshSubmitRequest(form, authMode, hasStoredPassword);
        if (!result.ok) {
            setValidationError(result.error);
            return;
        }
        props.onSubmit(result.request);
    };

    const error = validationError ?? props.mutationError;
    const isEdit = props.mode === "edit";
    const isDisabled = props.isSubmitting || props.isDisabled === true;

    return (
        <div className="min-h-full bg-[#0b0d12] px-4 py-8 sm:px-8">
            <main className="mx-auto max-w-4xl overflow-hidden rounded-xl border border-slate-800 bg-[#11141b]">
                <FormHeader mode={props.mode} kind={kind} />
                <form onSubmit={submit} className="space-y-7 p-6 sm:p-8">
                    {isEdit ? null : (
                        <KindFields
                            kind={kind}
                            disabled={isDisabled}
                            onChange={updateKind}
                        />
                    )}
                    {kind === "local" ? (
                        <LocalFields
                            form={form}
                            disabled={isDisabled}
                            onChange={update}
                        />
                    ) : (
                        <>
                            <ConnectionFields
                                mode={props.mode}
                                form={form}
                                authMode={authMode}
                                hasStoredPassword={hasStoredPassword}
                                disabled={isDisabled}
                                onChange={update}
                                onAuthModeChange={updateAuthMode}
                            />
                            <AdvancedFields
                                form={form}
                                disabled={isDisabled}
                                onChange={update}
                            />
                        </>
                    )}
                    {error ? (
                        <p
                            role="alert"
                            className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                        >
                            {error}
                        </p>
                    ) : null}
                    <FormActions
                        mode={props.mode}
                        kind={kind}
                        configPath={props.configPath}
                        isSubmitting={props.isSubmitting}
                        isDisabled={isDisabled}
                        submitLabel={props.submitLabel}
                        submittingLabel={props.submittingLabel}
                        submitDescription={props.submitDescription}
                        submitTooltip={props.submitTooltip}
                    />
                    {props.children}
                </form>
            </main>
        </div>
    );
}

/** Keeps the shared chrome title aligned with the selected transport. */
function FormHeader(props: { mode: "add" | "edit"; kind: ManagedAgentKind }) {
    return (
        <div className="border-b border-slate-800 px-6 py-6 sm:px-8">
            <div className="flex items-center gap-3">
                <div className="rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300">
                    <Server className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                    <h1 className="text-2xl font-semibold text-slate-100">
                        {props.mode === "edit"
                            ? "Edit managed agent"
                            : "Add managed agent"}
                    </h1>
                    <p className="mt-1 text-sm text-slate-400">
                        {props.kind === "local"
                            ? "Automatically spawn a redoor agent as a local process on this server."
                            : "Automatically provision and spawn redoor agent using SSH."}
                    </p>
                </div>
            </div>
        </div>
    );
}

/** Shares the config-path footer and save action between add and edit. */
function FormActions(props: {
    mode: "add" | "edit";
    kind: ManagedAgentKind;
    configPath: string;
    isSubmitting: boolean;
    isDisabled: boolean;
    submitLabel?: string;
    submittingLabel?: string;
    submitDescription?: string;
    submitTooltip?: string;
}) {
    const isEdit = props.mode === "edit";
    const defaultSubmitTooltip = props.isDisabled
        ? "Wait for the current save or delete to finish"
        : props.kind === "local"
          ? isEdit
              ? "Save the managed local configuration"
              : "Add this local agent to the server configuration"
          : isEdit
            ? "Save the managed SSH configuration"
            : "Add this SSH-backed agent to the server configuration";
    return (
        <div className="flex flex-col gap-4 border-t border-slate-800 pt-6 sm:flex-row sm:items-end sm:justify-between">
            <p className="min-w-0 text-xs text-slate-500">
                Agent configuration will be saved to
                <code className="mt-1 block break-all text-slate-400">
                    {props.configPath}
                </code>
                {props.submitDescription ? (
                    <span className="mt-2 block text-amber-300/80">
                        {props.submitDescription}
                    </span>
                ) : null}
            </p>
            <Tooltip content={props.submitTooltip ?? defaultSubmitTooltip}>
                <Button
                    type="submit"
                    size="lg"
                    disabled={props.isDisabled}
                    isLoading={props.isSubmitting}
                    className="shrink-0 rounded-md px-5 disabled:opacity-60"
                >
                    {props.isSubmitting ? (
                        <LoaderCircle
                            className="h-4 w-4 animate-spin"
                            aria-hidden="true"
                        />
                    ) : null}
                    {props.isSubmitting
                        ? (props.submittingLabel ??
                          (isEdit ? "Saving agent..." : "Adding agent..."))
                        : (props.submitLabel ??
                          (isEdit
                              ? "Save managed agent"
                              : "Add managed agent"))}
                </Button>
            </Tooltip>
        </div>
    );
}

/** Lets add choose transport once so edit never offers SSH↔local conversion. */
function KindFields(props: {
    kind: ManagedAgentKind;
    disabled: boolean;
    onChange: (kind: ManagedAgentKind) => void;
}) {
    return (
        <RadioCardGroup
            legend="Agent type"
            disabled={props.disabled}
            description={
                <p className="text-xs text-slate-500">
                    Local agents run on this server. SSH agents are provisioned
                    on a remote host.
                </p>
            }
            legendClassName="text-sm font-medium text-slate-300"
            optionsClassName="sm:grid-cols-2"
        >
            <RadioCardOption
                name="managed-agent-kind"
                value="ssh"
                label="SSH-backed"
                description="Provision and spawn the agent over SSH using the fields below."
                checked={props.kind === "ssh"}
                layout="compact"
                onChange={() => props.onChange("ssh")}
            />
            <RadioCardOption
                name="managed-agent-kind"
                value="local"
                label="Local process"
                description="Spawn a redoor agent on this server without an SSH target."
                checked={props.kind === "local"}
                layout="compact"
                onChange={() => props.onChange("local")}
            />
        </RadioCardGroup>
    );
}

/** Groups the local TOML fields without exposing SSH-only settings. */
function LocalFields(props: {
    form: FormState;
    disabled: boolean;
    onChange: (field: keyof FormState, value: string) => void;
}) {
    return (
        <section>
            <h2 className="flex items-center gap-2 text-sm font-medium text-slate-300">
                <TerminalSquare className="h-4 w-4" aria-hidden="true" />
                Local agent
            </h2>
            <div className="mt-4 grid gap-5 sm:grid-cols-2">
                <TextField
                    label="Agent name"
                    value={props.form.name}
                    placeholder="Defaults to hostname"
                    description="Name shown in the UI. Defaults to this server's hostname when omitted."
                    autoFocus
                    disabled={props.disabled}
                    onChange={(value) => props.onChange("name", value)}
                />
                <TextField
                    label="Home directory"
                    value={props.form.home}
                    placeholder="Discover from process user"
                    description="Directory opened in the UI. Leave empty to use the process user's home."
                    disabled={props.disabled}
                    onChange={(value) => props.onChange("home", value)}
                />
                <TextField
                    label="Diagnostic log"
                    value={props.form.log}
                    placeholder="Optional local log path"
                    description="Local file for agent stdout and stderr. Leave empty to inherit the server terminal."
                    disabled={props.disabled}
                    onChange={(value) => props.onChange("log", value)}
                />
            </div>
        </section>
    );
}

/** Groups the SSH connection controls without owning form state. */
function ConnectionFields(props: {
    mode: "add" | "edit";
    form: FormState;
    authMode: SshAuthMode;
    hasStoredPassword: boolean;
    disabled: boolean;
    onChange: (field: keyof FormState, value: string) => void;
    onAuthModeChange: (mode: SshAuthMode) => void;
}) {
    const passwordMode = props.authMode === "password";
    const keepExistingPassword =
        props.mode === "edit" && props.hasStoredPassword && passwordMode;
    return (
        <section>
            <h2 className="flex items-center gap-2 text-sm font-medium text-slate-300">
                <TerminalSquare className="h-4 w-4" aria-hidden="true" />
                Connection
            </h2>
            <div className="mt-4 grid gap-5 sm:grid-cols-2">
                <TextField
                    label="SSH target"
                    value={props.form.target}
                    placeholder="host.example.com"
                    description="Host, alias, or user@host accepted by the local OpenSSH client."
                    required
                    autoFocus
                    disabled={props.disabled}
                    onChange={(value) => props.onChange("target", value)}
                />
                <TextField
                    label="Agent name"
                    value={props.form.name}
                    placeholder="Defaults to target hostname"
                    description="Name shown in the UI. Defaults to the target hostname when omitted."
                    disabled={props.disabled}
                    onChange={(value) => props.onChange("name", value)}
                />
                <TextField
                    label="SSH username"
                    value={props.form.username}
                    placeholder="Use SSH config default"
                    description="Passed as ssh -l. Leave empty to use OpenSSH config or user@host."
                    autoComplete="username"
                    disabled={props.disabled}
                    onChange={(value) => props.onChange("username", value)}
                />
                <TextField
                    label="SSH port"
                    value={props.form.sshPort}
                    placeholder="22"
                    description="Leave empty to use the port from OpenSSH config. Not forced to 22."
                    type="number"
                    min={1}
                    max={65_535}
                    disabled={props.disabled}
                    onChange={(value) => props.onChange("sshPort", value)}
                />
                <AuthModeFields
                    authMode={props.authMode}
                    disabled={props.disabled}
                    onChange={props.onAuthModeChange}
                />
                <Password
                    label="SSH password"
                    value={props.form.password}
                    placeholder={
                        keepExistingPassword
                            ? "Leave blank to keep the current password"
                            : passwordMode
                              ? "Enter SSH password"
                              : "Disabled when using a preconfigured SSH key"
                    }
                    description={
                        keepExistingPassword
                            ? "Stored as plaintext in config.toml. Leave blank to keep the current password."
                            : passwordMode
                              ? "Stored as plaintext in config.toml."
                              : "Password input is disabled because key mode uses a preconfigured SSH key or ssh-agent."
                    }
                    autoComplete="current-password"
                    className="sm:col-span-2"
                    required={passwordMode && !props.hasStoredPassword}
                    disabled={props.disabled || !passwordMode}
                    onChange={(value) => props.onChange("password", value)}
                />
            </div>
        </section>
    );
}

/** Keeps the two auth radios in one fieldset so Playwright can select them by accessible name. */
function AuthModeFields(props: {
    authMode: SshAuthMode;
    disabled: boolean;
    onChange: (mode: SshAuthMode) => void;
}) {
    return (
        <RadioCardGroup
            legend="SSH authentication"
            disabled={props.disabled}
            description={
                <p className="text-xs text-slate-500">
                    Password authentication stores the secret as plaintext in
                    config.toml. Key mode uses a preconfigured SSH key or
                    ssh-agent.
                </p>
            }
            className="sm:col-span-2"
            legendClassName="text-sm font-medium text-slate-300"
            optionsClassName="sm:grid-cols-2"
        >
            <RadioCardOption
                name="ssh-auth-mode"
                value="key"
                label="Use preconfigured ssh key"
                description="Authenticate with a preconfigured SSH key or ssh-agent. Saving removes any stored password."
                checked={props.authMode === "key"}
                layout="compact"
                onChange={() => props.onChange("key")}
            />
            <RadioCardOption
                name="ssh-auth-mode"
                value="password"
                label="Use ssh password"
                description="Enable the password field and store the SSH password as plaintext in config.toml."
                checked={props.authMode === "password"}
                layout="compact"
                onChange={() => props.onChange("password")}
            />
        </RadioCardGroup>
    );
}

/** Groups optional remote process settings beneath the primary connection fields. */
function AdvancedFields(props: {
    form: FormState;
    disabled: boolean;
    onChange: (field: keyof FormState, value: string) => void;
}) {
    return (
        <section className="border-t border-slate-800 pt-6">
            <h2 className="text-sm font-medium text-slate-300">
                Advanced
            </h2>
            <div className="mt-4 grid gap-5 sm:grid-cols-2">
                <TextField
                    label="Remote binary"
                    value={props.form.remoteBin}
                    placeholder="Use managed default"
                    description="Path to redoor on the remote host. Leave empty for the managed versioned install."
                    disabled={props.disabled}
                    onChange={(value) => props.onChange("remoteBin", value)}
                />
                <TextField
                    label="Home directory"
                    value={props.form.home}
                    placeholder="Discover from remote user"
                    description="Directory opened in the UI. Leave empty to use the remote user's home."
                    disabled={props.disabled}
                    onChange={(value) => props.onChange("home", value)}
                />
                <TextField
                    label="Diagnostic log"
                    value={props.form.log}
                    placeholder="Optional local log path"
                    description="Local file for SSH stdout and stderr. Leave empty to inherit the server terminal."
                    disabled={props.disabled}
                    onChange={(value) => props.onChange("log", value)}
                />
            </div>
        </section>
    );
}
