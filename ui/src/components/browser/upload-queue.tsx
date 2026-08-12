import { useAtomValue } from "jotai";
import { Check, Clock3, LoaderCircle } from "lucide-react";
import { uploadQueueAtom } from "#ui/upload-queue";

/** Shows durable page-lifetime scheduling state without duplicating transfer progress. */
export function UploadQueueView(props: {
    agentId: string;
    destinationPath: string;
}) {
    const queue = useAtomValue(uploadQueueAtom);
    const items = queue.items.filter(
        (item) =>
            item.agentId === props.agentId &&
            item.destinationPath === props.destinationPath,
    );

    if (items.length === 0) {
        return (
            <div className="rounded-lg border border-slate-800 bg-[#11141b] p-8 text-center">
                <h2 className="text-lg font-semibold text-slate-100">
                    Upload queue
                </h2>
                <p className="mt-2 text-sm text-slate-400">
                    No files are queued for this directory.
                </p>
            </div>
        );
    }

    const uploadingCount = items.filter(
        (item) => item.status === "uploading",
    ).length;
    const doneCount = items.filter((item) => item.status === "done").length;

    return (
        <section aria-labelledby="upload-queue-heading">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h2
                        id="upload-queue-heading"
                        className="text-lg font-semibold text-slate-100"
                    >
                        Upload queue
                    </h2>
                    <p className="mt-1 text-sm text-slate-400">
                        {doneCount} of {items.length} done
                    </p>
                </div>
                <p className="text-sm text-slate-400">
                    {uploadingCount} uploading
                </p>
            </div>
            <ol className="overflow-hidden rounded-lg border border-slate-800 bg-[#11141b]">
                {items.map((item) => (
                    <li
                        key={item.id}
                        className="flex items-center gap-3 border-b border-slate-800 px-4 py-3 last:border-b-0"
                    >
                        {item.status === "waiting" ? (
                            <Clock3 className="h-4 w-4 shrink-0 text-slate-500" />
                        ) : item.status === "uploading" ? (
                            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-blue-400" />
                        ) : (
                            <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                        )}
                        <div className="min-w-0 flex-1">
                            <p className="break-all font-mono text-sm text-slate-200">
                                {item.relativePath}
                            </p>
                            {item.error ? (
                                <p
                                    role="alert"
                                    className="mt-1 text-sm text-red-400"
                                >
                                    {item.error}
                                </p>
                            ) : null}
                        </div>
                        <span className="shrink-0 text-sm capitalize text-slate-400">
                            {item.status}
                        </span>
                    </li>
                ))}
            </ol>
        </section>
    );
}
