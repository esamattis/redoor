import * as React from "react";
import { KeyRound, LoaderCircle, Server, TerminalSquare } from "lucide-react";

import type { CreateLocalAgentRequest } from "#bindings/CreateLocalAgentRequest";
import type { CreateSshAgentRequest } from "#bindings/CreateSshAgentRequest";
import type { ManagedLocalAgentConfigurationResponse } from "#bindings/ManagedLocalAgentConfigurationResponse";
import type { ManagedSshAgentConfigurationResponse } from "#bindings/ManagedSshAgentConfigurationResponse";
import { Button } from "#ui/components/button";
import { Checkbox } from "#ui/components/checkbox";
import { Password } from "#ui/components/password";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { TextField } from "#ui/components/text-field";

type FormState = Record<
    | "target"
    | "username"
    | "sshPort"
    | "name"
    | "remoteBin"
    | "home"
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

/**
 * What the page does with the device's dedicated SSH key around the save. Adding a device
 * can enroll a key right after the device exists, with a password that is used once and
 * never part of the saved configuration. An edit that changes the username or target drops
 * the key, so the page can first remove its line from the device while the key still works.
 */
export type SshKeyAction =
    | { action: "none" }
    | { action: "enroll"; password: string | null }
    | { action: "remove-first" };

/** Posts the matching create/update API instead of forcing one request shape. */
export type ManagedAgentSubmitRequest =
    | { kind: "ssh"; request: CreateSshAgentRequest; sshKey: SshKeyAction }
    | { kind: "local"; request: CreateLocalAgentRequest };

/**
 * How an edit affects the dedicated SSH key and the pinned host key. The server drops the
 * key when the username changes (it is installed for one account) and also forgets the pin
 * when the target changes (it may be another machine), so the form warns before saving.
 */
type CredentialEditImpact = {
    dropsKey: boolean;
    dropsPin: boolean;
    targetChanged: boolean;
};

/** Compares the edited connection with the saved one to tell what the save would discard. */
function credentialEditImpact(
    form: FormState,
    configuration: ManagedAgentFormConfiguration | undefined,
): CredentialEditImpact {
    if (configuration?.kind !== "ssh") {
        return {
            dropsKey: false,
            dropsPin: false,
            targetChanged: false,
        };
    }

    const saved = configuration.value;
    const targetChanged = form.target.trim() !== saved.target;
    const usernameChanged = form.username.trim() !== (saved.username ?? "");

    return {
        dropsKey:
            saved.has_managed_ssh_key && (targetChanged || usernameChanged),
        dropsPin: saved.has_pinned_host_key && targetChanged,
        targetChanged,
    };
}

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

/** The device id format (`dev_` and 20 lowercase base32 characters), which names may not take. */
const DEVICE_ID_FORMAT = /^dev_[a-z2-7]{20}$/;

/**
 * Mirrors the server's device name rules so a bad name is explained before the request. A
 * blank name is allowed because the server then uses the hostname. `:` would break the CLI's
 * `device:path` syntax and `/` the device URLs, and a name in the id format would be
 * ambiguous because devices are addressed by name or id. The server still checks every
 * name, so this is only earlier feedback.
 */
function validateDeviceName(name: string): string | null {
    const trimmed = name.trim();

    if (/[:/]/.test(trimmed)) {
        return "Device name must not contain ':' or '/'";
    }

    if (DEVICE_ID_FORMAT.test(trimmed)) {
        return "Device name must not look like a device id ('dev_' followed by 20 base32 characters)";
    }

    return null;
}

/** Builds the local POST/PUT body from trimmed optional inputs. */
function localSubmitRequest(form: FormState): ManagedAgentSubmitRequest {
    const optional = (value: string) => value.trim() || null;

    return {
        kind: "local",
        request: {
            name: optional(form.name),
            home: optional(form.home),
        },
    };
}

type SshSubmitResult =
    { ok: true; request: CreateSshAgentRequest } | { ok: false; error: string };

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
            target,
            username: optional(form.username),
            ssh_port: sshPort,
            name: optional(form.name),
            remote_bin: optional(form.remoteBin),
            home: optional(form.home),
            password: authMode === "password" ? form.password || null : null,
            clear_password: authMode === "key",
        },
    };
}

/**
 * Picks the key action for an SSH save. A device that gets a dedicated key never has its
 * password saved: the typed password only travels with the one enroll request.
 */
