import React from "react";
import { ChevronDown } from "lucide-react";
import { Dialog } from "./dialog";

/**
 * Keeps compact groups of secondary actions behind one consistently anchored trigger.
 */
export function ActionMenu(props: {
    label: string;
    icon?: React.ReactNode;
    children: (close: () => void) => React.ReactNode;
}) {
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const [isOpen, setIsOpen] = React.useState(false);
    const close = () => setIsOpen(false);

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                onClick={() => setIsOpen(true)}
                className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white"
            >
                {props.icon}
                {props.label}
                <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
            </button>
            <Dialog
                isOpen={isOpen}
                title={props.label}
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
