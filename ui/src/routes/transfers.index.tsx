import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeftRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Route as RootRoute } from "./__root";
import { TransferList } from "#ui/components/transfer-list";
import { transfersQueryOptions } from "#ui/queries";

export const Route = createFileRoute("/transfers/")({
    component: TransfersPage,
});

function TransfersPage() {
    const { agents, transferProgress: initialTransferProgress } =
        RootRoute.useLoaderData();
    const { api } = RootRoute.useRouteContext();
    const { data: transferProgress } = useQuery({
        ...transfersQueryOptions(api),
        initialData: initialTransferProgress,
    });

    return (
        <div className="p-4 sm:p-8">
            <div className="mx-auto max-w-7xl">
                <div className="mb-6 flex items-center gap-3">
                    <ArrowLeftRight className="h-6 w-6 shrink-0 text-blue-400" />
                    <h1 className="text-2xl font-bold text-slate-100">
                        Transfer history
                    </h1>
                </div>
                <div className="overflow-hidden rounded-lg border border-slate-800">
                    <TransferList
                        agents={agents}
                        transfers={transferProgress.transfers}
                    />
                </div>
            </div>
        </div>
    );
}