function sshKeyAction(args: {
    form: FormState;
    createManagedKey: boolean;
    impact: CredentialEditImpact;
    removeKeyFirst: boolean;
}): SshKeyAction {
    if (args.createManagedKey) {
        return { action: "enroll", password: args.form.password || null };
    }

    if (args.impact.dropsKey && args.removeKeyFirst) {
        return { action: "remove-first" };
    }

    return { action: "none" };
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
    /**
     * Rendered between the header and the form, outside the `<form>`, so a section with
     * its own dialogs and forms (the SSH key actions) cannot submit this one.
     */
    beforeForm?: React.ReactNode;
    children?: React.ReactNode;
}) {
    const [form, setForm] = React.useState<FormState>(() =>
        initialForm(props.configuration),
    );

    const [kind, setKind] = React.useState<ManagedAgentKind>(() =>
        initialKind(props.configuration),
    );

    // Only an explicit choice is kept in state. Until then the mode follows the saved
    // configuration, which the SSH key actions on the same page can change underneath the
    // form (setting up a key removes the stored password).
    const [chosenAuthMode, setChosenAuthMode] =
        React.useState<SshAuthMode | null>(null);

    const authMode =
        chosenAuthMode ?? initialAuthMode(props.mode, props.configuration);

    const [validationError, setValidationError] = React.useState<string | null>(
        null,
    );

    // Added SSH devices get a dedicated key unless the user opts out; edits manage the key
    // from the SSH key section instead, so the option only exists on add.
    const [createManagedKeyOption, setCreateManagedKeyOption] =
        React.useState(true);

    const [removeKeyFirst, setRemoveKeyFirst] = React.useState(true);

    const hasStoredPassword =
        props.configuration?.kind === "ssh" &&
        props.configuration.value.has_password === true;

    const hasManagedKey =
        props.configuration?.kind === "ssh" &&
        props.configuration.value.has_managed_ssh_key;

    const createManagedKey = props.mode === "add" && createManagedKeyOption;
    const impact = credentialEditImpact(form, props.configuration);

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

    /**
     * Toggling the dedicated key drops the typed secret: with the key on it is never saved,
     * with it off it would be saved as plaintext, and neither should happen silently.
     */
    const updateCreateManagedKey = (checked: boolean) => {
        setCreateManagedKeyOption(checked);
        setForm((current) => ({ ...current, password: "" }));
        setValidationError(null);
        props.onChange();
    };

    /** Switching to key mode drops the typed secret so a later password-mode save cannot reuse it. */
    const updateAuthMode = (mode: SshAuthMode) => {
        setChosenAuthMode(mode);

        if (mode === "key") {
            setForm((current) => ({ ...current, password: "" }));
        }

        setValidationError(null);
        props.onChange();
    };

    /** Converts blank optional inputs to null so TOML only receives explicit settings. */
    const submit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const nameError = validateDeviceName(form.name);

        if (nameError !== null) {
            setValidationError(nameError);

            return;
        }

        if (kind === "local") {
            props.onSubmit(localSubmitRequest(form));

            return;
        }

        // A managed key replaces password storage, so the request never carries a password.
        const result = sshSubmitRequest(
            form,
            createManagedKey || hasManagedKey ? "key" : authMode,
            hasStoredPassword,
        );

        if (!result.ok) {
            setValidationError(result.error);

            return;
        }

        props.onSubmit({
            kind: "ssh",
            request: result.request,
            sshKey: sshKeyAction({
                form,
                createManagedKey,
                impact,
                removeKeyFirst,
            }),
        });
    };

    const error = validationError ?? props.mutationError;
    const isEdit = props.mode === "edit";
    const isDisabled = props.isSubmitting || props.isDisabled === true;

    return (
        <div className="min-h-full bg-canvas px-4 py-8 @xl:px-8">
            <main className="mx-auto max-w-4xl overflow-hidden rounded-xl border border-slate-800 bg-surface shadow-2xl shadow-black/20">
                <FormHeader mode={props.mode} kind={kind} />
                {props.beforeForm}
                <form onSubmit={submit} className="space-y-7 p-6 @xl:p-8">
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
                                form={form}
                                disabled={isDisabled}
                                onChange={update}
                            >
                                <SshAuthFields
                                    mode={props.mode}
                                    form={form}
                                    authMode={authMode}
                                    hasStoredPassword={hasStoredPassword}
                                    hasManagedKey={hasManagedKey}
                                    createManagedKey={createManagedKey}
                                    disabled={isDisabled}
                                    onChange={update}
                                    onAuthModeChange={updateAuthMode}
                                    onCreateManagedKeyChange={
                                        updateCreateManagedKey
                                    }
                                />
                            </ConnectionFields>
                            <CredentialEditWarning
                                impact={impact}
                                removeKeyFirst={removeKeyFirst}
                                disabled={isDisabled}
                                onRemoveKeyFirstChange={setRemoveKeyFirst}
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
        <div className="border-b border-slate-800 bg-gradient-to-r from-blue-500/10 via-transparent to-transparent px-6 py-6 @xl:px-8">
            <div className="flex items-center gap-3">
                <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-2 text-blue-300">
                    <Server className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                    <h1 className="text-2xl font-bold text-slate-100">
                        {props.mode === "edit" ? "Edit device" : "Add device"}
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
              : "Add this device to the server configuration with a local agent"
          : isEdit
            ? "Save the managed SSH configuration"
            : "Add this device to the server configuration using SSH";

    return (
        <div className="flex flex-col gap-4 border-t border-slate-800 pt-6 @xl:flex-row @xl:items-end @xl:justify-between">
            <p className="min-w-0 text-xs text-slate-500">
                Device connection settings will be saved to
                <code className="mt-1 block break-all text-slate-400">
                    {props.configPath}
                </code>
                {props.submitDescription ? (
                    <span className="mt-2 block text-amber-300/80">
                        {props.submitDescription}
                    </span>
                ) : null}
            </p>
            <Button
                tooltip={props.submitTooltip ?? defaultSubmitTooltip}
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
                      (isEdit ? "Saving device..." : "Adding device..."))
                    : (props.submitLabel ??
                      (isEdit ? "Save device" : "Add device"))}
            </Button>
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
            legend="Connection type"
            disabled={props.disabled}
            description={
                <p className="text-xs text-slate-500">
                    Local agents run on this server. SSH agents are provisioned
                    on a remote host.
                </p>
            }
            legendClassName="text-sm font-semibold uppercase tracking-wider text-slate-300"
            optionsClassName="@xl:grid-cols-2"
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
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
                <TerminalSquare className="h-4 w-4" aria-hidden="true" />
                Local agent
            </h2>
            <div className="mt-4 grid gap-5 @xl:grid-cols-2">
                <TextField
                    label="Device name"
                    value={props.form.name}
                    placeholder="Defaults to hostname"
                    description="Unique name shown in the UI and device URLs, without : or /. Renaming keeps the device id. Defaults to this server's hostname when omitted."
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
            </div>
        </section>
    );
}

