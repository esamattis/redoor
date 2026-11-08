import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    CalendarClock,
    CalendarPlus,
    History,
    KeyRound,
    MonitorSmartphone,
    Pencil,
    Plus,
    RotateCw,
    Trash2,
} from "lucide-react";
import { z } from "zod";

import type { AccessTokenResponse } from "#bindings/AccessTokenResponse";
import { accessTokensQueryOptions, queryKeys } from "#ui/queries";
import { useAgents } from "#ui/use-agents";
import {
    AccessTokenPolicyFields,
    buildAccessTokenPolicyDraft,
    DEFAULT_POLICY_VALUES,
    DEFAULT_TOKEN_LIFETIME,
    expiresAtFor,
    isExpired,
    permissionLabels,
    permissionOrder,
    TokenExpiryField,
    type TokenAgents,
    type TokenFormSearch,
    tokenFormSearchSchema,
} from "#ui/components/access-token-policy";
import { Button } from "#ui/components/button";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { CopyableCodeRow } from "#ui/components/copyable-code-row";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { FactItem } from "#ui/components/fact-item";
import { LinkButton } from "#ui/components/link-button";
import { RelativeTime } from "#ui/components/relative-time";
import { Toast } from "#ui/components/toast";
import { Tooltip } from "#ui/components/tooltip";
import { useFreshLogin } from "#ui/use-fresh-login";
import { getErrorMessage } from "#ui/utils/error";

/**
 * The edit page lives on its own route, so it reports a successful save back through the URL
 * instead of shared component state. The create dialog (`create` and the token form params)
 * and the token being rotated (`rotate`) live in the URL too: both need a fresh sign-in,
 * which leaves the page, and the user returns to the open, filled-in dialog.
 */
const tokensSearchSchema = tokenFormSearchSchema.extend({
    notice: z.enum(["updated"]).optional(),
    create: z.boolean().optional().catch(undefined),
    rotate: z.string().optional().catch(undefined),
});

/** The search without the create dialog, so closing it also forgets its draft. */
const CLOSED_CREATE_FORM = {
    create: undefined,
    name: undefined,
    permissions: undefined,
    deviceMode: undefined,
    deviceIds: undefined,
    expiry: undefined,
} satisfies Partial<z.infer<typeof tokensSearchSchema>>;

export const Route = createFileRoute("/_app/settings/tokens/")({
    validateSearch: tokensSearchSchema,
    loader: async ({ context }) => {
        await context.queryClient.ensureQueryData(
            accessTokensQueryOptions(context.api),
        );
    },
    component: AccessTokenSettingsPage,
});

/** Tokens this close to expiry are flagged so users can replace them before clients break. */
const EXPIRING_SOON_MS = 7 * 86_400_000;

