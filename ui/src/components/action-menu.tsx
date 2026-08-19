import React from "react";
import { twMerge } from "tailwind-merge";
import { Dialog } from "./dialog";
import { Tooltip } from "./tooltip";

/**
 * Keeps compact groups of secondary actions behind one consistently anchored trigger.
 */
export function ActionMenu(props: {
    label: string;
    triggerAriaLabel?: string;
    closeAriaLabel?: string;
    title?: string;
    icon?: React.ReactNode;
    hideLabel?: boolean;
    /** Shrinks the trigger to an icon in narrow toolbars without hiding the menu title. */
    hideLabelOnMobile?: boolean;
    hideTitle?: boolean;
    /** Square icon trigger for overflow menus that already have a nearby primary action. */
    variant?: "default" | "icon";
    tooltip?: React.ReactNode;
    disabled?: boolean;
    className?: string;
    isOpen?: boolean;
    onOpenChange?: (isOpen: boolean) => void;
    children: (close: () => void) => React.ReactNode;
}) {
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const [internalIsOpen, setInternalIsOpen] = React.useState(false);
    const isOpen = props.isOpen ?? internalIsOpen;
    const setIsOpen = (nextIsOpen: boolean) => {
        setInternalIsOpen(nextIsOpen);
        props.onOpenChange?.(nextIsOpen);
    };
    const close = () => setIsOpen(false);
    const isIcon = props.variant === "icon";
    const hideLabel = props.hideLabel ?? isIcon;

    const trigger = (
        <button
            ref={triggerRef}
            type="button"
            aria-label={props.triggerAriaLabel ?? props.label}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            disabled={props.disabled}
            onClick={() => setIsOpen(true)}
            className={twMerge(
                "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-200 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-50",
                isIcon &&
                    "h-8 w-8 shrink-0 justify-center p-0 text-slate-400 hover:text-slate-100",
                props.className,
            )}
        >
            {props.icon}
            {hideLabel ? null : (
                <span
                    className={
                        props.hideLabelOnMobile ? "hidden sm:inline" : undefined
                    }
                >
                    {props.label}
                </span>
            )}
        </button>
    );

    return (
        <>
            {props.tooltip === false ? (
                trigger
            ) : (
                <Tooltip content={props.tooltip ?? props.label}>
                    {trigger}
                </Tooltip>
            )}
            <Dialog
                isOpen={isOpen}
                title={props.title ?? props.label}
                hideTitle={props.hideTitle ?? hideLabel}
                closeAriaLabel={
                    props.closeAriaLabel ??
                    `Close ${props.label.toLowerCase()} menu`
                }
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
    asChild?: boolean;
    onClick?: () => void;
}) {
    const className = `flex w-full items-center justify-start gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
        props.tone === "danger"
            ? "text-red-300 hover:bg-red-500/10 hover:text-red-200 disabled:text-red-900"
            : "text-slate-200 hover:bg-white/5 hover:text-white disabled:text-slate-600"
    } disabled:cursor-not-allowed disabled:hover:bg-transparent`;

    if (
        props.asChild &&
        React.isValidElement<{ className?: string }>(props.children)
    ) {
        return React.cloneElement(props.children, {
            className: twMerge(className, props.children.props.className),
        });
    }

    return (
        <button
            type="button"
            onClick={props.onClick}
            disabled={props.disabled}
            className={className}
        >
            {props.children}
        </button>
    );
}
