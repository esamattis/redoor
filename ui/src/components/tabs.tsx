import * as React from "react";

import { OptionalTooltip } from "#ui/components/tooltip";
import type { ControlTooltipProps } from "#ui/components/tooltip";

/**
 * Wraps tabs in a `tablist` that supports the conventional horizontal arrow navigation, so
 * every tab strip behaves the same without each owner re-implementing the key handling.
 *
 * Arrow keys move focus to the neighbouring tab and activate it, wrapping at the ends. The
 * list finds the tabs in the DOM instead of knowing them, because owners such as the terminal
 * strip wrap each tab in extra markup. Activation is a click on the neighbour, so the owner's
 * own `onClick` stays the only place that decides what selecting a tab means.
 */
export function TabList(props: React.ComponentPropsWithRef<"div">) {
    /** Moves to the neighbouring tab when an arrow key is pressed while a tab has focus. */
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        props.onKeyDown?.(event);

        if (
            event.defaultPrevented ||
            (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
        ) {
            return;
        }

        const current =
            event.target instanceof Element
                ? event.target.closest<HTMLElement>('[role="tab"]')
                : null;

        const tabs = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
                '[role="tab"]',
            ),
        ];

        // Keys pressed on other controls inside the strip, such as a close button, are theirs.
        if (current === null || !tabs.includes(current)) {
            return;
        }

        const offset = event.key === "ArrowRight" ? 1 : -1;

        const next =
            tabs[(tabs.indexOf(current) + offset + tabs.length) % tabs.length];

        if (next === undefined) {
            return;
        }

        next.focus();
        next.click();
        event.preventDefault();
    };

    return <div {...props} role="tablist" onKeyDown={handleKeyDown} />;
}

/**
 * One tab of a `TabList`. Only the selected tab is in the page's tab order and the others are
 * reached with the arrow keys, which is the roving-focus pattern assistive technology expects.
 * Give it `id` and `aria-controls` so the panel and the tab name each other. Like the other
 * controls it takes an optional `tooltip`, which compact layouts use to name icon-only tabs.
 */
export function Tab(
    props: Omit<React.ComponentPropsWithRef<"button">, "aria-selected"> &
        ControlTooltipProps & { selected: boolean },
) {
    const buttonProps: React.ComponentPropsWithRef<"button"> &
        Partial<ControlTooltipProps & { selected: boolean }> = { ...props };

    delete buttonProps.selected;
    delete buttonProps.tooltip;
    delete buttonProps.tooltipClassName;

    return (
        <OptionalTooltip
            tooltip={props.tooltip}
            tooltipClassName={props.tooltipClassName}
        >
            <button
                {...buttonProps}
                type="button"
                role="tab"
                aria-selected={props.selected}
                tabIndex={props.selected ? 0 : -1}
            />
        </OptionalTooltip>
    );
}
