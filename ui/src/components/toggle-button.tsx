import * as React from "react";
import { cn } from "#ui/utils/cn";

import { OptionalTooltip } from "#ui/components/tooltip";
import type { ControlTooltipProps } from "#ui/components/tooltip";

type ToggleButtonVariant = "outline" | "subtle";

/** `icon` hugs the glyph, `lg` is the 36px square used by toolbar rows, `sm` carries a text label. */
type ToggleButtonSize = "icon" | "lg" | "sm";

type ToggleButtonProps = Omit<
    React.ComponentPropsWithRef<"button">,
    "aria-label" | "aria-pressed" | "title"
> &
    ControlTooltipProps & {
        pressed: boolean;
        label: string;
        variant?: ToggleButtonVariant;
        size?: ToggleButtonSize;
    };

const variantClasses = {
    outline:
        "rounded-md border aria-[pressed=true]:border-blue-500 aria-[pressed=true]:bg-blue-500/15 aria-[pressed=true]:text-blue-300 aria-[pressed=false]:border-slate-700 aria-[pressed=false]:bg-slate-900 aria-[pressed=false]:text-slate-400 aria-[pressed=false]:hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
    subtle: "rounded-md font-medium text-slate-400 hover:bg-tint hover:text-slate-100 aria-pressed:bg-slate-800 aria-pressed:text-slate-200",
} satisfies Record<ToggleButtonVariant, string>;

const sizeClasses = {
    icon: "p-2",
    lg: "h-9 w-9",
    sm: "gap-2 px-3 py-2 text-sm",
} satisfies Record<ToggleButtonSize, string>;

/**
 * Gives binary toolbar controls consistent pressed-state semantics while
 * allowing their owner to retain all domain state and behavior. Unlike `IconButton` it has
 * no tooltip unless `tooltip` is given, because many toggles carry a visible text label.
 */
export function ToggleButton(props: ToggleButtonProps) {
    const buttonProps: React.ComponentPropsWithRef<"button"> &
        Partial<ToggleButtonProps> = { ...props };

    delete buttonProps.pressed;
    delete buttonProps.label;
    delete buttonProps.tooltip;
    delete buttonProps.tooltipClassName;
    delete buttonProps.variant;
    delete buttonProps.size;

    const nativeProps = {
        ...buttonProps,
        "aria-label": props.label,
        "aria-pressed": props.pressed,
        className: cn(
            "inline-flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            variantClasses[props.variant ?? "outline"],
            sizeClasses[props.size ?? "icon"],
            props.className,
        ),
    };

    return (
        <OptionalTooltip
            tooltip={props.tooltip}
            tooltipClassName={props.tooltipClassName}
        >
            {props.type === "submit" ? (
                <button {...nativeProps} type="submit" />
            ) : props.type === "reset" ? (
                <button {...nativeProps} type="reset" />
            ) : (
                <button {...nativeProps} type="button" />
            )}
        </OptionalTooltip>
    );
}
