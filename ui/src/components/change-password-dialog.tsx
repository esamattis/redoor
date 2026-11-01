import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";

import { Button } from "#ui/components/button";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { Password } from "#ui/components/password";
import { Toast } from "#ui/components/toast";
import { getErrorMessage } from "#ui/utils/error";

const rootRouteApi = getRouteApi("__root__");

/**
 * Shortest new password, mirroring the server's `MIN_NEW_PASSWORD_CHARS` so the form can
 * explain the rule before a round trip; the server still enforces it.
 */
const MIN_PASSWORD_CHARS = 8;

/**
 * Opens the password change dialog and reports the outcome in a toast, which has to live
 * outside the dialog because the dialog closes on success.
 */
export function ChangePasswordButton() {
    const [isOpen, setIsOpen] = React.useState(false);
    const [changed, setChanged] = React.useState(false);

    return (
        <>
            <Button
                type="button"
                variant="secondary"
                size="sm"
                tooltip="Change the login password stored in the config file"
                onClick={() => setIsOpen(true)}
            >
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                Change password
            </Button>
            {isOpen ? (
                <ChangePasswordDialog
                    onClose={() => setIsOpen(false)}
                    onChanged={() => {
                        setIsOpen(false);
                        setChanged(true);
                    }}
                />
            ) : null}
            {changed ? (
                <Toast tone="success" onDismiss={() => setChanged(false)}>
                    Password changed. Other browsers signed in with the old
                    password were signed out.
                </Toast>
            ) : null}
        </>
    );
}

/**
 * Changes the TOML-configured login password. The current password is asked again so a
 * browser left signed in cannot be used to take over the account, and the new one is typed
 * twice because a typo would lock the user out.
 */
export function ChangePasswordDialog(props: {
    onClose: () => void;
    onChanged: () => void;
}) {
    const { api } = rootRouteApi.useRouteContext();
    const [currentPassword, setCurrentPassword] = React.useState("");
    const [newPassword, setNewPassword] = React.useState("");
    const [repeated, setRepeated] = React.useState("");

    const change = useMutation({
        mutationFn: () => api.changePassword(currentPassword, newPassword),
        onSuccess: props.onChanged,
    });

    // Counted in code points like the server's Rust `chars()`, not UTF-16 units.
    const tooShort = Array.from(newPassword).length < MIN_PASSWORD_CHARS;
    const mismatch = repeated !== "" && repeated !== newPassword;

    const canSubmit =
        currentPassword !== "" && !tooShort && repeated === newPassword;

    return (
        <Dialog
            isOpen
            title="Change password"
            description="The new password is stored in the config file as an Argon2 hash."
            closeAriaLabel="Cancel"
            isBusy={change.isPending}
            errorMessage={
                change.isError
                    ? getErrorMessage(change.error, "Failed to change password")
                    : null
            }
            onClose={props.onClose}
        >
            <form
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();

                    if (canSubmit) {
                        change.mutate();
                    }
                }}
                className="mt-4 grid gap-4"
            >
                <Password
                    label="Current password"
                    value={currentPassword}
                    autoComplete="current-password"
                    required
                    disabled={change.isPending}
                    onChange={setCurrentPassword}
                />
                <Password
                    label="New password"
                    value={newPassword}
                    autoComplete="new-password"
                    required
                    description={`At least ${MIN_PASSWORD_CHARS} characters. Other browsers are signed out.`}
                    disabled={change.isPending}
                    onChange={setNewPassword}
                />
                <Password
                    label="Repeat new password"
                    value={repeated}
                    autoComplete="new-password"
                    required
                    description={
                        mismatch ? "The passwords do not match." : undefined
                    }
                    disabled={change.isPending}
                    onChange={setRepeated}
                />
                <DialogActions stackOnMobile>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={props.onClose}
                        disabled={change.isPending}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        isLoading={change.isPending}
                        disabled={!canSubmit}
                    >
                        Change password
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}
