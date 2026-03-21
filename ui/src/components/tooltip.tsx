import * as React from "react";

type TooltipProps = {
    content: React.ReactNode;
    children: React.ReactNode;
    className?: string;
};

/**
 * Shows a small tooltip for its child content on hover and keyboard focus.
 *
 * This wrapper is useful for disabled controls when the tooltip needs to be
 * attached to a non-disabled parent element instead of the control itself.
 */
export function Tooltip(props: TooltipProps) {
    const tooltipId = React.useId();
    const [isOpen, setIsOpen] = React.useState(false);

    return (
        <span
            className={`relative inline-flex ${props.className ?? ""}`}
            onMouseEnter={() => setIsOpen(true)}
            onMouseLeave={() => setIsOpen(false)}
            onFocus={() => setIsOpen(true)}
            onBlur={() => setIsOpen(false)}
        >
            <span
                aria-describedby={isOpen ? tooltipId : undefined}
                className="inline-flex"
                tabIndex={0}
            >
                {props.children}
            </span>

            {isOpen ? (
                <span
                    id={tooltipId}
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-max max-w-64 -translate-x-1/2 rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white shadow-lg"
                >
                    {props.content}
                    <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1 rotate-45 bg-slate-900" />
                </span>
            ) : null}
        </span>
    );
}
