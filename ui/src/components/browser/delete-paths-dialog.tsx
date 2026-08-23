import * as React from "react";
import { useMutation } from "@tanstack/react-query";

import type { Agent } from "#ui/api-client";
import { Checkbox } from "#ui/components/checkbox";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { getErrorMessage } from "#ui/components/browser/utils";

export type DeletePathTarget = {
    agent: Agent | null;
    path: string;
};

/** Centralizes trash and permanent-delete behavior for every filesystem delete surface. */
export function DeletePathsDialog(props: {
    isOpen: boolean;
    title: string;
    description: React.ReactNode;
    targets: DeletePathTarget[];
    trashConfirmLabel: string;
    permanentConfirmLabel: string;
    children?: React.ReactNode;
    onClose: () => void;
    onDeleted: (targets: DeletePathTarget[]) => void | Promise<void>;
}) {
    const canTrash = props.targets.every(
        (target) => target.agent?.supportsMoveToTrash === true,
    );
    const [deletePermanently, setDeletePermanently] = React.useState(!canTrash);
    const mutation = useMutation({
        mutationFn: async (targets: DeletePathTarget[]) => {
            const results = await Promise.allSettled(
                targets.map((target) => {
                    if (!target.agent) {
                        return Promise.reject(
                            new Error("Agent unavailable for selected item"),
                        );
                    }
                    return target.agent.deleteFile(target.path, {
                        trash: !deletePermanently,
                    });
                }),
            );
            const successfulTargets = targets.filter(
                (_target, index) => results[index]?.status === "fulfilled",
            );
            const failures = results.filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected",
            );

            if (successfulTargets.length > 0) {
                await props.onDeleted(successfulTargets);
            }
            if (failures.length > 0) {
                const operation = deletePermanently ? "Deleted" : "Trashed";
                const fallback = deletePermanently
                    ? "Delete failed"
                    : "Move to trash failed";
                const message = getErrorMessage(failures[0]?.reason, fallback);
                throw new Error(
                    successfulTargets.length > 0
                        ? `${operation} ${successfulTargets.length} of ${targets.length} items. ${message}`
                        : message,
                );
            }
        },
        onSuccess: props.onClose,
    });

    React.useEffect(() => {
        if (!props.isOpen) return;
        setDeletePermanently(!canTrash);
        mutation.reset();
    }, [props.isOpen, canTrash]);

    /** Keeps an in-flight filesystem operation attached to its visible status. */
    const close = () => {
        if (!mutation.isPending) props.onClose();
    };

    const operationLabel = deletePermanently ? "Deleting" : "Moving to trash";
    return (
        <ConfirmationDialog
            isOpen={props.isOpen}
            title={props.title}
            description={
                canTrash
                    ? props.description
                    : "Trash is unavailable for one or more selected agents. This action will delete permanently."
            }
            confirmLabel={
                deletePermanently
                    ? props.permanentConfirmLabel
                    : props.trashConfirmLabel
            }
            busyLabel={`${operationLabel}...`}
            isBusy={mutation.isPending}
            errorMessage={
                mutation.isError
                    ? getErrorMessage(
                          mutation.error,
                          deletePermanently
                              ? "Delete failed"
                              : "Move to trash failed",
                      )
                    : null
            }
            onClose={close}
            onConfirm={() => mutation.mutate(props.targets)}
        >
            {props.children}
            <Checkbox
                checked={deletePermanently}
                role="checkbox"
                label="Delete permanently"
                disabled={mutation.isPending || !canTrash}
                className="mt-4"
                onCheckedChange={(checked) => {
                    setDeletePermanently(checked);
                    mutation.reset();
                }}
            >
                Delete permanently
            </Checkbox>
        </ConfirmationDialog>
    );
}
