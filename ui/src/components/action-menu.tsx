import React from "react";
import { Dialog } from "./dialog";
import { Tooltip } from "./tooltip";

/**
 * Keeps compact groups of secondary actions behind one consistently anchored trigger.
 */
export function ActionMenu(props: {
    label: string;
    icon?: React.ReactNode;
    hideLabel?: boolean;
    children: (close: () => void) => React.ReactNode;
}) {
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const [isOpen, setIsOpen] = React.useState(false);
    const close = () => setIsOpen(false);

    const trigger = (
        <button
            ref={triggerRef}
            type="button"
            aria-label={props.label}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            onClick={() => setIsOpen(true)}
            className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
        >
            {props.icon}
            {props.hideLabel ? null : props.label}
        </button>
    );

    return (
        <>
            {props.hideLabel ? (
                <Tooltip content={props.label}>{trigger}</Tooltip>
            ) : (
                trigger
            )}
            <Dialog
                isOpen={isOpen}
                title={props.label}
                hideTitle={props.hideLabel}
                closeAriaLabel={`Close ${props.label.toLowerCase()} menu`}
                anchorRef={triggerRef}
                onClose={close}
            >
                <div className="mt-2 grid gap-1">{props.children(close)}</div>
            </Dialog>
        </>
    );
}

/** Provides matching interaction and spacing for actions inside an action menu. */
export function ActionMenuButton(props: {
    children: React.ReactNode;
    tone?: "default" | "danger";
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={props.onClick}
            disabled={props.disabled}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
                props.tone === "danger"
                    ? "text-red-300 hover:bg-red-500/10 hover:text-red-200 disabled:text-red-900"
                    : "text-slate-200 hover:bg-white/5 hover:text-white disabled:text-slate-600"
            } disabled:cursor-not-allowed disabled:hover:bg-transparent`}
        >
            {props.children}
        </button>
    );
}
