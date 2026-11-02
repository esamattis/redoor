import * as React from "react";
import { getRouteApi } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";

import type { Agent } from "#ui/api-client";
import { agentsQueryOptions } from "#ui/queries";
import { handOverWaitingSshKey } from "#ui/vault/ssh-key-vault";

const rootRouteApi = getRouteApi("__root__");

/**
 * Hands every device that waits for its vault-encrypted SSH key the key, while this tab's
 * vault is unlocked.
 *
 * A server restart starts the devices that were running, but it no longer holds their
 * encrypted keys, so those wait until a browser brings each key. Each device is tried once
 * per wait: a key the server still refuses stays waiting and is not retried in a loop.
 */
export function useHandOverWaitingSshKeys() {
    const { api, vault } = rootRouteApi.useRouteContext();

    const vaultState = React.useSyncExternalStore(
        vault.subscribe,
        vault.getSnapshot,
    );

    const { data: agents } = useQuery(agentsQueryOptions(api));
    const attempted = React.useRef(new Set<string>());

    const handOver = useMutation({
        mutationFn: async (agent: Agent) => {
            const unlocked = vault.current();

            // The vault locked meanwhile; the device keeps waiting for a manual start.
            if (unlocked === null) {
                return;
            }

            await handOverWaitingSshKey({ agent, api, vault: unlocked });
        },
    });

    const { mutate } = handOver;

    React.useEffect(() => {
        if (agents === undefined) {
            return;
        }

        const waiting = new Set(
            agents.flatMap((info) =>
                info.waiting_for_ssh_key ? [info.id] : [],
            ),
        );

        // A device that stopped waiting may wait again later, for example after the next
        // server restart, and then gets another try.
        for (const id of attempted.current) {
            if (!waiting.has(id)) {
                attempted.current.delete(id);
            }
        }

        if (vaultState.status !== "unlocked") {
            return;
        }

        for (const info of agents) {
            if (!info.waiting_for_ssh_key || attempted.current.has(info.id)) {
                continue;
            }

            attempted.current.add(info.id);
            mutate(api.agentFor(info));
        }
    }, [agents, api, mutate, vaultState.status]);
}
