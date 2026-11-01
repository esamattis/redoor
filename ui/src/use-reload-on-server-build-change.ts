import * as React from "react";
import { hashKey, useQueryClient } from "@tanstack/react-query";

import type { ServerInfoResponse } from "#bindings/ServerInfoResponse";
import { queryKeys } from "#ui/queries";

/** Set once the page started reloading onto a new server build. */
let reloadingForNewBuild = false;

/**
 * Whether this page is about to be replaced by a reload onto a new server build. Work that
 * finishes in the meantime, such as the update dialog's wait, must leave state meant for
 * the reloaded page alone: a reload does not stop scripts until the page unloads.
 */
export function isReloadingForNewBuild(): boolean {
    return reloadingForNewBuild;
}

/** The fields that change when the server runs another binary, but not on a plain restart. */
function buildIdentity(info: ServerInfoResponse): string {
    return [
        info.version,
        info.git_rev,
        info.git_dirty,
        info.version_dirty,
        info.build_mode,
        info.build_date,
    ].join("|");
}

/**
 * Reloads the page once the server runs another build, such as after an update from the UI
 * or `redoor upgrade` on the command line.
 *
 * The page's code came from the old build: its lazily loaded chunks no longer exist on the
 * new server, and its requests may no longer match the new API, which leaves views spinning
 * until the user reloads by hand. The server info is refetched after every server restart,
 * so watching its cache entry catches every update.
 */
export function useReloadOnServerBuildChange() {
    const queryClient = useQueryClient();

    React.useEffect(() => {
        let loadedBuild: string | null = null;

        /** Compares the cached server info with the build this page started on. */
        const check = () => {
            const info = queryClient.getQueryData<ServerInfoResponse>(
                queryKeys.serverInfo(),
            );

            if (!info) return;

            const build = buildIdentity(info);

            if (loadedBuild === null) {
                loadedBuild = build;

                return;
            }

            if (build !== loadedBuild && !reloadingForNewBuild) {
                reloadingForNewBuild = true;
                window.location.reload();
            }
        };

        check();

        return queryClient.getQueryCache().subscribe((event) => {
            if (
                event.type === "updated" &&
                event.query.queryHash === hashKey(queryKeys.serverInfo())
            ) {
                check();
            }
        });
    }, [queryClient]);
}
