import * as React from "react";

import { Button } from "#ui/components/button";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { TextField } from "#ui/components/text-field";
import { focusAndSelectFileNameStem } from "#ui/utils/file-name";
import { validatePathComponent } from "#ui/utils/path";
import type { PathComponentKind } from "#ui/utils/path";

/** What the dialog needs from a mutation, so each caller keeps its own request and result. */
type NameSubmission = {
    isPending: boolean;
    error: Error | null;
    reset: () => void;
    mutate: (name: string) => void;
};

/**
 * One "enter a name" workflow behind rename, duplicate, new file and new directory, so they
 * validate and behave alike. The caller supplies the request through `mutation` and mounts
 * the dialog only while it is open, which gives every opening a fresh name and error without
 * an effect that resets state.
 */
export function PathNameDialog(props: {
    title: string;
    description: string;
    closeAriaLabel: string;
    /** Words the validation messages as a file or directory name. */
    kind: PathComponentKind;
    fieldLabel: string;
    /** Names the field for assistive technology when the visible label is only a prompt. */
    fieldAriaLabel?: string;
    placeholder: string;
    fieldDescription: string;
    initialName: string;
    /** Rename and duplicate need a different name; creation starts from an empty one. */
    requireChange?: boolean;
    /** Directory creation may name several levels, as the agent creates every parent. */
    allowNested?: boolean;
    /** Opens with the name's stem selected for replacing, instead of an empty autofocused field. */
    selectNameStem?: boolean;
    /** Shows where the entered name will land, for dialogs that create new entries. */
    preview?: { label: string; pathFor: (name: string) => string };
    /** Disables the form with an explanation, such as for the filesystem root. */
    unavailableMessage?: string | null;
    submitLabel: string;
    busyLabel: string;
    submitIcon: React.ReactNode;
    mutation: NameSubmission;
    onClose: () => void;
}) {
    const [name, setName] = React.useState(props.initialName);

    const [validationError, setValidationError] = React.useState<string | null>(
        null,
    );

    const trimmedName = name.trim();
    const isPending = props.mutation.isPending;
    const isUnavailable =
        props.unavailableMessage !== null &&
        props.unavailableMessage !== undefined;

    const isUnchanged =
        props.requireChange === true &&
        (trimmedName === "" || trimmedName === props.initialName);

    const previewPath =
        props.preview && trimmedName !== ""
            ? props.preview.pathFor(trimmedName)
            : null;

    /** Applies the shared name rules before any request is made. */
    const submit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (
            props.unavailableMessage !== null &&
            props.unavailableMessage !== undefined
        ) {
            setValidationError(props.unavailableMessage);

            return;
        }

        const nameError = validatePathComponent(trimmedName, props.kind, {
            allowNested: props.allowNested,
        });

        if (nameError !== null) {
            setValidationError(nameError);

            return;
        }

        if (isUnchanged) {
            return;
        }

        setValidationError(null);
        props.mutation.mutate(trimmedName);
    };

    /** Keeps an in-flight request attached to its visible status. */
    const close = () => {
        if (!isPending) {
            props.onClose();
        }
    };

    return (
        <Dialog
            isOpen={true}
            title={props.title}
            description={props.description}
            closeAriaLabel={props.closeAriaLabel}
            isBusy={isPending}
            errorMessage={
                validationError ?? props.mutation.error?.message ?? null
            }
            onClose={close}
        >
            <form noValidate onSubmit={submit} className="mt-4">
                <TextField
                    label={props.fieldLabel}
                    codeMode
                    ariaLabel={props.fieldAriaLabel}
                    inputRef={
                        props.selectNameStem === true
                            ? focusAndSelectFileNameStem
                            : undefined
                    }
                    value={name}
                    placeholder={props.placeholder}
                    description={props.fieldDescription}
                    required
                    autoFocus={props.selectNameStem !== true}
                    disabled={isPending || isUnavailable}
                    onChange={(value) => {
                        setName(value);
                        setValidationError(null);
                        props.mutation.reset();
                    }}
                />
                {previewPath !== null && props.preview ? (
                    <div className="mt-4">
                        <p className="mb-2 text-sm text-slate-400">
                            {props.preview.label}
                        </p>
                        <p className="break-all rounded bg-canvas px-3 py-2 font-mono text-sm text-slate-300">
                            {previewPath}
                        </p>
                    </div>
                ) : null}
                <DialogActions>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={close}
                        disabled={isPending}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        disabled={isUnchanged || isUnavailable}
                        isLoading={isPending}
                        className="font-semibold"
                    >
                        {props.submitIcon}
                        {isPending ? props.busyLabel : props.submitLabel}
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}
