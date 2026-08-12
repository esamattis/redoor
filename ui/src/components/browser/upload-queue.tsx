import { useAtomValue } from "jotai";
import { Clock3 } from "lucide-react";
import { uploadQueueAtom } from "#ui/upload-queue";

/** Shows only uploads waiting for a scheduler slot above their destination file list. */
export function UploadQueue(props: {
    agentId: string;
    destinationPath: string;
}) {
    const queue = useAtomValue(uploadQueueAtom);
    const items = queue.items.filter(
        (item) =>
            item.agentId === props.agentId &&
            item.destinationPath === props.destinationPath &&
            item.status === "waiting",
    );

    if (items.length === 0) {
        return null;
    }

    return (
        <section
            aria-labelledby="upload-queue-heading"
            className="mb-3 overflow-hidden rounded-lg border border-slate-800 bg-[#11141b]"
        >
            <div className="border-b border-slate-800 bg-slate-900/35 px-4 py-3">
                <h2
                    id="upload-queue-heading"
                    className="text-sm font-semibold text-slate-100"
                >
                    Upload queue ({items.length} waiting)
                </h2>
            </div>
            <ol>
                {items.map((item) => (
                    <li
                        key={item.id}
                        className="flex items-center gap-3 border-b border-slate-800 px-4 py-3 last:border-b-0"
                    >
                        <Clock3 className="h-4 w-4 shrink-0 text-slate-500" />
                        <p className="min-w-0 flex-1 break-all font-mono text-sm text-slate-200">
                            {item.relativePath}
                        </p>
                    </li>
                ))}
            </ol>
        </section>
    );
}
