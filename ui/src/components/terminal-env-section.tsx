import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Plus, SquareTerminal, Trash2 } from "lucide-react";

import { Button } from "#ui/components/button";
import { IconButton } from "#ui/components/icon-button";
import { InputControl } from "#ui/components/input-control";
import { Toast } from "#ui/components/toast";
import { queryKeys } from "#ui/queries";
import { getErrorMessage } from "#ui/utils/error";

const rootRouteApi = getRouteApi("__root__");

/** One editable variable; `key` keeps React rows stable while names are being typed. */
type EnvRow = { key: number; name: string; value: string };

/** Turns the saved map into rows sorted like the TOML file writes them. */
function rowsFrom(env: { [name in string]?: string }): EnvRow[] {
    return Object.entries(env).map(([name, value], index) => ({
        key: index,
        name,
        value: value ?? "",
    }));
}

/**
 * Builds the map to save, or explains why it cannot be saved. Blank rows are dropped, so an
 * added but unused row does not block saving. Duplicate names are refused here because the
 * map would silently keep only the last one.
 */
function envFrom(
    rows: EnvRow[],
): { env: { [name in string]: string } } | { error: string } {
    const env: { [name in string]: string } = {};

    for (const row of rows) {
        const name = row.name.trim();

        if (name === "" && row.value === "") {
            continue;
        }

        if (name === "") {
            return { error: "Every variable with a value needs a name." };
        }

        if (Object.hasOwn(env, name)) {
            return { error: `${name} is listed more than once.` };
        }

        env[name] = row.value;
    }

    return { env };
}

/**
 * Edits the extra environment variables a managed device's terminal shells start with.
 * Saved on its own instead of with the device form below, because that form stops the
 * agent, while these variables only reach shells opened later.
 */
export function TerminalEnvSection(props: {
    agentId: string;
    env: { [name in string]?: string };
}) {
    const { api } = rootRouteApi.useRouteContext();
    const queryClient = useQueryClient();
    const [rows, setRows] = React.useState<EnvRow[]>(() => rowsFrom(props.env));
    const [nextKey, setNextKey] = React.useState(rows.length);

    const [validationError, setValidationError] = React.useState<string | null>(
        null,
    );

    const [savedMessage, setSavedMessage] = React.useState<string | null>(null);

    const saveMutation = useMutation({
        mutationFn: (env: { [name in string]: string }) =>
            api.updateTerminalEnv(props.agentId, { env }),
        onSuccess: async (response) => {
            setRows(rowsFrom(response.env));
            setNextKey(Object.keys(response.env).length);
            setSavedMessage(
                "Saved. New terminals on this device get these variables.",
            );
            await queryClient.invalidateQueries({
                queryKey: queryKeys.agentConfiguration(props.agentId),
            });
        },
    });

    const updateRow = (key: number, change: Partial<EnvRow>) => {
        setValidationError(null);
        saveMutation.reset();
        setRows((current) =>
            current.map((row) =>
                row.key === key ? { ...row, ...change } : row,
            ),
        );
    };

    const save = () => {
        const result = envFrom(rows);

        if ("error" in result) {
            setValidationError(result.error);

            return;
        }

        saveMutation.mutate(result.env);
    };

    const errorMessage =
        validationError ??
        (saveMutation.isError
            ? getErrorMessage(
                  saveMutation.error,
                  "Failed to save the variables",
              )
            : null);

    return (
        <section
            aria-labelledby="terminal-env-heading"
            className="border-b border-slate-800 px-6 py-6 @xl:px-8"
        >
            <h2
                id="terminal-env-heading"
                className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-300"
            >
                <SquareTerminal className="h-4 w-4" aria-hidden="true" />
                Terminal environment
            </h2>
            <p className="mt-3 text-sm text-slate-400">
                Variables set in every terminal opened on this device. Open
                terminals keep their environment. REDOOR_SERVER is always set to
                this server's hostname.
            </p>
            <form
                className="mt-4 flex flex-col gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    save();
                }}
            >
                {rows.length === 0 ? (
                    <p className="text-sm text-slate-500">No variables yet.</p>
                ) : null}
                {rows.map((row, index) => (
                    <div
                        key={row.key}
                        className="flex flex-wrap items-center gap-2 @xl:flex-nowrap"
                    >
                        <InputControl
                            aria-label={`Name of variable ${index + 1}`}
                            value={row.name}
                            placeholder="NAME"
                            autoComplete="off"
                            spellCheck={false}
                            disabled={saveMutation.isPending}
                            onChange={(event) =>
                                updateRow(row.key, { name: event.target.value })
                            }
                            className="w-full font-mono text-sm placeholder:text-slate-600 @xl:w-56"
                        />
                        <InputControl
                            aria-label={`Value of variable ${index + 1}`}
                            value={row.value}
                            placeholder="value"
                            autoComplete="off"
                            spellCheck={false}
                            disabled={saveMutation.isPending}
                            onChange={(event) =>
                                updateRow(row.key, {
                                    value: event.target.value,
                                })
                            }
                            className="min-w-0 flex-1 font-mono text-sm placeholder:text-slate-600"
                        />
                        <IconButton
                            type="button"
                            variant="ghost"
                            size="lg"
                            label={`Remove variable ${index + 1}`}
                            tooltip={
                                row.name.trim() === ""
                                    ? "Remove this variable"
                                    : `Remove ${row.name.trim()}`
                            }
                            disabled={saveMutation.isPending}
                            onClick={() => {
                                setValidationError(null);
                                saveMutation.reset();
                                setRows((current) =>
                                    current.filter(
                                        (candidate) =>
                                            candidate.key !== row.key,
                                    ),
                                );
                            }}
                        >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                    </div>
                ))}
                {errorMessage ? (
                    <p role="alert" className="text-sm text-red-300">
                        {errorMessage}
                    </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        tooltip="Add a row for another variable"
                        disabled={saveMutation.isPending}
                        onClick={() => {
                            setRows((current) => [
                                ...current,
                                { key: nextKey, name: "", value: "" },
                            ]);
                            setNextKey(nextKey + 1);
                        }}
                    >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        Add variable
                    </Button>
                    <Button
                        type="submit"
                        size="sm"
                        tooltip="Save the variables for terminals opened from now on; the agent keeps running"
                        disabled={saveMutation.isPending}
                    >
                        {saveMutation.isPending
                            ? "Saving variables..."
                            : "Save variables"}
                    </Button>
                </div>
            </form>
            {savedMessage ? (
                <Toast tone="success" onDismiss={() => setSavedMessage(null)}>
                    {savedMessage}
                </Toast>
            ) : null}
        </section>
    );
}