/** Groups the SSH connection controls without owning form state. */
function ConnectionFields(props: {
    form: FormState;
    disabled: boolean;
    onChange: (field: keyof FormState, value: string) => void;
    children: React.ReactNode;
}) {
    return (
        <section>
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
                <TerminalSquare className="h-4 w-4" aria-hidden="true" />
                Connection
            </h2>
            <div className="mt-4 grid gap-5 @xl:grid-cols-2">
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
                    label="Device name"
                    value={props.form.name}
                    placeholder="Defaults to target hostname"
                    description="Unique name shown in the UI and device URLs, without : or /. Renaming keeps the device id. Defaults to the target hostname when omitted."
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
                {props.children}
            </div>
        </section>
    );
}

/**
 * Chooses how the device authenticates. On add the dedicated key is the default and hides
 * the password storage choice, because a device with a managed key never stores a
 * password; turning it off brings back the existing key-or-stored-password choice.
 */
function SshAuthFields(props: {
    mode: "add" | "edit";
    form: FormState;
    authMode: SshAuthMode;
    hasStoredPassword: boolean;
    hasManagedKey: boolean;
    createManagedKey: boolean;
    disabled: boolean;
    onChange: (field: keyof FormState, value: string) => void;
    onAuthModeChange: (mode: SshAuthMode) => void;
    onCreateManagedKeyChange: (checked: boolean) => void;
}) {
    if (props.hasManagedKey) {
        return <ManagedKeyAuthNotice />;
    }

    const passwordMode = props.authMode === "password";

    const keepExistingPassword =
        props.mode === "edit" && props.hasStoredPassword && passwordMode;

    return (
        <>
            {props.mode === "add" ? (
                <ManagedKeyOption
                    checked={props.createManagedKey}
                    disabled={props.disabled}
                    onChange={props.onCreateManagedKeyChange}
                />
            ) : null}
            {props.createManagedKey ? (
                <Password
                    label="SSH password (used once, not saved)"
                    value={props.form.password}
                    placeholder="Leave empty to try this server's SSH keys"
                    description="Used once to install the dedicated key, then discarded. Leave empty when this server can already log in with its own SSH keys or ssh-agent."
                    autoComplete="current-password"
                    className="@xl:col-span-2"
                    required={false}
                    disabled={props.disabled}
                    onChange={(value) => props.onChange("password", value)}
                />
            ) : (
                <>
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
                        className="@xl:col-span-2"
                        required={passwordMode && !props.hasStoredPassword}
                        disabled={props.disabled || !passwordMode}
                        onChange={(value) => props.onChange("password", value)}
                    />
                </>
            )}
        </>
    );
}

