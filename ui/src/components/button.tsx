import React from "react";
import { cn } from "#ui/utils/cn";

import { OptionalTooltip } from "#ui/components/tooltip";
import type { ControlTooltipProps } from "#ui/components/tooltip";

export type ButtonVariant =
    "primary" | "secondary" | "danger" | "warning" | "subtle" | "ghost";

export type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = ControlTooltipProps & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    isLoading?: boolean;
};

type NativeButtonProps = React.ComponentPropsWithRef<"button"> &
    ButtonProps & {
        as?: "button";
    };

type AnchorButtonProps = React.ComponentPropsWithRef<"a"> &
    ButtonProps & {
        as: "a";
    };

const variantClasses = {
    primary: "bg-blue-600 text-white hover:bg-blue-500",
    secondary: "border border-slate-700 text-slate-200 hover:bg-tint",
    danger: "border border-red-800 text-red-300 hover:bg-red-950/30",
    warning: "warning-action border",
    // Carries no color of its own, so the owner decides how an inline action reads.
    subtle: "",
    // Borderless menu-style action that only shows a hover surface.
    ghost: "text-slate-200 hover:bg-tint hover:text-slate-100",
} satisfies Record<ButtonVariant, string>;

const sizeClasses = {
    sm: "px-3 py-2 text-sm",
    md: "px-4 py-2 text-sm",
    lg: "px-4 py-2.5",
} satisfies Record<ButtonSize, string>;

/**
 * Builds the shared button look in one place, so anything that must look like a button
 * without being a `<button>`, such as a router link, cannot drift from the real one.
 */
export function getButtonClassName(props: {
    variant?: ButtonVariant;
    size?: ButtonSize;
    className?: string;
}): string {
    return cn(
        "inline-flex items-center justify-center gap-2 rounded font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variantClasses[props.variant ?? "primary"],
        sizeClasses[props.size ?? "md"],
        props.className,
    );
}

/**
 * Keeps ordinary actions consistent while retaining native button and link semantics.
 * Use `as="a"` for plain anchors such as downloads, and `LinkButton` for in-app navigation.
 * `tooltip` explains what the action does, which is what the disabled and ambiguous ones need.
 */
export function Button(props: NativeButtonProps | AnchorButtonProps) {
    const className = getButtonClassName(props);

    if (props.as === "a") {
        const anchorProps: Partial<AnchorButtonProps> = { ...props };
        delete anchorProps.as;
        delete anchorProps.variant;
        delete anchorProps.size;
        delete anchorProps.isLoading;
        delete anchorProps.tooltip;
        delete anchorProps.tooltipClassName;

        return (
            <OptionalTooltip
                tooltip={props.tooltip}
                tooltipClassName={props.tooltipClassName}
            >
                <a {...anchorProps} className={className} />
            </OptionalTooltip>
        );
    }

    const buttonProps: Partial<NativeButtonProps> = { ...props };
    delete buttonProps.as;
    delete buttonProps.variant;
    delete buttonProps.size;
    delete buttonProps.isLoading;
    delete buttonProps.tooltip;
    delete buttonProps.tooltipClassName;

    const nativeProps = {
        ...buttonProps,
        disabled: props.disabled || props.isLoading,
        "aria-busy": props.isLoading || props["aria-busy"],
        className,
    };

    return (
        <OptionalTooltip
            tooltip={props.tooltip}
            tooltipClassName={props.tooltipClassName}
        >
            {props.type === "button" ? (
                <button {...nativeProps} type="button" />
            ) : props.type === "reset" ? (
                <button {...nativeProps} type="reset" />
            ) : (
                <button {...nativeProps} type="submit" />
            )}
        </OptionalTooltip>
    );
}
