import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LoaderCircle, Server, TerminalSquare } from "lucide-react";

import type { CreateSshAgentRequest } from "#ui/api-client";
import { agentsQueryOptions } from "#ui/queries";

export const Route = createFileRoute("/agents/new")({
    component: NewSshAgentPage,
});

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

const initialForm: FormState = {
    target: "",
    username: "",
    sshPort: "",
    name: "",
    remoteBin: "",
    home: "",
    log: "",
    password: "",
};

/** Collects SSH settings without contacting the remote host until the agent is started. */
function NewSshAgentPage() {
    const { api, queryClient } = Route.useRouteContext();
    const router = useRouter();
    const [form, setForm] = React.useState<FormState>(initialForm);
    const [validationError, setValidationError] = React.useState<string | null>(
        null,
    );
    const createMutation = useMutation({
        mutationFn: (request: CreateSshAgentRequest) =>
            api.createSshAgent(request),
        onSuccess: async (response) => {
            await queryClient.invalidateQueries(agentsQueryOptions(api));
            await router.invalidate();
            await router.navigate({
                to: "/agents/$agentId",
                params: { agentId: response.agent.id },
            });
        },
    });

    /** Updates one controlled field and clears stale submission feedback. */
    const update = (field: keyof FormState, value: string) => {
        setForm((current) => ({ ...current, [field]: value }));
        setValidationError(null);
        createMutation.reset();
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
        const optional = (value: string) => value.trim() || null;
        createMutation.mutate({
            target,
            username: optional(form.username),
            ssh_port: sshPort,
            name: optional(form.name),
            remote_bin: optional(form.remoteBin),
            home: optional(form.home),
            log: optional(form.log),
            password: form.password || null,
        });
    };

    const mutationError = createMutation.isError
        ? createMutation.error instanceof Error
            ? createMutation.error.message
            : "Failed to add SSH agent"
        : null;
    const error = validationError ?? mutationError;
    const isSubmitting = createMutation.isPending;

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
                                Add SSH agent
                            </h1>
                            <p className="mt-1 text-sm text-slate-400">
                                Save a managed host now. SSH is only opened when
                                you start its tab.
                            </p>
                        </div>
                    </div>
                </div>
                <form onSubmit={submit} className="space-y-7 p-6 sm:p-8">
                    <section>
                        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
                            <TerminalSquare
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                            Connection
                        </h2>
                        <div className="mt-4 grid gap-5 sm:grid-cols-2">
                            <TextField
                                label="SSH target"
                                value={form.target}
                                placeholder="host.example.com"
                                description="Host, alias, or user@host accepted by the local OpenSSH client."
                                required
                                autoFocus
                                disabled={isSubmitting}
                                onChange={(value) => update("target", value)}
                            />
                            <TextField
                                label="Agent name"
                                value={form.name}
                                placeholder="Defaults to target hostname"
                                description="Name shown in the UI. Defaults to the target hostname when omitted."
                                disabled={isSubmitting}
                                onChange={(value) => update("name", value)}
                            />
                            <TextField
                                label="SSH username"
                                value={form.username}
                                placeholder="Use SSH config default"
                                description="Passed as ssh -l. Leave empty to use OpenSSH config or user@host."
                                autoComplete="username"
                                disabled={isSubmitting}
                                onChange={(value) => update("username", value)}
                            />
                            <TextField
                                label="SSH port"
                                value={form.sshPort}
                                placeholder="22"
                                description="Leave empty to use the port from OpenSSH config. Not forced to 22."
                                type="number"
                                min={1}
                                max={65_535}
                                disabled={isSubmitting}
                                onChange={(value) => update("sshPort", value)}
                            />
                            <TextField
                                label="SSH password"
                                value={form.password}
                                placeholder="Leave empty for key auth"
                                description="Stored as plaintext in config.toml. Leave empty to use preconfigured SSH key or ssh-agent authentication."
                                type="password"
                                autoComplete="current-password"
                                className="sm:col-span-2"
                                disabled={isSubmitting}
                                onChange={(value) => update("password", value)}
                            />
                        </div>
                    </section>
                    <section className="border-t border-slate-800 pt-6">
                        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
                            Advanced
                        </h2>
                        <div className="mt-4 grid gap-5 sm:grid-cols-2">
                            <TextField
                                label="Remote binary"
                                value={form.remoteBin}
                                placeholder="Use managed default"
                                description="Path to redoor on the remote host. Leave empty for the managed versioned install."
                                disabled={isSubmitting}
                                onChange={(value) => update("remoteBin", value)}
                            />
                            <TextField
                                label="Home directory"
                                value={form.home}
                                placeholder="Discover from remote user"
                                description="Directory opened in the UI. Leave empty to use the remote user's home."
                                disabled={isSubmitting}
                                onChange={(value) => update("home", value)}
                            />
                            <TextField
                                label="Diagnostic log"
                                value={form.log}
                                placeholder="Optional local log path"
                                description="Local file for SSH stdout and stderr. Leave empty to inherit the server terminal."
                                disabled={isSubmitting}
                                onChange={(value) => update("log", value)}
                            />
                        </div>
                    </section>
                    {error ? (
                        <p
                            role="alert"
                            className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                        >
                            {error}
                        </p>
                    ) : null}
                    <div className="flex justify-end border-t border-slate-800 pt-6">
                        <button
                            type="submit"
                            disabled={isSubmitting}
                            className="flex items-center justify-center gap-2 rounded-md bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {isSubmitting ? (
                                <LoaderCircle
                                    className="h-4 w-4 animate-spin"
                                    aria-hidden="true"
                                />
                            ) : null}
                            {isSubmitting ? "Adding agent..." : "Add SSH agent"}
                        </button>
                    </div>
                </form>
            </main>
        </div>
    );
}

/** Keeps form controls visually and accessibly consistent without hiding labels. */
function TextField(props: {
    label: string;
    value: string;
    placeholder: string;
    description: string;
    required?: boolean;
    autoFocus?: boolean;
    autoComplete?: string;
    type?: React.HTMLInputTypeAttribute;
    min?: number;
    max?: number;
    className?: string;
    disabled: boolean;
    onChange: (value: string) => void;
}) {
    const inputId = React.useId();
    const descriptionId = React.useId();
    return (
        <div className={props.className}>
            <div className="flex items-baseline justify-between gap-3">
                <label
                    htmlFor={inputId}
                    className="text-sm font-medium text-slate-300"
                >
                    {props.label}
                </label>
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    {props.required ? "Required" : "Optional"}
                </span>
            </div>
            <input
                id={inputId}
                value={props.value}
                placeholder={props.placeholder}
                required={props.required}
                aria-required={props.required || undefined}
                aria-describedby={descriptionId}
                autoFocus={props.autoFocus}
                autoComplete={props.autoComplete}
                type={props.type}
                min={props.min}
                max={props.max}
                disabled={props.disabled}
                onChange={(event) => props.onChange(event.target.value)}
                className="mt-2 w-full rounded-md border border-slate-700 bg-[#0b0d12] px-3 py-2 text-slate-100 outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60"
            />
            <p id={descriptionId} className="mt-1.5 text-xs text-slate-500">
                {props.description}
            </p>
        </div>
    );
}
