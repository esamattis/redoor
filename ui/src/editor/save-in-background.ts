import type { QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "#ui/api-client";
import {
    fileContentQueryOptions,
    findCachedAgent,
    queryKeys,
} from "#ui/queries";
import { getOpenFileKey, type UserState } from "#ui/user-state";
import { isVaultPath } from "#ui/vault/vault-path";
import type { EditorWorkspace } from "./editor-workspace";

/**
 * Saves open files that are not shown, for Vim's `:wall`. Their editors are not mounted, so
 * this writes the buffer text itself, the way a mounted editor's save does. Files it cannot
 * save safely are left dirty and named in the returned message instead: an encrypted file
 * needs the vault key its own editor asks for, and a file changed on the device needs the
 * user to choose which text wins.
 */
export async function saveFilesInBackground(
    context: {
        api: ApiClient;
        queryClient: QueryClient;
        editor: EditorWorkspace;
    },
    keys: readonly string[],
): Promise<string> {
    const openFiles =
        context.queryClient.getQueryData<UserState>(queryKeys.userState())
            ?.openFiles ?? [];

    const statuses = context.editor.getSnapshot();
    const notSaved: string[] = [];
    let savedCount = 0;

    await Promise.all(
        keys.map(async (key) => {
            const file = openFiles.find(
                (entry) => getOpenFileKey(entry) === key,
            );

            if (file === undefined) {
                return;
            }

            if (isVaultPath(file.path)) {
                notSaved.push(
                    `${file.name} (encrypted, save it in its editor)`,
                );

                return;
            }

            if ((statuses.get(key)?.conflict ?? null) !== null) {
                notSaved.push(`${file.name} (changed on the device)`);

                return;
            }

            const agent = findCachedAgent(
                context.queryClient,
                context.api,
                file.agentId,
            );

            if (agent === undefined) {
                notSaved.push(`${file.name} (device not found)`);

                return;
            }

            const text = context.editor.text(key);

            try {
                await agent.editFile(
                    file.path,
                    new globalThis.File([text], file.name, {
                        type: "text/plain",
                    }),
                );
            } catch {
                notSaved.push(`${file.name} (save failed)`);

                return;
            }

            const query = fileContentQueryOptions(agent, file.path);
            // A read that started before the write would bring back the old text as if the
            // device had changed it; the buffer learns its new base before the cache update.
            await context.queryClient.cancelQueries({
                queryKey: query.queryKey,
            });
            context.editor.rebase(key, text);
            context.queryClient.setQueryData(query.queryKey, text);
            savedCount += 1;
        }),
    );

    const saved = `Saved ${String(savedCount)} other ${savedCount === 1 ? "file" : "files"}`;

    return notSaved.length === 0
        ? saved
        : `${saved}. Not saved: ${notSaved.join(", ")}`;
}
