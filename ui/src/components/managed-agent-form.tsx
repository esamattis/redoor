import * as React from "react";
import { Info, LoaderCircle, Server, TerminalSquare } from "lucide-react";

import type {
    CreateSshAgentRequest,
    ManagedSshAgentConfigurationResponse,
} from "#ui/api-client";
import { Password } from "#ui/components/password";
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

/** Auth is inferred from password presence because GET never returns the secret itself. */
type SshAuthMode = "key" | "password";

/** Converts persisted nullable settings into controlled inputs shared by add and edit views. */
function initialForm(
    configuration?: ManagedSshAgentConfigurationResponse,
): FormState {
    return {
        target: configuration?.target ?? "",
        username: configuration?.username ?? "",
        sshPort: configuration?.ssh_port?.toString() ?? "",
        name: configuration?.name ?? "",
        remoteBin: configuration?.remote_bin ?? "",
        home: configuration?.home ?? "",
        log: configuration?.log ?? "",
        password: "",
    };
}

/** Picks the radio that matches durable state so edit does not imply a password the server never stored. */
function initialAuthMode(
    mode: "add" | "edit",
    configuration?: ManagedSshAgentConfigurationResponse,
): SshAuthMode {
    if (mode === "edit" && configuration?.has_password === true) {
        return "password";
    }
    return "key";
}

/** Collects and validates the SSH-backed settings used by both managed-agent workflows. */
export function ManagedAgentForm(props: {
    mode: "add" | "edit";
    configuration?: ManagedSshAgentConfigurationResponse;
    configPath: string;
    isSubmitting: boolean;
    isDisabled?: boolean;
    submitLabel?: string;
    submittingLabel?: string;
    submitDescription?: string;
    submitTooltip?: string;
    mutationError: string | null;
    onSubmit: (request: CreateSshAgentRequest) => void;
    onChange: () => void;
    children?: React.ReactNode;
}) {
    const [form, setForm] = React.useState<FormState>(() =>
        initialForm(props.configuration),
    );
    const [authMode, setAuthMode] = React.useState<SshAuthMode>(() =>
        initialAuthMode(props.mode, props.configuration),
    );
    const [validationError, setValidationError] = React.useState<string | null>(
        null,
    );
    const hasStoredPassword = props.configuration?.has_password === true;

    /** Updates one controlled field and clears stale submission feedback. */
    const update = (field: keyof FormState, value: string) => {
        setForm((current) => ({ ...current, [field]: value }));
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
        const target = form.target.trim();
        if (!target) {
            setValidationError("SSH target is required");
            return;
        }
        const sshPort = form.sshPort ? Number(form.sshPort) : null;
        if (
            sshPort !== null &&
            (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65_535)
        ) {
            setValidationError("SSH port must be between 1 and 65535");
            return;
        }
        if (authMode === "password" && !form.password && !hasStoredPassword) {
            setValidationError("SSH password is required");
            return;
        }
        const optional = (value: string) => value.trim() || null;
        props.onSubmit({
            target,
            username: optional(form.username),
            ssh_port: sshPort,
            name: optional(form.name),
            remote_bin: optional(form.remoteBin),
            home: optional(form.home),
            log: optional(form.log),
            password: authMode === "password" ? form.password || null : null,
            clear_password: authMode === "key",
        });
    };

    const error = validationError ?? props.mutationError;
    const isEdit = props.mode === "edit";
    const title = isEdit ? "Edit managed agent" : "Add managed agent";
    const isDisabled = props.isSubmitting || props.isDisabled === true;

    return (
        <div className="min-h-full bg-[#0b0d12] px-4 py-8 sm:px-8">
            <main className="mx-auto max-w-4xl overflow-hidden rounded-xl border border-slate-800 bg-[#11141b] shadow-2xl shadow-black/20">
                <div className="border-b border-slate-800 bg-gradient-to-r from-blue-500/10 via-transparent to-transparent px-6 py-6 sm:px-8">
                    <div className="flex items-center gap-3">
                        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-2 text-blue-300">
                            <Server className="h-5 w-5" aria-hidden="true" />
                        </div>
                        <div>
                            <h1 className="text-2xl font-bold text-slate-100">
                                {title}
                            </h1>
                            <p className="mt-1 text-sm text-slate-400">
                                Automatically provision and spawn redoor agent
                                using SSH.
                            </p>
                        </div>
                    </div>
                </div>
                <form onSubmit={submit} className="space-y-7 p-6 sm:p-8">
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
                    {error ? (
                        <p
                            role="alert"
                            className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                        >
                            {error}
                        </p>
                    ) : null}
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
                        <Tooltip
                            content={
                                props.submitTooltip ??
                                (isDisabled
                                    ? "Wait for the current save or delete to finish"
                                    : isEdit
                                      ? "Save the managed SSH configuration"
                                      : "Add this SSH-backed agent to the server configuration")
                            }
                        >
                            <button
                                type="submit"
                                disabled={isDisabled}
                                className="flex shrink-0 items-center justify-center gap-2 rounded-md bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {props.isSubmitting ? (
                                    <LoaderCircle
                                        className="h-4 w-4 animate-spin"
                                        aria-hidden="true"
                                    />
                                ) : null}
                                {props.isSubmitting
                                    ? (props.submittingLabel ??
                                      (isEdit
                                          ? "Saving agent..."
                                          : "Adding agent..."))
                                    : (props.submitLabel ??
                                      (isEdit
                                          ? "Save managed agent"
                                          : "Add managed agent"))}
                            </button>
                        </Tooltip>
                    </div>
                    {props.children}
                </form>
            </main>
        </div>
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
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
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
        <fieldset className="sm:col-span-2 grid gap-3">
            <legend className="text-sm font-medium text-slate-300">
                SSH authentication
            </legend>
            <p className="text-xs text-slate-500">
                Password authentication stores the secret as plaintext in
                config.toml. Key mode uses a preconfigured SSH key or ssh-agent.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
                <AuthModeOption
                    value="key"
                    label="Use preconfigured ssh key"
                    description="Authenticate with a preconfigured SSH key or ssh-agent. Saving removes any stored password."
                    checked={props.authMode === "key"}
                    disabled={props.disabled}
                    onChange={props.onChange}
                />
                <AuthModeOption
                    value="password"
                    label="Use ssh password"
                    description="Enable the password field and store the SSH password as plaintext in config.toml."
                    checked={props.authMode === "password"}
                    disabled={props.disabled}
                    onChange={props.onChange}
                />
            </div>
        </fieldset>
    );
}

/** Renders one native radio plus a tooltip without putting extra text into the accessible name. */
function AuthModeOption(props: {
    value: SshAuthMode;
    label: string;
    description: string;
    checked: boolean;
    disabled: boolean;
    onChange: (mode: SshAuthMode) => void;
}) {
    return (
        <div
            className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 ${
                props.checked
                    ? "border-blue-500/60 bg-blue-500/10 text-blue-100"
                    : "border-slate-700 bg-slate-950/50 text-slate-300"
            }`}
        >
            <label className="flex min-w-0 cursor-pointer items-center gap-3 text-sm font-medium">
                <input
                    type="radio"
                    name="ssh-auth-mode"
                    value={props.value}
                    checked={props.checked}
                    disabled={props.disabled}
                    onChange={() => props.onChange(props.value)}
                    className="h-4 w-4 accent-blue-500"
                />
                {props.label}
            </label>
            <Tooltip content={props.description}>
                <Info
                    aria-label={`${props.label} help`}
                    className="h-4 w-4 shrink-0 text-slate-400"
                />
            </Tooltip>
        </div>
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
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
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
