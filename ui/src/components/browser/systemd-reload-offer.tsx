import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { Agent } from "#ui/api-client";
import type { SystemdScope } from "#bindings/SystemdScope";
import { Button } from "#ui/components/button";
import { Toast } from "#ui/components/toast";
import { queryKeys } from "#ui/queries";
import { getErrorMessage } from "#ui/utils/error";
import {
    shouldCheckSystemdAfterSave,
    systemdReloadedMessage,
    systemdReloadLabel,
    systemdReloadOffer,
    systemdScopeKey,
    withoutSystemdScope,
    type SystemdReloadOffer,
} from "#ui/utils/systemd-reload-offer";

/**
 * Asks systemd after a save whether it still runs the old version of a unit file, and offers
 * the daemon-reload that makes it read the new one. Without it, an edited unit silently keeps
 * its previous settings until someone remembers to reload.
 *
 * `checkAfterSave` is called from the save's success, never from an effect, so the check
 * follows the write that made it necessary.
 */
export function useSystemdReloadOffer(props: {
    agent: Agent;
    filePath: string;
    /** False for revisions and encrypted files, which systemd never reads. */
    enabled: boolean;
}) {
    const queryClient = useQueryClient();
    const [offer, setOffer] = React.useState<SystemdReloadOffer | null>(null);
    // Restarts the toast (and its dismiss timer) for every new answer, even an identical one.
    const [offerId, setOfferId] = React.useState(0);

    const reloadMutation = useMutation({
        mutationFn: (scope: SystemdScope) =>
            props.agent.systemdDaemonReload(scope),
        onSuccess: (_response, scope) => {
            setOffer((current) =>
                current === null ? null : withoutSystemdScope(current, scope),
            );
            // Unit states, `need_daemon_reload` and unit lists all come from the reloaded
            // manager, so every systemd view of this agent may now be out of date.
            void queryClient.invalidateQueries({
                queryKey: queryKeys.systemd(props.agent.id),
            });
        },
    });

    const resetReload = reloadMutation.reset;
    const agent = props.agent;
    const filePath = props.filePath;
    const enabled = props.enabled;

    const checkAfterSave = React.useCallback(() => {
        if (!enabled || !shouldCheckSystemdAfterSave(filePath, agent.systemd)) {
            return;
        }

        const queryKey = queryKeys.systemdPathStatus(agent.id, filePath);

        void (async () => {
            try {
                // An answer to an earlier save may predate this write, so only the latest counts.
                await queryClient.cancelQueries({ queryKey });

                const response = await queryClient.fetchQuery({
                    queryKey,
                    queryFn: ({ signal }) =>
                        agent.systemdPathStatus(filePath, { signal }),
                    staleTime: 0,
                    // The answer is only true for the save that asked; keeping it would let a
                    // later save start from a stale reload state.
                    gcTime: 0,
                    retry: false,
                });

                setOfferId((id) => id + 1);
                resetReload();
                setOffer(systemdReloadOffer(response));
            } catch {
                // The file is saved either way. A device that cannot tell (no permission,
                // systemd gone, a timeout, or a newer save cancelling this check) just gets
                // no offer instead of an error about something the user did not ask for.
            }
        })();
    }, [agent, enabled, filePath, queryClient, resetReload]);

    const dismiss = React.useCallback(() => {
        setOffer(null);
        resetReload();
    }, [resetReload]);

    const toast =
        offer === null || offer.path !== props.filePath ? null : (
            <SystemdReloadToast
                // A new phase gets a fresh dismiss timer, so the result of a slow reload is
                // still on screen long enough to read.
                key={`${offerId}-${reloadMutation.status}`}
                offer={offer}
                reloading={
                    reloadMutation.isPending ? reloadMutation.variables : null
                }
                result={
                    reloadMutation.isSuccess
                        ? {
                              tone: "success",
                              message: systemdReloadedMessage(
                                  reloadMutation.variables,
                              ),
                          }
                        : reloadMutation.isError
                          ? {
                                tone: "error",
                                message: `Could not reload systemd: ${getErrorMessage(
                                    reloadMutation.error,
                                    "Unknown error",
                                )}`,
                            }
                          : null
                }
                onReload={(scope) => reloadMutation.mutate(scope)}
                onDismiss={dismiss}
            />
        );

    return { checkAfterSave, toast };
}

/**
 * One toast for the whole offer: the reload result replaces the question, and any manager
 * still pending keeps its button, so a failed reload can be retried from the same place.
 */
function SystemdReloadToast(props: {
    offer: SystemdReloadOffer;
    reloading: SystemdScope | null;
    result: { tone: "success" | "error"; message: string } | null;
    onReload: (scope: SystemdScope) => void;
    onDismiss: () => void;
}) {
    const reloadingKey =
        props.reloading === null ? null : systemdScopeKey(props.reloading);

    const action =
        props.offer.scopes.length === 0
            ? undefined
            : props.offer.scopes.map((scope) => (
                  <Button
                      key={systemdScopeKey(scope)}
                      type="button"
                      variant="secondary"
                      size="sm"
                      isLoading={reloadingKey === systemdScopeKey(scope)}
                      disabled={reloadingKey !== null}
                      tooltip={
                          scope.type === "system"
                              ? "Run systemctl daemon-reload so systemd reads the changed unit files"
                              : `Run systemctl --user daemon-reload for ${scope.name} so their systemd reads the changed unit files`
                      }
                      onClick={() => props.onReload(scope)}
                  >
                      {systemdReloadLabel(scope)}
                  </Button>
              ));

    return (
        <Toast
            tone={props.result?.tone ?? "info"}
            icon={<RefreshCw className="h-4 w-4" />}
            dismissAriaLabel="Dismiss systemd reload message"
            action={action}
            onDismiss={props.onDismiss}
        >
            {props.result?.message ?? props.offer.message}
        </Toast>
    );
}
