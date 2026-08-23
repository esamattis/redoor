import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { TrashListResponse } from "#bindings/TrashListResponse";
import type { Agent } from "#ui/api-client";
import { Checkbox } from "#ui/components/checkbox";
import { ConfirmationDialog } from "#ui/components/confirmation-dialog";
import { getErrorMessage } from "#ui/components/browser/utils";
import { TextField } from "#ui/components/text-field";
import { queryKeys } from "#ui/queries";

export type DeletePathTarget = {
    agent: Agent | null;
    path: string;
};

/** Recognizes payload paths from inventory cached when the user opened the Trash page. */
function isTrashPayloadPath(
    target: DeletePathTarget,
    queryClient: ReturnType<typeof useQueryClient>,
): boolean {
    if (!target.agent) return false;
    const trash = queryClient.getQueryData<TrashListResponse>(
        queryKeys.trash(target.agent.id),
    );
    return (
        trash?.locations.some((location) => {
            const root = `${location.path.replace(/\/+$/, "")}/files`;
            return target.path === root || target.path.startsWith(`${root}/`);
        }) ?? false
    );
}

/** Centralizes trash and permanent-delete behavior for every filesystem delete surface. */
export function DeletePathsDialog(props: {
    isOpen: boolean;
    title: string;
    description: React.ReactNode;
    targets: DeletePathTarget[];
    trashConfirmLabel: string;
    permanentConfirmLabel: string;
    requiredConfirmationText?: string;
    children?: React.ReactNode;
    onClose: () => void;
    onDeleted: (targets: DeletePathTarget[]) => void | Promise<void>;
}) {
    const queryClient = useQueryClient();
    const canTrash = props.targets.every(
        (target) =>
            target.agent?.supportsMoveToTrash === true &&
            !isTrashPayloadPath(target, queryClient),
    );
    const [deletePermanently, setDeletePermanently] = React.useState(!canTrash);
    const [confirmationText, setConfirmationText] = React.useState("");
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
        setConfirmationText("");
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
                    : "These items cannot be moved to trash. This action will delete permanently."
            }
            confirmLabel={
                deletePermanently
                    ? props.permanentConfirmLabel
                    : props.trashConfirmLabel
            }
            busyLabel={`${operationLabel}...`}
            isBusy={mutation.isPending}
            confirmDisabled={
                props.requiredConfirmationText !== undefined &&
                confirmationText !== props.requiredConfirmationText
            }
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
            {props.requiredConfirmationText !== undefined ? (
                <TextField
                    label={`Type ${props.requiredConfirmationText} to confirm`}
                    value={confirmationText}
                    placeholder={props.requiredConfirmationText}
                    description="This confirmation is case-sensitive."
                    required
                    autoComplete="off"
                    disabled={mutation.isPending}
                    onChange={setConfirmationText}
                    className="mt-4"
                />
            ) : null}
            {canTrash ? (
                <Checkbox
                    checked={deletePermanently}
                    role="checkbox"
                    label="Delete permanently"
                    disabled={mutation.isPending}
                    className="mt-4"
                    onCheckedChange={(checked) => {
                        setDeletePermanently(checked);
                        mutation.reset();
                    }}
                >
                    Delete permanently
                </Checkbox>
            ) : null}
        </ConfirmationDialog>
    );
}
