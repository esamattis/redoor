import * as React from "react";
import {
    Eye,
    FilePen,
    FileX,
    type LucideIcon,
    Power,
    SquareTerminal,
} from "lucide-react";
import { z } from "zod";

import type { AccessTokenResponse } from "#bindings/AccessTokenResponse";
import type { DeviceScope } from "#bindings/DeviceScope";
import type { Permission } from "#bindings/Permission";
import type { TokenLifetime } from "#bindings/TokenLifetime";
import { Checkbox } from "#ui/components/checkbox";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { Select } from "#ui/components/select";
import { TextField } from "#ui/components/text-field";

/**
 * Typed as an exhaustive record so a new server-side permission fails the TS
 * build until it gets a human label instead of silently showing a raw id.
 */
export const permissionLabels: Record<
    Permission,
    { label: string; description: string; icon: LucideIcon }
> = {
    "files:read": {
        label: "Read files",
        description: "List, search, read, and download files.",
        icon: Eye,
    },
    "files:write": {
        label: "Write files",
        description: "Upload, replace, copy, and create files or directories.",
        icon: FilePen,
    },
    "files:delete": {
        label: "Delete files",
        description: "Trash or permanently remove files and move sources.",
        icon: FileX,
    },
    "commands:execute": {
        label: "Run commands",
        description:
            "High trust: commands run as the agent's OS user and can bypass all file permissions.",
        icon: SquareTerminal,
    },
    "agents:manage": {
        label: "Manage agents",
        description: "Start and stop managed devices.",
        icon: Power,
    },
};

/** Fixed display order so the least dangerous permissions are listed first. */
export const permissionOrder: Permission[] = [
    "files:read",
    "files:write",
    "files:delete",
    "commands:execute",
    "agents:manage",
];

export type TokenAgents = Array<{ id: string; name: string }>;

/** Tokens past their expiry are rejected by the server, so the UI must not offer to extend their use. */
export function isExpired(token: AccessTokenResponse): boolean {
    return (
        token.expires_at !== null && Date.parse(token.expires_at) <= Date.now()
    );
}

/** The editable values of a token policy, kept apart from where they are stored. */
export type AccessTokenPolicyValues = {
    name: string;
    permissions: Permission[];
    deviceMode: DeviceScope["kind"];
    deviceIds: string[];
};

/** What a new token gets when nobody chose otherwise: read-only on every device. */
export const DEFAULT_POLICY_VALUES: AccessTokenPolicyValues = {
    name: "",
    permissions: ["files:read"],
    deviceMode: "all",
    deviceIds: [],
};

/**
 * Builds the draft the policy fields edit from values stored anywhere: the edit page keeps
 * them in component state, while the create dialog and the CLI approval page keep them in
 * the URL so they survive the fresh sign-in round trip. Either way the draft validates the
 * same, so both reach the server with the same rules.
 */
export function buildAccessTokenPolicyDraft(
    values: AccessTokenPolicyValues,
    update: (patch: Partial<AccessTokenPolicyValues>) => void,
) {
    const devices: DeviceScope =
        values.deviceMode === "all"
            ? { kind: "all" }
            : { kind: "only", device_ids: values.deviceIds };

    return {
        ...values,
        setName: (name: string) => update({ name }),
        setPermissions: (permissions: Permission[]) => update({ permissions }),
        setDeviceMode: (deviceMode: DeviceScope["kind"]) =>
            update({ deviceMode }),
        setDeviceIds: (deviceIds: string[]) => update({ deviceIds }),
        policy: {
            name: values.name.trim(),
            permissions: values.permissions,
            devices,
        },
        // An explicit device list with no devices would grant nothing, so it is rejected.
        canSubmit:
            values.name.trim().length > 0 &&
            values.permissions.length > 0 &&
            (values.deviceMode === "all" || values.deviceIds.length > 0),
    };
}

export type AccessTokenPolicyDraft = ReturnType<
    typeof buildAccessTokenPolicyDraft
>;

/**
 * A draft in component state, for the edit page: its changes only matter until it saves,
 * and nothing there leaves the page before that.
 */
