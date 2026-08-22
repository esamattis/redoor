import React from "react";
import { twMerge } from "tailwind-merge";

type ButtonVariant = "primary" | "secondary" | "danger" | "warning" | "subtle";
type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = {
    variant?: ButtonVariant;
    size?: ButtonSize;
    isLoading?: boolean;
};

type NativeButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
    ButtonProps & {
        as?: "button";
    };

type AnchorButtonProps = React.AnchorHTMLAttributes<HTMLAnchorElement> &
    ButtonProps & {
        as: "a";
    };

const variantClasses = {
    primary:
        "bg-[var(--app-primary)] text-[var(--app-primary-ink)] hover:bg-[var(--app-primary-hover)]",
    secondary: "border border-slate-700 text-slate-200 hover:bg-white/5",
    danger: "border border-red-800 text-red-300 hover:bg-red-950/30",
    warning: "warning-action border",
    subtle: "",
} satisfies Record<ButtonVariant, string>;

const sizeClasses = {
    sm: "px-3 py-2 text-sm",
    md: "px-4 py-2 text-sm",
    lg: "px-4 py-2.5",
} satisfies Record<ButtonSize, string>;

/**
 * Keeps ordinary actions consistent while retaining native button and link semantics.
 */
export function Button(props: NativeButtonProps | AnchorButtonProps) {
    const className = twMerge(
        "inline-flex items-center justify-center gap-2 rounded font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[props.variant ?? "primary"],
        sizeClasses[props.size ?? "md"],
        props.className,
    );

    if (props.as === "a") {
        const anchorProps: Partial<AnchorButtonProps> = { ...props };
        delete anchorProps.as;
        delete anchorProps.variant;
        delete anchorProps.size;
        delete anchorProps.isLoading;

        return <a {...anchorProps} className={className} />;
    }

    const buttonProps: Partial<NativeButtonProps> = { ...props };
    delete buttonProps.as;
    delete buttonProps.variant;
    delete buttonProps.size;
    delete buttonProps.isLoading;

    return (
        <button
            {...buttonProps}
            disabled={props.disabled || props.isLoading}
            aria-busy={props.isLoading || props["aria-busy"]}
            className={className}
        />
    );
}
