import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
    useMutation,
    useQueryClient,
    useSuspenseQuery,
} from "@tanstack/react-query";
import {
    CalendarClock,
    CircleCheck,
    CircleX,
    Clock,
    Network,
    Server,
    ShieldAlert,
    SquareTerminal,
} from "lucide-react";
import { z } from "zod";

import type { ApproveCliLoginRequest } from "#bindings/ApproveCliLoginRequest";
import type { CliLoginResponse } from "#bindings/CliLoginResponse";
import type { DeviceScope } from "#bindings/DeviceScope";
import { ApiError } from "#ui/api-transport";
import { cliLoginQueryOptions, queryKeys } from "#ui/queries";
import { useAgents } from "#ui/use-agents";
import { useFreshLogin } from "#ui/use-fresh-login";
import {
    AccessTokenPolicyFields,
    buildAccessTokenPolicyDraft,
    expiresAtFor,
    TokenExpiryField,
    type TokenAgents,
    tokenFormSearchSchema,
} from "#ui/components/access-token-policy";
import { Button } from "#ui/components/button";
import { FactItem } from "#ui/components/fact-item";
import { TextField } from "#ui/components/text-field";
import { cn } from "#ui/utils/cn";
import { getErrorMessage } from "#ui/utils/error";

/**
 * The approval form lives in the URL, including the typed code, because approving needs a
 * sign-in from the last minute: the user fills in the form, signs in again, and returns to
 * the same filled-in page to press "Approve" once more. Absent params fall back to what
 * the CLI asked for.
 */
const cliLoginSearchSchema = tokenFormSearchSchema.extend({
    code: z.string().optional().catch(undefined),
});

type CliLoginSearch = z.infer<typeof cliLoginSearchSchema>;

export const Route = createFileRoute("/_app/cli-login/$id")({
    validateSearch: cliLoginSearchSchema,
    loader: async ({ context, params }) => {
        await context.queryClient.ensureQueryData(
            cliLoginQueryOptions(context.api, params.id),
        );
    },
    component: CliLoginPage,
});

/** Symbols in a user code; the CLI shows them as `XXXX-XXXX`. */
const USER_CODE_LENGTH = 8;

/**
 * The code as the server compares it: case and separators do not matter, so a code typed
 * from the terminal in lower case or without the dash still counts.
 */