export function useAccessTokenPolicyDraft(
    token: AccessTokenResponse | null,
): AccessTokenPolicyDraft {
    const [values, setValues] = React.useState<AccessTokenPolicyValues>(() =>
        token === null
            ? DEFAULT_POLICY_VALUES
            : {
                  name: token.name,
                  permissions: token.permissions,
                  deviceMode: token.devices.kind,
                  deviceIds:
                      token.devices.kind === "only"
                          ? token.devices.device_ids
                          : [],
              },
    );

    return buildAccessTokenPolicyDraft(values, (patch) =>
        setValues((previous) => ({ ...previous, ...patch })),
    );
}

const permissionSchema: z.ZodType<Permission> = z.enum([
    "files:read",
    "files:write",
    "files:delete",
    "commands:execute",
    "agents:manage",
]);

const tokenLifetimeSchema: z.ZodType<TokenLifetime> = z.enum([
    "30d",
    "90d",
    "365d",
    "never",
]);

/**
 * The search params of a token form that lives in the URL. A form whose state survives a
 * full page load lets the user fill it in first and sign in again only as the last step,
 * so the one fresh minute is spent on one click. Each param falls back to the form's
 * default when absent or malformed.
 */
export const tokenFormSearchSchema = z.object({
    name: z.string().optional().catch(undefined),
    permissions: z.array(permissionSchema).optional().catch(undefined),
    deviceMode: z.enum(["all", "only"]).optional().catch(undefined),
    deviceIds: z.array(z.string()).optional().catch(undefined),
    expiry: tokenLifetimeSchema.optional().catch(undefined),
});

export type TokenFormSearch = z.infer<typeof tokenFormSearchSchema>;

/** Days per lifetime choice; `never` has no automatic expiry. */
const LIFETIME_DAYS: Record<TokenLifetime, number | null> = {
    "30d": 30,
    "90d": 90,
    "365d": 365,
    never: null,
};

/** The default lifetime of new tokens: long enough to be practical, short enough to age out. */
export const DEFAULT_TOKEN_LIFETIME: TokenLifetime = "90d";

/** Turns a lifetime choice into the timestamp the server stores, counted from now. */
export function expiresAtFor(lifetime: TokenLifetime): string | null {
    const days = LIFETIME_DAYS[lifetime];

    return days === null
        ? null
        : new Date(Date.now() + days * 86_400_000).toISOString();
}

/**
 * The expiry choice of a new token. Shared by the create dialog and the CLI approval page,
 * so both offer the same lifetimes the CLI's `--expires` flag uses.
 */
export function TokenExpiryField(props: {
    value: TokenLifetime;
    disabled: boolean;
    onChange: (value: TokenLifetime) => void;
}) {
    return (
        <label className="text-sm font-medium text-slate-300">
            Expiry
            <Select
                aria-label="Token expiry"
                value={props.value}
                disabled={props.disabled}
                containerClassName="mt-2 block"
                onChange={(event) => {
                    const parsed = tokenLifetimeSchema.safeParse(
                        event.target.value,
                    );

                    if (parsed.success) props.onChange(parsed.data);
                }}
            >
                <option value="30d">30 days</option>
                <option value="90d">90 days</option>
                <option value="365d">365 days</option>
                <option value="never">Never</option>
            </Select>
            <span className="mt-1.5 block text-xs font-normal text-slate-500">
                Short expiries limit exposure if a client leaks its token.
            </span>
        </label>
    );
}

/**
 * Renders the name, permission and device controls in one layout so creating and editing a
 * token always present the same choices. `extraField` sits beside the name, which keeps
 * create-only settings such as expiry out of the edit page without a second layout.
 */