/** Owns transient secrets only while their modal is open and keeps them outside Query caches. */
function AccessTokenSettingsPage() {
    const { api } = Route.useRouteContext();
    const search = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    const agents = useAgents();
    const queryClient = useQueryClient();
    const tokensQuery = useQuery(accessTokensQueryOptions(api));
    const freshLogin = useFreshLogin();

    const [secret, setSecret] = React.useState<{
        value: string;
        action: "created" | "rotated";
    } | null>(null);

    const [deleting, setDeleting] = React.useState<AccessTokenResponse | null>(
        null,
    );

    const [notice, setNotice] = React.useState<string | null>(null);

    const shownNotice =
        notice ??
        (search.notice === "updated"
            ? "Token updated. New permissions apply to future requests."
            : null);

    /** Clears the URL notice too, so a reload does not repeat feedback for an old save. */
    const dismissNotice = () => {
        setNotice(null);

        if (search.notice) {
            void navigate({
                search: (previous) => ({ ...previous, notice: undefined }),
                replace: true,
            });
        }
    };

    /**
     * Applies a change to the URL-held dialog state. Replacing the entry keeps every
     * keystroke and dialog toggle out of the back history.
     */
    const updateSearch = (patch: Partial<z.infer<typeof tokensSearchSchema>>) =>
        navigate({
            search: (previous) => ({ ...previous, ...patch }),
            replace: true,
        });

    const refresh = async () =>
        queryClient.invalidateQueries({ queryKey: queryKeys.accessTokens() });

    const rotate = useMutation({
        mutationFn: (id: string) =>
            freshLogin.run(() => api.rotateAccessToken(id)),
        onSuccess: async (result) => {
            // Null when the user was sent to sign in first; the dialog waits for their return.
            if (result === null) return;

            await updateSearch({ rotate: undefined });
            setSecret({ value: result.token, action: "rotated" });
            await refresh();
        },
    });

    const remove = useMutation({
        mutationFn: (id: string) => api.deleteAccessToken(id),
        onSuccess: async () => {
            setDeleting(null);
            setNotice(
                "Token deleted. Clients using it will be rejected from now on.",
            );
            await refresh();
        },
    });

    const tokens = tokensQuery.data?.tokens ?? [];
    const activeCount = tokens.filter((token) => !isExpired(token)).length;

    // A token deleted meanwhile has nothing left to rotate, so its dialog stays closed.
    const rotating =
        tokens.find(
            (token) => token.id === search.rotate && !isExpired(token),
        ) ?? null;

    return (
        <div className="min-h-full bg-canvas px-4 py-8 @xl:px-8">
            <div className="mx-auto max-w-5xl">
                <TokensHeader
                    tokenCount={tokens.length}
                    activeCount={activeCount}
                    onCreate={() => void updateSearch({ create: true })}
                />
                {tokensQuery.isError ? (
                    <p
                        role="alert"
                        className="mt-6 rounded border border-red-800 bg-red-950/20 p-4 text-red-300"
                    >
                        Could not load access tokens.{" "}
                        <Button
                            tooltip="Reload the token list"
                            type="button"
                            variant="subtle"
                            onClick={() => void tokensQuery.refetch()}
                        >
                            Try again
                        </Button>
                    </p>
                ) : tokensQuery.isLoading ? (
                    <p className="mt-8 text-slate-400">
                        Loading access tokens…
                    </p>
                ) : tokens.length === 0 ? (
                    <div className="mt-6 flex flex-col items-center rounded-xl border border-dashed border-slate-700 px-6 py-12 text-center">
                        <div className="rounded-full border border-slate-700 bg-surface p-3 text-slate-400">
                            <KeyRound className="h-6 w-6" aria-hidden="true" />
                        </div>
                        <p className="mt-4 font-medium text-slate-200">
                            No access tokens yet
                        </p>
                        <p className="mt-1 text-sm text-slate-400">
                            Create one to connect an MCP client.
                        </p>
                    </div>
                ) : (
                    <div className="mt-6 grid gap-4">
                        {tokens.map((token) => (
                            <TokenCard
                                key={token.id}
                                token={token}
                                agents={agents}
                                onRotate={() => {
                                    rotate.reset();
                                    void updateSearch({ rotate: token.id });
                                }}
                                onDelete={() => setDeleting(token)}
                            />
                        ))}
                    </div>
                )}
            </div>
            {search.create ? (
                <CreateTokenDialog
                    agents={agents}
                    form={search}
                    freshLogin={freshLogin}
                    onChange={(patch) => void updateSearch(patch)}
                    onClose={() => void updateSearch(CLOSED_CREATE_FORM)}
                    onCreated={async (value) => {
                        await updateSearch(CLOSED_CREATE_FORM);
                        setSecret({ value, action: "created" });
                        await refresh();
                    }}
                />
            ) : null}
            <ConfirmationDialog
                isOpen={rotating !== null}
                title="Rotate access token?"
                description="Rotation immediately invalidates the current secret. Clients must be reconfigured with the new one."
                confirmLabel="Rotate token"
                busyLabel="Rotating…"
                isBusy={rotate.isPending}
                errorMessage={
                    rotate.isError
                        ? getErrorMessage(
                              rotate.error,
                              "Could not rotate the token",
                          )
                        : null
                }
                onClose={() => {
                    if (!rotate.isPending)
                        void updateSearch({ rotate: undefined });
                }}
                onConfirm={() => {
                    if (rotating) rotate.mutate(rotating.id);
                }}
            >
                {freshLogin.needsSignIn ? (
                    <FreshSignInHint action="rotated" />
                ) : null}
            </ConfirmationDialog>
            <ConfirmationDialog
                isOpen={deleting !== null}
                title="Delete access token?"
                description="All later requests using this token will fail immediately. This cannot be undone."
                confirmLabel="Delete token"
                busyLabel="Deleting…"
                isBusy={remove.isPending}
                errorMessage={
                    remove.isError
                        ? getErrorMessage(
                              remove.error,
                              "Could not delete the token",
                          )
                        : null
                }
                onClose={() => setDeleting(null)}
                onConfirm={() => {
                    if (deleting) remove.mutate(deleting.id);
                }}
            />
            <SecretDialog
                secret={secret}
                origin={window.location.origin}
                onClose={() => setSecret(null)}
            />
            {shownNotice ? (
                <Toast
                    key={shownNotice}
                    tone="success"
                    onDismiss={dismissNotice}
                >
                    {shownNotice}
                </Toast>
            ) : null}
        </div>
    );
}