/** Offers the dedicated key on add, with the reason it is the recommended choice. */
function ManagedKeyOption(props: {
    checked: boolean;
    disabled: boolean;
    onChange: (checked: boolean) => void;
}) {
    const descriptionId = React.useId();

    return (
        <div className="@xl:col-span-2">
            <Checkbox
                role="checkbox"
                label="Create a dedicated SSH key (recommended)"
                title={false}
                aria-describedby={descriptionId}
                checked={props.checked}
                disabled={props.disabled}
                onCheckedChange={props.onChange}
                className="-ml-1 font-medium text-slate-200"
            >
                Create a dedicated SSH key (recommended)
            </Checkbox>
            <p id={descriptionId} className="mt-1 text-xs text-slate-500">
                After adding the device, Redoor shows its host key for you to
                confirm, then creates a key used only for this device and
                installs it. No password is saved. Turn this off to use this
                server's own SSH keys or a stored password instead.
            </p>
        </div>
    );
}

/** Replaces the password controls while a managed key exists, because the server refuses both. */
function ManagedKeyAuthNotice() {
    return (
        <p className="flex items-start gap-2 rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-300 @xl:col-span-2">
            <KeyRound
                className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400"
                aria-hidden="true"
            />
            <span>
                This device logs in with its dedicated SSH key, so no password
                can be stored for it. Remove the key in the SSH key section to
                use a password or this server&apos;s own SSH keys instead.
            </span>
        </p>
    );
}

/**
 * Warns before an edit discards the dedicated key or the pinned host key, and offers to
 * remove the key's line from the device first, while the key can still log in to remove it.
 */
function CredentialEditWarning(props: {
    impact: CredentialEditImpact;
    removeKeyFirst: boolean;
    disabled: boolean;
    onRemoveKeyFirstChange: (checked: boolean) => void;
}) {
    if (!props.impact.dropsKey && !props.impact.dropsPin) {
        return null;
    }

    const reason = props.impact.targetChanged
        ? "Changing the SSH target"
        : "Changing the SSH username";

    return (
        <div
            role="alert"
            aria-label="SSH key warning"
            className="space-y-2 rounded-md border border-amber-800 bg-amber-950/30 px-3 py-3 text-sm text-amber-300"
        >
            {props.impact.dropsKey ? (
                <p>
                    {reason} removes this device&apos;s dedicated SSH key,
                    because the key is installed only for the current account
                    {props.impact.targetChanged ? " and machine" : ""}. Set up a
                    new key after saving.
                </p>
            ) : null}
            {props.impact.dropsPin ? (
                <p>
                    Changing the SSH target also forgets the pinned host key, so
                    the new target&apos;s host key has to be confirmed again.
                </p>
            ) : null}
            {props.impact.dropsKey ? (
                <Checkbox
                    role="checkbox"
                    label="Remove the key from the device before saving"
                    title={false}
                    checked={props.removeKeyFirst}
                    disabled={props.disabled}
                    onCheckedChange={props.onRemoveKeyFirstChange}
                    className="-ml-1 text-amber-200"
                >
                    Remove the key from the device before saving
                </Checkbox>
            ) : null}
        </div>
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
            className="@xl:col-span-2"
            legendClassName="text-sm font-medium text-slate-300"
            optionsClassName="@xl:grid-cols-2"
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
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
                Advanced
            </h2>
            <div className="mt-4 grid gap-5 @xl:grid-cols-2">
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
            </div>
        </section>
    );
}
