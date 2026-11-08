import * as React from "react";

/**
 * One labelled value of a record card's fact grid (inside a `<dl>`). Labels each value by its
 * term, so assistive technology and tests can read a fact by name even though the term and
 * value are laid out as separate visual rows.
 */
export function FactItem(props: {
    label: string;
    icon: React.ReactNode;
    children: React.ReactNode;
}) {
    const labelId = React.useId();

    return (
        <div className="min-w-0 bg-surface px-5 py-3">
            <dt
                id={labelId}
                className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500"
            >
                <span aria-hidden="true">{props.icon}</span>
                {props.label}
            </dt>
            <dd
                aria-labelledby={labelId}
                className="mt-1 truncate text-sm text-slate-200"
            >
                {props.children}
            </dd>
        </div>
    );
}
