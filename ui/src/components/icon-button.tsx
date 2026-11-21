import * as React from "react";
import { createLink } from "@tanstack/react-router";
import { cn } from "#ui/utils/cn";

import { OptionalTooltip } from "#ui/components/tooltip";
import type { ControlTooltipProps } from "#ui/components/tooltip";

/**
 * Picks the visual weight of an icon-only control. Leaving it out keeps the control unstyled
 * for owners, such as a tab segment, whose look depends on the surrounding component.
 */
export type IconButtonVariant = "ghost" | "quiet" | "outline";

/** Picks the hit area; the square sizes give controls in a row one fixed height. */
export type IconButtonSize = "xs" | "sm" | "md" | "lg" | "xl";

type IconButtonOwnProps = ControlTooltipProps & {
    /** The accessible name, which also becomes the tooltip unless `tooltip` says otherwise. */
    label: string;
    variant?: IconButtonVariant;
    size?: IconButtonSize;
};

type IconButtonProps = Omit<
    React.ComponentPropsWithRef<"button">,
    "aria-label" | "title"
> &
    IconButtonOwnProps;

type IconAnchorProps = Omit<
    React.ComponentPropsWithRef<"a">,
    "aria-label" | "title"
> &
    IconButtonOwnProps;

const variantClasses = {
    ghost: "rounded-md text-slate-400 transition-colors hover:bg-tint hover:text-slate-100",
    quiet: "rounded-md text-slate-500 transition-colors hover:bg-tint-strong hover:text-slate-200",
    outline:
        "rounded-md border border-slate-700 text-slate-300 transition-colors hover:bg-tint",
} satisfies Record<IconButtonVariant, string>;

const sizeClasses = {
    xs: "p-1",
    sm: "p-1.5",
    md: "p-2",
    lg: "h-8 w-8",
    xl: "h-9 w-9",
} satisfies Record<IconButtonSize, string>;

/**
 * Builds the icon control look in one place, so a link that must look like an icon button
 * cannot drift from the real one.
 */
export function getIconButtonClassName(props: {
    variant?: IconButtonVariant;
    size?: IconButtonSize;
    className?: string;
}): string {
    return cn(
        "inline-flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-50",
        props.variant ? variantClasses[props.variant] : undefined,
        props.size ? sizeClasses[props.size] : undefined,
        props.className,
    );
}

/**
 * Gives icon-only native buttons one accessible name and a keyboard-accessible
 * explanation. The tooltip defaults to the label because an icon alone is ambiguous; pass
 * `tooltip` for richer text or `tooltip={false}` where a nearby label already explains it.
 */
export function IconButton(props: IconButtonProps) {
    const buttonProps: React.ComponentPropsWithRef<"button"> &
        Partial<IconButtonOwnProps> = { ...props };

    delete buttonProps.label;
    delete buttonProps.tooltip;
    delete buttonProps.tooltipClassName;
    delete buttonProps.variant;
    delete buttonProps.size;

    const nativeButtonProps: React.ComponentPropsWithRef<"button"> =
        buttonProps;

    const nativeProps = {
        ...nativeButtonProps,
        "aria-label": props.label,
        className: getIconButtonClassName(props),
    };

    return (
        <OptionalTooltip
            tooltip={props.tooltip === undefined ? props.label : props.tooltip}
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

/** Renders an anchor with the icon button look, leaving navigation to the router link around it. */
function IconAnchor(props: IconAnchorProps) {
    const anchorProps: React.ComponentPropsWithRef<"a"> &
        Partial<IconButtonOwnProps> = { ...props };

    delete anchorProps.label;
    delete anchorProps.tooltip;
    delete anchorProps.tooltipClassName;
    delete anchorProps.variant;
    delete anchorProps.size;

    const nativeAnchorProps: React.ComponentPropsWithRef<"a"> = anchorProps;

    return (
        <OptionalTooltip
            tooltip={props.tooltip === undefined ? props.label : props.tooltip}
            tooltipClassName={props.tooltipClassName}
        >
            <a
                {...nativeAnchorProps}
                aria-label={props.label}
                className={getIconButtonClassName(props)}
            />
        </OptionalTooltip>
    );
}

/**
 * A router link that looks like an `IconButton`, for icon-only destinations such as "add
 * device". It keeps the router's typed `to`, `params` and `search` and its client-side
 * navigation, which a button with a click handler would lose.
 */
export const IconLinkButton = createLink(IconAnchor);
