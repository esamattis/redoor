import * as React from "react";
import { twMerge } from "tailwind-merge";

import { Tooltip } from "#ui/components/tooltip";

type IconButtonProps = Omit<
    React.ComponentPropsWithRef<"button">,
    "aria-label" | "title"
> &
    IconButtonOwnProps;

type IconButtonOwnProps = {
    label: string;
    tooltip?: React.ReactNode;
    tooltipClassName?: string;
};

/**
 * Gives icon-only native buttons one accessible name and a keyboard-accessible
 * explanation without prescribing their layout-specific visual treatment.
 */
export function IconButton(props: IconButtonProps) {
    const buttonProps: React.ComponentPropsWithRef<"button"> &
        Partial<IconButtonOwnProps> = { ...props };
    delete buttonProps.label;
    delete buttonProps.tooltip;
    delete buttonProps.tooltipClassName;
    const nativeButtonProps: React.ComponentPropsWithRef<"button"> =
        buttonProps;
    const button = (
        <button
            {...nativeButtonProps}
            aria-label={props.label}
            className={twMerge(
                "inline-flex items-center justify-center disabled:cursor-not-allowed disabled:opacity-50",
                props.className,
            )}
        />
    );

    if (props.tooltip === false) {
        return button;
    }

    return (
        <Tooltip
            content={props.tooltip ?? props.label}
            className={props.tooltipClassName}
        >
            {button}
        </Tooltip>
    );
}