function normalizeUserCode(value: string): string {
    return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

/** The CLI's requested devices as form defaults, plus the ones this server does not know. */
type RequestedDevices = {
    deviceMode: DeviceScope["kind"];
    deviceIds: string[];
    unknown: string[];
};

/**
 * Resolves the devices the CLI asked for, which it names by id or by name as the user typed
 * them, against the device list. Unknown ones are reported instead of silently dropped, so
 * the user sees that the token will not cover them.
 */
function resolveRequestedDevices(
    scope: DeviceScope,
    agents: TokenAgents,
): RequestedDevices {
    if (scope.kind === "all") {
        return { deviceMode: "all", deviceIds: [], unknown: [] };
    }

    const deviceIds: string[] = [];
    const unknown: string[] = [];

    for (const requested of scope.device_ids) {
        const agent =
            agents.find((item) => item.id === requested) ??
            agents.find((item) => item.name === requested);

        if (agent === undefined) {
            unknown.push(requested);
        } else if (!deviceIds.includes(agent.id)) {
            deviceIds.push(agent.id);
        }
    }

    return { deviceMode: "only", deviceIds, unknown };
}

/** Rough wording for the request's age and remaining time; the minute is precise enough. */
function formatDuration(seconds: number): string {
    if (seconds < 60) {
        return `${Math.max(0, Math.round(seconds))} seconds`;
    }

    const minutes = Math.round(seconds / 60);

    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Where the page stands: the form, or one of the ways the request can be over. */
type Outcome =
    | { kind: "form"; request: CliLoginResponse }
    | { kind: "approved-here" }
    | { kind: "denied-here" }
    | { kind: "approved" }
    | { kind: "denied" }
    | { kind: "gone"; message: string | null };

/** Whether a failure means the request no longer exists, such as after too many wrong codes. */
function isGone(error: Error | null): boolean {
    return error instanceof ApiError && error.status === 404;
}

/** Whether a failure means the request was already approved or denied elsewhere. */
function isAlreadyAnswered(error: Error | null): boolean {
    return error instanceof ApiError && error.status === 409;
}

/**
 * Lets the user approve a `redoor remote login` in the browser, where the fresh sign-in
 * happens, and pick the token's access. The CLI only suggests the token; this page decides.
 */
function CliLoginPage() {
    const { api } = Route.useRouteContext();
    const { id } = Route.useParams();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const queryClient = useQueryClient();
    const agents = useAgents();
    const freshLogin = useFreshLogin();
    const request = useSuspenseQuery(cliLoginQueryOptions(api, id)).data;

    /** Re-reads the request after a conflict, so the page shows how it was answered. */
    const refreshRequest = () =>
        queryClient.invalidateQueries({ queryKey: queryKeys.cliLogin(id) });

    const approve = useMutation({
        mutationFn: (body: ApproveCliLoginRequest) =>
            freshLogin.run(() => api.approveCliLogin(id, body)),
        onSuccess: async (result) => {
            if (result === null) return;

            await queryClient.invalidateQueries({
                queryKey: queryKeys.accessTokens(),
            });
        },
        onError: async (error) => {
            if (isAlreadyAnswered(error)) await refreshRequest();
        },
    });

    const deny = useMutation({
        mutationFn: () => api.denyCliLogin(id),
        onError: async (error) => {
            if (isAlreadyAnswered(error)) await refreshRequest();
        },
    });

    // This tab's own answer wins over the re-read request: once the CLI has picked up its
    // token, the server no longer knows the request at all.
    const outcome: Outcome =
        approve.isSuccess && approve.data !== null
            ? { kind: "approved-here" }
            : deny.isSuccess
              ? { kind: "denied-here" }
              : isGone(approve.error) || isGone(deny.error)
                ? {
                      kind: "gone",
                      message: getErrorMessage(
                          approve.error ?? deny.error,
                          "This login request is no longer available",
                      ),
                  }
                : request === null
                  ? { kind: "gone", message: null }
                  : request.status === "approved"
                    ? { kind: "approved" }
                    : request.status === "denied"
                      ? { kind: "denied" }
                      : { kind: "form", request };

    /** Keeps every keystroke in the URL without adding a back-history entry for each. */
    const updateSearch = (patch: CliLoginSearch) =>
        void navigate({
            search: (previous) => ({ ...previous, ...patch }),
            replace: true,
        });

    const error = approve.error ?? deny.error;

    return (
        <div className="min-h-full bg-canvas px-4 py-8 @xl:px-8">
            <main className="mx-auto max-w-4xl overflow-hidden rounded-xl border border-slate-800 bg-surface shadow-2xl shadow-black/20">
                <header className="border-b border-slate-800 bg-gradient-to-r from-blue-500/10 via-transparent to-transparent px-6 py-6 @xl:px-8">
                    <div className="flex items-center gap-3">
                        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-2 text-blue-300">
                            <SquareTerminal
                                className="h-5 w-5"
                                aria-hidden="true"
                            />
                        </div>
                        <div className="min-w-0">
                            <h1 className="text-2xl font-bold text-slate-100">
                                Approve CLI login
                            </h1>
                            <p className="mt-1 text-sm text-slate-400">
                                A{" "}
                                <code className="rounded bg-surface-code px-1 py-0.5 text-slate-200">
                                    redoor remote login
                                </code>{" "}
                                is waiting for an access token.
                            </p>
                        </div>
                    </div>
                </header>
                {outcome.kind === "form" ? (
                    <ApprovalForm
                        request={outcome.request}
                        search={search}
                        agents={agents}
                        needsSignIn={freshLogin.needsSignIn}
                        isApproving={approve.isPending}
                        isDenying={deny.isPending}
                        errorMessage={
                            error && !isAlreadyAnswered(error)
                                ? getErrorMessage(error, "The request failed")
                                : null
                        }
                        onChange={updateSearch}
                        onApprove={(body) => {
                            deny.reset();
                            approve.mutate(body);
                        }}
                        onDeny={() => {
                            approve.reset();
                            deny.mutate();
                        }}
                    />
                ) : (
                    <OutcomePanel outcome={outcome} />
                )}
            </main>
        </div>
    );
}

/**
 * The request's details, the code and the token form. The details and the warning lead, so
 * the user checks whose request this is before choosing anything.
 */
function ApprovalForm(props: {
    request: CliLoginResponse;
    search: CliLoginSearch;
    agents: TokenAgents;
    needsSignIn: boolean;
    isApproving: boolean;
    isDenying: boolean;
    errorMessage: string | null;
    onChange: (patch: CliLoginSearch) => void;
    onApprove: (body: ApproveCliLoginRequest) => void;
    onDeny: () => void;
}) {
    const requested = props.request.token;

    const requestedDevices = resolveRequestedDevices(
        requested.devices,
        props.agents,
    );

    const draft = buildAccessTokenPolicyDraft(
        {
            name: props.search.name ?? requested.name,
            permissions: props.search.permissions ?? requested.permissions,
            deviceMode: props.search.deviceMode ?? requestedDevices.deviceMode,
            deviceIds: props.search.deviceIds ?? requestedDevices.deviceIds,
        },
        props.onChange,
    );

    const expiry = props.search.expiry ?? requested.lifetime;

    const code = props.search.code ?? "";
    const normalizedCode = normalizeUserCode(code);
    const busy = props.isApproving || props.isDenying;

    const canApprove =
        draft.canSubmit && normalizedCode.length === USER_CODE_LENGTH;

    /** Native submit keeps Enter in the code field working like the Approve button. */
    const submit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!canApprove || busy) return;

        props.onApprove({
            user_code: normalizedCode,
            token: { ...draft.policy, expires_at: expiresAtFor(expiry) },
        });
    };

    const address = props.request.forwarded_for
        ? `${props.request.client_ip}, forwarded for ${props.request.forwarded_for}`
        : props.request.client_ip;

    return (
        <form aria-label="Approve CLI login" onSubmit={submit}>
            <dl className="grid grid-cols-1 gap-px border-b border-slate-800 bg-slate-800 @xl:grid-cols-2 @4xl:grid-cols-4">
                <FactItem
                    label="Host"
                    icon={<Server className="h-3.5 w-3.5" />}
                >
                    {props.request.host_name}
                </FactItem>
                <FactItem
                    label="Client address"
                    icon={<Network className="h-3.5 w-3.5" />}
                >
                    {address}
                </FactItem>
                <FactItem
                    label="Requested"
                    icon={<Clock className="h-3.5 w-3.5" />}
                >
                    {formatDuration(props.request.age_seconds)} ago
                </FactItem>
                <FactItem
                    label="Expires"
                    icon={<CalendarClock className="h-3.5 w-3.5" />}
                >
                    in {formatDuration(props.request.expires_in_seconds)}
                </FactItem>
            </dl>
            <div className="space-y-7 p-6 @xl:p-8">
                <div
                    role="note"
                    className="flex gap-3 rounded-lg border border-amber-400/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
                >
                    <ShieldAlert
                        className="mt-0.5 h-5 w-5 shrink-0 text-amber-300"
                        aria-hidden="true"
                    />
                    <p>
                        Only approve if you just ran{" "}
                        <code className="rounded bg-surface-code px-1 py-0.5 text-amber-50">
                            redoor remote login
                        </code>{" "}
                        on{" "}
                        <strong className="font-semibold text-amber-50">
                            {props.request.host_name}
                        </strong>{" "}
                        yourself. Approving somebody else's request gives them
                        access to your devices.
                    </p>
                </div>
                <TextField
                    label="Code from the terminal"
                    value={code}
                    placeholder="XXXX-XXXX"
                    description="The code the CLI printed next to this page's address. Case and the dash do not matter."
                    required
                    autoComplete="off"
                    disabled={busy}
                    onChange={(value) => props.onChange({ code: value })}
                />
                <AccessTokenPolicyFields
                    draft={draft}
                    agents={props.agents}
                    disabled={busy}
                    extraField={
                        <TokenExpiryField
                            value={expiry}
                            disabled={busy}
                            onChange={(value) =>
                                props.onChange({ expiry: value })
                            }
                        />
                    }
                />
                {requestedDevices.unknown.length > 0 ? (
                    <p className="text-sm text-amber-300">
                        The CLI asked for devices that do not exist here, so
                        they are left out: {requestedDevices.unknown.join(", ")}
                    </p>
                ) : null}
                {props.needsSignIn ? (
                    <p className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-200">
                        You'll be asked to sign in again before the login is
                        approved.
                    </p>
                ) : null}
                {props.errorMessage ? (
                    <p
                        role="alert"
                        className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
                    >
                        {props.errorMessage}
                    </p>
                ) : null}
                <div className="flex flex-col-reverse gap-3 border-t border-slate-800 pt-6 @xl:flex-row @xl:justify-end">
                    <Button
                        tooltip="Turn down this login; the CLI stops waiting"
                        type="button"
                        variant="danger"
                        size="lg"
                        isLoading={props.isDenying}
                        disabled={busy}
                        onClick={props.onDeny}
                    >
                        <CircleX className="h-4 w-4" />
                        Deny
                    </Button>
                    <Button
                        tooltip={
                            canApprove
                                ? "Create the token and hand it to the waiting CLI"
                                : "Enter the code from the terminal, a name, at least one permission, and at least one device"
                        }
                        type="submit"
                        size="lg"
                        isLoading={props.isApproving}
                        disabled={!canApprove || busy}
                    >
                        <CircleCheck className="h-4 w-4" />
                        Approve
                    </Button>
                </div>
            </div>
        </form>
    );
}

