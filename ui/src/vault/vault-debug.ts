/**
 * Console diagnostics for the vault unlock flows.
 *
 * Passkey prompts sometimes appear twice or behave oddly in ways that cannot be reproduced
 * on demand, so every prompt, session transition and dialog action is logged with a shared
 * prefix. A user who hits the problem can then copy the console into a bug report. Nothing
 * secret is logged: only ids, counts, timings and error names.
 */

/**
 * A value in a debug line. Only plain values, so nothing secret such as a key or a PRF
 * output can be logged by accident.
 */
export type VaultDebugValue =
    string | number | boolean | null | undefined | readonly string[];

/** Identifies this tab, because the session syncs between tabs and both may log. */
const TAB_ID = Math.random().toString(36).slice(2, 8);

/** Numbers passkey prompts so the start, end and failure of each can be matched. */
let promptCounter = 0;

/** When this tab started logging, so the timings read as offsets on one timeline. */
const startedAt = performance.now();

/**
 * Logs one vault event with the tab id and a millisecond offset, so lines from several
 * tabs and prompts can be told apart and ordered in a pasted console log.
 */
export function vaultDebug(
    event: string,
    details: Record<string, VaultDebugValue> = {},
): void {
    // A string rather than an object, because copying the console collapses objects to
    // `{…}` and the bug report would lose the details.
    const json = JSON.stringify({
        ...details,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
    });

    console.info(
        `[redoor vault ${TAB_ID} +${Math.round(performance.now() - startedAt)}ms] ${event} ${json}`,
    );
}

/** Hands out the next prompt number for `vaultDebug` lines of one passkey prompt. */
export function nextPasskeyPromptId(): number {
    promptCounter += 1;

    return promptCounter;
}

/**
 * The call stack of the caller, so a duplicated prompt shows which code path started each
 * one. Chrome adds an `Error:` header line and Firefox does not, so it is filtered rather
 * than sliced off.
 */
export function callerStack(): string | undefined {
    return new Error("stack").stack
        ?.split("\n")
        .filter((line) => !line.startsWith("Error"))
        .join("\n");
}
