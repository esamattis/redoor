import React from "react";
import { Dices, TriangleAlert } from "lucide-react";

import { Button } from "#ui/components/button";
import { CopyableCodeRow } from "#ui/components/copyable-code-row";
import { Password } from "#ui/components/password";
import { passphraseProblem } from "#ui/vault/vault-keys";
import { generatePassphrase } from "#ui/vault/vault-passphrase";

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

/**
 * A new passphrase with its repetition and a "Generate" button. A generated passphrase is
 * shown in full with a copy button, because the user has to store it somewhere: it is the
 * way back in when every passkey is lost.
 */
export function NewPassphraseFields(props: {
    label: string;
    repeatLabel: string;
    passphrase: string;
    repeated: string;
    disabled: boolean;
    onChange: (passphrase: string, repeated: string) => void;
}) {
    const [generated, setGenerated] = React.useState<string | null>(null);
    const isGenerated = generated !== null && generated === props.passphrase;

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
            <div className="flex flex-wrap items-center gap-3">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    tooltip="Fill in a random passphrase with 125 bits of entropy"
                    disabled={props.disabled}
                    onClick={() => {
                        const value = generatePassphrase();

                        setGenerated(value);
                        props.onChange(value, value);
                    }}
                >
                    <Dices className="h-4 w-4" aria-hidden="true" />
                    Generate
                </Button>
            </div>
            {isGenerated ? (
                <div className="grid gap-2">
                    <CopyableCodeRow
                        label="Generated passphrase"
                        value={props.passphrase}
                        copyAriaLabel="Copy passphrase"
                        wrap
                    />
                    <p className="flex gap-2 text-xs text-amber-300">
                        <TriangleAlert
                            className="h-4 w-4 shrink-0"
                            aria-hidden="true"
                        />
                        Store it in a password manager now. It is your way back
                        in if you lose your passkeys, and redoor cannot show it
                        again.
                    </p>
                </div>
            ) : null}
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
