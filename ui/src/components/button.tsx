import React from "react";
import { twMerge } from "tailwind-merge";

type ButtonVariant = "primary" | "secondary" | "danger" | "warning" | "subtle";
type ButtonSize = "sm" | "md" | "lg";

const variantClasses = {
    primary: "bg-blue-600 text-white hover:bg-blue-500",
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
 * Keeps ordinary action buttons consistent while retaining native button semantics.
 */
export function Button(
    props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
        variant?: ButtonVariant;
        size?: ButtonSize;
        isLoading?: boolean;
    },
) {
    const buttonProps = { ...props };
    delete buttonProps.variant;
    delete buttonProps.size;
    delete buttonProps.isLoading;

    return (
        <button
            {...buttonProps}
            disabled={props.disabled || props.isLoading}
            aria-busy={props.isLoading || props["aria-busy"]}
            className={twMerge(
                "inline-flex items-center justify-center gap-2 rounded font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                variantClasses[props.variant ?? "primary"],
                sizeClasses[props.size ?? "md"],
                props.className,
            )}
        />
    );
}
