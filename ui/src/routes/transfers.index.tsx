import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeftRight } from "lucide-react";

import { Route as RootRoute } from "./__root";
import { TransferList } from "../components/transfer-list";

export const Route = createFileRoute("/transfers/")({
    component: TransfersPage,
});

function TransfersPage() {
    const { agents, transferProgress } = RootRoute.useLoaderData();

    return (
        <div className="p-8">
            <div className="mx-auto max-w-7xl">
                <div className="mb-6 flex items-center gap-3">
                    <ArrowLeftRight className="h-6 w-6 text-blue-400" />
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