/** Pairs the page purpose with its primary action and a quick count of usable tokens. */
function TokensHeader(props: {
    tokenCount: number;
    activeCount: number;
    onCreate: () => void;
}) {
    return (
        <header className="overflow-hidden rounded-xl border border-slate-800 bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-4 bg-gradient-to-r from-blue-500/10 via-transparent to-transparent px-6 py-6 @xl:px-8">
                <div className="flex min-w-0 items-start gap-4">
                    <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-2.5 text-blue-300">
                        <KeyRound className="h-6 w-6" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-bold text-slate-100">
                            Access tokens
                        </h1>
                        <p className="mt-1 max-w-2xl text-sm text-slate-400">
                            Access tokens authenticate the remote CLI and MCP
                            clients. Running{" "}
                            <code className="rounded bg-surface-code px-1 py-0.5 text-slate-200">
                                redoor remote login
                            </code>{" "}
                            opens a page here to approve its token; create
                            tokens for MCP clients here.
                        </p>
                    </div>
                </div>
                <Button
                    tooltip="Create a token with limited permissions and devices"
                    type="button"
                    onClick={props.onCreate}
                >
                    <Plus className="h-4 w-4" />
                    Create token
                </Button>
            </div>
            {props.tokenCount > 0 ? (
                <p className="border-t border-slate-800 px-6 py-2.5 text-xs text-slate-500 @xl:px-8">
                    {props.tokenCount}{" "}
                    {props.tokenCount === 1 ? "token" : "tokens"} ·{" "}
                    {props.activeCount} active
                </p>
            ) : null}
        </header>
    );
}

/** Derives one lifecycle state so the badge and icon tile always agree. */
function tokenStatus(
    token: AccessTokenResponse,
): "active" | "expiring" | "expired" {
    if (isExpired(token)) return "expired";

    if (
        token.expires_at !== null &&
        Date.parse(token.expires_at) - Date.now() <= EXPIRING_SOON_MS
    ) {
        return "expiring";
    }

    return "active";
}

const statusStyles = {
    active: {
        label: "Active",
        badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
        dot: "bg-emerald-400",
        tile: "border-blue-500/30 bg-blue-500/10 text-blue-300",
    },
    expiring: {
        label: "Expires soon",
        badge: "border-amber-500/30 bg-amber-500/10 text-amber-300",
        dot: "bg-amber-400",
        tile: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    },
    expired: {
        label: "Expired",
        badge: "border-slate-600 bg-slate-700/40 text-slate-300",
        dot: "bg-slate-500",
        tile: "border-slate-700 bg-slate-800/60 text-slate-500",
    },
} satisfies Record<
    ReturnType<typeof tokenStatus>,
    { label: string; badge: string; dot: string; tile: string }
>;

