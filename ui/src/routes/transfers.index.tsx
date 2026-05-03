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
        <div className="p-6">
            <div className="max-w-7xl mx-auto">
                <div className="flex items-center gap-3 mb-6">
                    <ArrowLeftRight className="h-6 w-6 text-blue-600" />
                    <h1 className="text-2xl font-bold text-gray-900">
                        Transfer history
                    </h1>
                </div>
                <div className="border rounded-lg overflow-hidden">
                    <TransferList
                        agents={agents}
                        transfers={transferProgress.transfers}
                    />
                </div>
            </div>
        </div>
    );
}
