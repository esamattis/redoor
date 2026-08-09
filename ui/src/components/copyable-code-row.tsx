import * as React from "react";
import { Check, Copy } from "lucide-react";

/** Writes text to the clipboard, with a textarea fallback when the async API is unavailable. */
async function writeClipboardText(value: string): Promise<void> {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    if (!copied) {
        throw new Error("clipboard copy failed");
    }
}

/** Shared clipboard feedback used by the full and compact copyable path controls. */
function useCopyFeedback(value: string) {
    const [isCopied, setIsCopied] = React.useState(false);
    const [flashKey, setFlashKey] = React.useState(0);
    const resetTimerRef = React.useRef<number | null>(null);

    React.useEffect(() => {
        return () => {
            if (resetTimerRef.current !== null) {
                window.clearTimeout(resetTimerRef.current);
            }
        };
    }, []);

    const copy = async () => {
        try {
            await writeClipboardText(value);
            setIsCopied(true);
            // Restart the CSS flash without remounting this component.
            setFlashKey((key) => key + 1);
            if (resetTimerRef.current !== null) {
                window.clearTimeout(resetTimerRef.current);
            }
            resetTimerRef.current = window.setTimeout(() => {
                setIsCopied(false);
                resetTimerRef.current = null;
            }, 1600);
        } catch {
            // Clipboard may be denied; leave the value visible for manual copy.
        }
    };

    return { isCopied, flashKey, copy };
}

/** Keeps long values readable on narrow screens while leaving copy controls accessible. */
export function CopyableCodeRow(props: {
    label: string;
    value: string;
    copyAriaLabel?: string;
}) {
    const { isCopied, flashKey, copy } = useCopyFeedback(props.value);

    return (
        <div
            className={
                isCopied
                    ? "relative min-w-0 overflow-hidden rounded-lg border border-emerald-400/50 bg-slate-950/70"
                    : "relative min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/70"
            }
        >
            {isCopied ? (
                <span
                    key={flashKey}
                    aria-hidden="true"
                    className="copy-success-flash pointer-events-none absolute inset-0 rounded-lg"
                />
            ) : null}
            <div className="relative flex items-center justify-between gap-3 border-b border-slate-800/80 px-3 py-1.5">
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {props.label}
                </span>
                <button
                    type="button"
                    onClick={() => {
                        void copy();
                    }}
                    className={
                        isCopied
                            ? "inline-flex items-center gap-1.5 rounded-md bg-emerald-500/20 px-2 py-1 text-xs font-medium text-emerald-300"
                            : "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
                    }
                    aria-label={
                        isCopied
                            ? "Copied!"
                            : (props.copyAriaLabel ??
                              `Copy ${props.label.toLowerCase()}`)
                    }
                >
                    {isCopied ? (
                        <Check className="h-3.5 w-3.5" />
                    ) : (
                        <Copy className="h-3.5 w-3.5" />
                    )}
                    {isCopied ? "Copied!" : "Copy"}
                </button>
            </div>
            <code className="relative block overflow-x-auto whitespace-nowrap px-3 py-2.5 font-mono text-sm text-slate-200">
                {props.value}
            </code>
        </div>
    );
}

/**
 * Compact single-line path for dense home/detail layouts.
 *
 * Callers supply the visible field label outside this control.
 */
export function CopyablePath(props: { value: string; copyAriaLabel: string }) {
    const { isCopied, flashKey, copy } = useCopyFeedback(props.value);

    return (
        <div
            className={
                isCopied
                    ? "relative flex min-w-0 items-center gap-1 rounded-md border border-emerald-400/50 bg-slate-950/70"
                    : "relative flex min-w-0 items-center gap-1 rounded-md border border-slate-800 bg-slate-950/70"
            }
        >
            {isCopied ? (
                <span
                    key={flashKey}
                    aria-hidden="true"
                    className="copy-success-flash pointer-events-none absolute inset-0 rounded-md"
                />
            ) : null}
            <code className="relative min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-2.5 py-1.5 font-mono text-xs text-slate-200">
                {props.value}
            </code>
            <button
                type="button"
                onClick={() => {
                    void copy();
                }}
                className={
                    isCopied
                        ? "relative mr-1 inline-flex shrink-0 items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-1 text-xs font-medium text-emerald-300"
                        : "relative mr-1 inline-flex shrink-0 items-center rounded px-1.5 py-1 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
                }
                aria-label={isCopied ? "Copied!" : props.copyAriaLabel}
                title={isCopied ? "Copied!" : props.copyAriaLabel}
            >
                {isCopied ? (
                    <>
                        <Check className="h-3.5 w-3.5" />
                        <span>Copied!</span>
                    </>
                ) : (
                    <Copy className="h-3.5 w-3.5" />
                )}
            </button>
        </div>
    );
}