/** Presents one secret-free record; expired tokens can only be deleted because the server rejects them. */
function TokenCard(props: {
    token: AccessTokenResponse;
    agents: TokenAgents;
    onRotate: () => void;
    onDelete: () => void;
}) {
    const status = tokenStatus(props.token);
    const styles = statusStyles[status];
    const expired = status === "expired";

    const devices =
        props.token.devices.kind === "all"
            ? "All devices"
            : props.token.devices.device_ids
                  .map(
                      (id) =>
                          props.agents.find((agent) => agent.id === id)?.name ??
                          id,
                  )
                  .join(", ");

    const permissions = permissionOrder.filter((permission) =>
        props.token.permissions.includes(permission),
    );

    return (
        <article
            aria-label={props.token.name}
            className="overflow-hidden rounded-xl border border-slate-800 bg-surface transition-colors hover:border-slate-700"
        >
            <div className="flex flex-wrap items-start gap-4 p-5">
                <div
                    className={`shrink-0 rounded-lg border p-2.5 ${styles.tile}`}
                >
                    <KeyRound className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-base font-semibold text-slate-100">
                            {props.token.name}
                        </h2>
                        <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${styles.badge}`}
                        >
                            <span
                                aria-hidden="true"
                                className={`h-1.5 w-1.5 rounded-full ${styles.dot}`}
                            />
                            {styles.label}
                        </span>
                    </div>
                    <ul
                        aria-label="Permissions"
                        className="mt-3 flex flex-wrap gap-1.5"
                    >
                        {permissions.map((permission) => {
                            const Icon = permissionLabels[permission].icon;

                            return (
                                <li
                                    key={permission}
                                    className={
                                        permission === "commands:execute"
                                            ? "inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-300"
                                            : "inline-flex items-center gap-1.5 rounded-md border border-blue-500/20 bg-blue-500/10 px-2 py-1 text-xs text-blue-300"
                                    }
                                >
                                    <Icon
                                        className="h-3.5 w-3.5"
                                        aria-hidden="true"
                                    />
                                    {permissionLabels[permission].label}
                                </li>
                            );
                        })}
                    </ul>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {expired ? (
                        <Button
                            tooltip="Expired tokens cannot be edited"
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled
                        >
                            <Pencil className="h-4 w-4" />
                            Edit
                        </Button>
                    ) : (
                        <Tooltip content="Edit token name, permissions, and allowed devices">
                            <LinkButton
                                to="/settings/tokens/$tokenId/edit"
                                params={{ tokenId: props.token.id }}
                                variant="secondary"
                                size="sm"
                            >
                                <Pencil className="h-4 w-4" />
                                Edit
                            </LinkButton>
                        </Tooltip>
                    )}
                    <Button
                        tooltip="Replace the secret and invalidate the current one"
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={expired}
                        onClick={props.onRotate}
                    >
                        <RotateCw className="h-4 w-4" />
                        Rotate
                    </Button>
                    <Button
                        tooltip="Delete the token and reject its clients"
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={props.onDelete}
                    >
                        <Trash2 className="h-4 w-4" />
                        Delete
                    </Button>
                </div>
            </div>
            <dl className="grid grid-cols-1 gap-px border-t border-slate-800 bg-slate-800 @xl:grid-cols-2 @4xl:grid-cols-4">
                <FactItem
                    label="Devices"
                    icon={<MonitorSmartphone className="h-3.5 w-3.5" />}
                >
                    {devices}
                </FactItem>
                <FactItem
                    label="Created"
                    icon={<CalendarPlus className="h-3.5 w-3.5" />}
                >
                    <RelativeTime value={props.token.created_at} />
                </FactItem>
                <FactItem
                    label="Expires"
                    icon={<CalendarClock className="h-3.5 w-3.5" />}
                >
                    <RelativeTime value={props.token.expires_at} />
                </FactItem>
                <FactItem
                    label="Last used"
                    icon={<History className="h-3.5 w-3.5" />}
                >
                    <RelativeTime value={props.token.last_used_at} />
                </FactItem>
            </dl>
        </article>
    );
}

/**
 * Says up front that the button leads through the sign-in first, so leaving the page for
 * the login form does not come as a surprise.
 */
function FreshSignInHint(props: { action: "created" | "rotated" }) {
    return (
        <p className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-200">
            You'll be asked to sign in again before the token is {props.action}.
        </p>
    );
}

/**
 * Creation is a short modal workflow because it ends in the one-time secret dialog on this
 * page. Its draft lives in the URL (`form`), so the fresh sign-in can leave the page and
 * return to the same filled-in dialog.
 */
function CreateTokenDialog(props: {
    agents: TokenAgents;
    form: TokenFormSearch;
    freshLogin: ReturnType<typeof useFreshLogin>;
    onChange: (patch: TokenFormSearch) => void;
    onClose: () => void;
    onCreated: (secret: string) => Promise<void>;
}) {
    const { api } = Route.useRouteContext();
    const expiry = props.form.expiry ?? DEFAULT_TOKEN_LIFETIME;

    const draft = buildAccessTokenPolicyDraft(
        {
            name: props.form.name ?? DEFAULT_POLICY_VALUES.name,
            permissions:
                props.form.permissions ?? DEFAULT_POLICY_VALUES.permissions,
            deviceMode:
                props.form.deviceMode ?? DEFAULT_POLICY_VALUES.deviceMode,
            deviceIds: props.form.deviceIds ?? DEFAULT_POLICY_VALUES.deviceIds,
        },
        props.onChange,
    );

    const mutation = useMutation({
        mutationFn: async () => {
            const result = await props.freshLogin.run(() =>
                api.createAccessToken({
                    ...draft.policy,
                    expires_at: expiresAtFor(expiry),
                }),
            );

            // Null when the user was sent to sign in first; the dialog waits for their return.
            if (result !== null) await props.onCreated(result.token);
        },
    });

    /** Keeps the dialog open during saving so failures remain visible beside the draft. */
    const close = () => {
        if (!mutation.isPending) props.onClose();
    };

    return (
        <Dialog
            isOpen
            title="Create access token"
            description="Choose the least access this client needs."
            closeAriaLabel="Close token creation"
            isBusy={mutation.isPending}
            errorMessage={
                mutation.isError
                    ? getErrorMessage(
                          mutation.error,
                          "Could not save the token",
                      )
                    : null
            }
            size="wide"
            onClose={close}
        >
            {/* The fields' container queries would otherwise measure the page column behind
                this viewport-sized modal. */}
            <div className="@container mt-5">
                <AccessTokenPolicyFields
                    draft={draft}
                    agents={props.agents}
                    disabled={mutation.isPending}
                    extraField={
                        <TokenExpiryField
                            value={expiry}
                            disabled={mutation.isPending}
                            onChange={(value) =>
                                props.onChange({ expiry: value })
                            }
                        />
                    }
                />
            </div>
            {props.freshLogin.needsSignIn ? (
                <div className="mt-6">
                    <FreshSignInHint action="created" />
                </div>
            ) : null}
            <DialogActions stackOnMobile>
                <Button
                    tooltip="Discard changes"
                    type="button"
                    variant="secondary"
                    disabled={mutation.isPending}
                    onClick={close}
                >
                    Cancel
                </Button>
                <Button
                    tooltip={
                        draft.canSubmit
                            ? "Save the token policy"
                            : "Enter a name, at least one permission, and at least one device"
                    }
                    type="button"
                    isLoading={mutation.isPending}
                    disabled={!draft.canSubmit}
                    onClick={() => mutation.mutate()}
                >
                    Create token
                </Button>
            </DialogActions>
        </Dialog>
    );
}

/**
 * Builds a self-contained instruction for an AI agent so users can hand over the MCP setup
 * in one paste instead of translating the endpoint details into their client's config format.
 */
function agentSetupPrompt(token: string, origin: string): string {
    return `Configure the Redoor MCP server for yourself so you can use its tools.

Server name: redoor
URL: ${origin}/mcp
Transport: Streamable HTTP (stateless, POST only, MCP protocol version 2026-07-28)
Authentication: send the header "Authorization: Bearer ${token}" with every request

Add the server to your own MCP client configuration, then verify the connection by listing its tools. Treat the token as a password: store it as a secret or environment variable where your client supports that, and never commit it to version control or print it in logs.`;
}

/** Displays the sole recoverable copy of a new secret until the user closes the workflow. */
function SecretDialog(props: {
    secret: { value: string; action: "created" | "rotated" } | null;
    origin: string;
    onClose: () => void;
}) {
    if (!props.secret) return null;

    return (
        <Dialog
            isOpen
            title={
                props.secret.action === "created"
                    ? "Token created"
                    : "Token rotated"
            }
            description="Copy this token now. Redoor stores only a verifier and cannot show it again."
            closeAriaLabel="Close one-time token"
            onClose={props.onClose}
        >
            <div className="mt-5 space-y-4">
                <CopyableCodeRow
                    label="Access token"
                    value={props.secret.value}
                    copyAriaLabel="Copy access token"
                />
                <CopyableCodeRow
                    label="MCP endpoint"
                    value={`${props.origin}/mcp`}
                    copyAriaLabel="Copy MCP endpoint"
                />
                <CopyableCodeRow
                    label="AI agent setup prompt"
                    value={agentSetupPrompt(props.secret.value, props.origin)}
                    copyAriaLabel="Copy AI agent setup prompt"
                    wrap
                />
                <p className="text-sm text-slate-400">
                    MCP clients should POST to this endpoint with{" "}
                    <code className="text-slate-200">
                        Authorization: Bearer &lt;token&gt;
                    </code>{" "}
                    and protocol version{" "}
                    <code className="text-slate-200">2026-07-28</code>.
                </p>
                <p className="text-sm text-slate-400">
                    For the remote CLI, run{" "}
                    <code className="text-slate-200">
                        redoor remote login {props.origin}
                    </code>{" "}
                    instead of pasting a token; you approve its own token in the
                    browser.
                </p>
            </div>
            <DialogActions>
                <Button
                    tooltip="Close and permanently hide this token"
                    type="button"
                    onClick={props.onClose}
                >
                    I saved the token
                </Button>
            </DialogActions>
        </Dialog>
    );
}
