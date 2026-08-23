import { File, Folder, X } from "lucide-react";
import type { SelectedPath } from "#ui/selected-files";
import { IconButton } from "#ui/components/icon-button";

/** Makes the exact selected paths visible before a bulk filesystem operation. */
export function AffectedPathsList(props: {
    paths: SelectedPath[];
    onDeselect: (path: SelectedPath) => void;
}) {
    return (
        <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Affected items ({props.paths.length})
            </p>
            <ul className="mt-2 max-h-52 space-y-1 overflow-y-auto rounded-md border border-slate-800 bg-slate-950/50 p-2">
                {props.paths.map((path) => (
                    <li
                        key={`${path.agentId}:${path.path}`}
                        className="flex min-w-0 items-start gap-2 rounded px-2 py-1.5 text-sm text-slate-300"
                    >
                        {path.entryType === "directory" ? (
                            <Folder
                                className="mt-0.5 h-4 w-4 shrink-0 text-blue-400"
                                aria-hidden="true"
                            />
                        ) : (
                            <File
                                className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                                aria-hidden="true"
                            />
                        )}
                        <span className="min-w-0 flex-1">
                            <span className="block break-all">{path.path}</span>
                            <span className="block truncate text-xs text-slate-500">
                                {path.agentName}
                            </span>
                        </span>
                        <IconButton
                            type="button"
                            label={`Deselect ${path.fileName}`}
                            onClick={() => props.onDeselect(path)}
                            className="h-7 w-7 shrink-0 rounded text-slate-500 hover:bg-white/5 hover:text-slate-200"
                        >
                            <X className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                    </li>
                ))}
            </ul>
        </div>
    );
}
