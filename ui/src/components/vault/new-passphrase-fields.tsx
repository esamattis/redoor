import { TriangleAlert } from "lucide-react";

import { Password } from "#ui/components/password";
import { passphraseProblem } from "#ui/vault/vault-keys";

/**
 * The problem with a new passphrase and its repetition, or null. Checked before the slow
 * Argon2id derivation starts, so a typo costs nothing.
 */
export function newPassphraseProblem(
    passphrase: string,
    repeated: string,
): string | null {
    return (
        passphraseProblem(passphrase) ??
        (passphrase === repeated ? null : "The passphrases differ")
    );
}

/** A new passphrase with its repetition, shared by every flow that sets one. */
export function NewPassphraseFields(props: {
    label: string;
    repeatLabel: string;
    passphrase: string;
    repeated: string;
    disabled: boolean;
    onChange: (passphrase: string, repeated: string) => void;
}) {
    return (
        <div className="grid gap-4">
            <Password
                label={props.label}
                value={props.passphrase}
                autoComplete="new-password"
                required
                description="At least 12 characters. A leaked vault backup allows offline guessing."
                disabled={props.disabled}
                onChange={(value) => props.onChange(value, props.repeated)}
            />
            <Password
                label={props.repeatLabel}
                value={props.repeated}
                autoComplete="new-password"
                required
                disabled={props.disabled}
                onChange={(value) => props.onChange(props.passphrase, value)}
            />
        </div>
    );
}

/**
 * The plain warning for a vault that ends up without a passphrase: the passkeys are then the
 * only way in, and they are bound to their hostnames.
 */
export function PasswordlessWarning(props: { hosts: string[] }) {
    return (
        <div
            role="note"
            aria-label="Passwordless vault warning"
            className="grid gap-1 rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-200"
        >
            <p className="flex items-center gap-2 font-medium">
                <TriangleAlert
                    className="h-4 w-4 shrink-0"
                    aria-hidden="true"
                />
                Without a passphrase
            </p>
            <ul className="list-disc space-y-1 pl-5 text-xs">
                <li>
                    Passkeys only work on the hostname they were registered on:{" "}
                    {props.hosts.join(", ")}.
                </li>
                <li>
                    Losing every passkey loses every encrypted file. A
                    vault.json backup cannot help, because it only holds wrapped
                    keys.
                </li>
                <li>
                    Register a second passkey, or use one that syncs, such as a
                    password manager&apos;s.
                </li>
            </ul>
        </div>
    );
}