export function AccessTokenPolicyFields(props: {
    draft: AccessTokenPolicyDraft;
    agents: TokenAgents;
    disabled: boolean;
    extraField?: React.ReactNode;
}) {
    return (
        <div className="grid gap-6 @2xl:grid-cols-2">
            <div className={props.extraField ? undefined : "@2xl:col-span-2"}>
                <TextField
                    label="Token name"
                    value={props.draft.name}
                    placeholder="Coding assistant"
                    description="Shown only in Redoor token management."
                    required
                    disabled={props.disabled}
                    onChange={props.draft.setName}
                />
            </div>
            {props.extraField}
            <PermissionFieldset
                permissions={props.draft.permissions}
                disabled={props.disabled}
                onChange={props.draft.setPermissions}
            />
            <DeviceScopeFields
                agents={props.agents}
                mode={props.draft.deviceMode}
                deviceIds={props.draft.deviceIds}
                disabled={props.disabled}
                onModeChange={props.draft.setDeviceMode}
                onDeviceIdsChange={props.draft.setDeviceIds}
            />
        </div>
    );
}

/** Renders permissions from the exhaustive label table so the order and warnings match the token cards. */
function PermissionFieldset(props: {
    permissions: Permission[];
    disabled: boolean;
    onChange: (permissions: Permission[]) => void;
}) {
    return (
        <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium text-slate-300">
                Permissions
            </legend>
            {permissionOrder.map((permission) => (
                <Checkbox
                    key={permission}
                    role="checkbox"
                    checked={props.permissions.includes(permission)}
                    disabled={props.disabled}
                    onCheckedChange={(checked) =>
                        props.onChange(
                            checked
                                ? [...props.permissions, permission]
                                : props.permissions.filter(
                                      (item) => item !== permission,
                                  ),
                        )
                    }
                >
                    <span>
                        <span className="block text-left">
                            {permissionLabels[permission].label}
                        </span>
                        <span
                            className={
                                permission === "commands:execute"
                                    ? "block max-w-sm text-left text-xs text-amber-300"
                                    : "block max-w-sm text-left text-xs text-slate-500"
                            }
                        >
                            {permissionLabels[permission].description}
                        </span>
                    </span>
                </Checkbox>
            ))}
        </fieldset>
    );
}

/** Separates "all devices" from an explicit list because only the former also covers devices added later. */
function DeviceScopeFields(props: {
    agents: TokenAgents;
    mode: DeviceScope["kind"];
    deviceIds: string[];
    disabled: boolean;
    onModeChange: (mode: DeviceScope["kind"]) => void;
    onDeviceIdsChange: (deviceIds: string[]) => void;
}) {
    return (
        <div className="space-y-3">
            <RadioCardGroup
                legend="Allowed devices"
                legendClassName="mb-2 text-sm font-medium text-slate-300"
                disabled={props.disabled}
            >
                <RadioCardOption
                    name="token-device-scope"
                    value="all"
                    label="All devices"
                    description="Including devices added later"
                    checked={props.mode === "all"}
                    layout="descriptive"
                    onChange={() => props.onModeChange("all")}
                />
                <RadioCardOption
                    name="token-device-scope"
                    value="only"
                    label="Selected devices"
                    description="Only the devices checked below"
                    checked={props.mode === "only"}
                    layout="descriptive"
                    onChange={() => props.onModeChange("only")}
                />
            </RadioCardGroup>
            {props.mode === "only" ? (
                <fieldset className="space-y-1 pl-1">
                    <legend className="sr-only">Selected devices</legend>
                    {props.agents.length === 0 ? (
                        <p className="text-sm text-slate-500">
                            No configured devices are available.
                        </p>
                    ) : (
                        props.agents.map((agent) => (
                            <Checkbox
                                key={agent.id}
                                role="checkbox"
                                checked={props.deviceIds.includes(agent.id)}
                                disabled={props.disabled}
                                onCheckedChange={(checked) =>
                                    props.onDeviceIdsChange(
                                        checked
                                            ? [...props.deviceIds, agent.id]
                                            : props.deviceIds.filter(
                                                  (id) => id !== agent.id,
                                              ),
                                    )
                                }
                            >
                                {agent.name}
                            </Checkbox>
                        ))
                    )}
                    {props.deviceIds.length === 0 ? (
                        <p className="text-xs text-amber-300">
                            Select at least one device.
                        </p>
                    ) : null}
                </fieldset>
            ) : null}
        </div>
    );
}