/** Tells the user how the request ended and what, if anything, is left to do. */
function OutcomePanel(props: { outcome: Exclude<Outcome, { kind: "form" }> }) {
    const content = outcomeContent(props.outcome);

    return (
        <div
            role="status"
            className={cn(
                "m-6 flex gap-3 rounded-lg border px-5 py-4 @xl:m-8",
                content.tone === "success"
                    ? "border-emerald-500/40 bg-emerald-500/10"
                    : "border-slate-700 bg-slate-800/50",
            )}
        >
            {content.tone === "success" ? (
                <CircleCheck
                    className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300"
                    aria-hidden="true"
                />
            ) : (
                <CircleX
                    className="mt-0.5 h-5 w-5 shrink-0 text-slate-400"
                    aria-hidden="true"
                />
            )}
            <div>
                <p className="font-semibold text-slate-100">{content.title}</p>
                <p className="mt-1 text-sm text-slate-300">{content.body}</p>
            </div>
        </div>
    );
}

/** How an ended request is worded and coloured. */
type OutcomeContent = {
    tone: "success" | "neutral";
    title: string;
    body: string;
};

/** The wording for each way a request can be over. */
function outcomeContent(
    outcome: Exclude<Outcome, { kind: "form" }>,
): OutcomeContent {
    switch (outcome.kind) {
        case "approved-here":
            return {
                tone: "success",
                title: "Login approved",
                body: "You can close this tab; the CLI has its token.",
            };
        case "denied-here":
            return {
                tone: "neutral",
                title: "Login denied",
                body: "The CLI was told and stopped waiting. You can close this tab.",
            };
        case "approved":
            return {
                tone: "success",
                title: "This login was already approved",
                body: "The CLI has its token or picks it up shortly. You can close this tab.",
            };
        case "denied":
            return {
                tone: "neutral",
                title: "This login was denied",
                body: "The CLI was told and stopped waiting. Run redoor remote login again if you still need a token.",
            };
        case "gone":
            return {
                tone: "neutral",
                title: "This login request is no longer available",
                // The server's own reason when there is one, such as too many wrong codes.
                body:
                    outcome.message ??
                    "It is unknown, expired or already used. Run redoor remote login again to start a new one.",
            };
    }
}
