import * as React from "react";
import { Plus } from "lucide-react";

import { Tooltip } from "#ui/components/tooltip";

type AddButtonChildProps = {
    "aria-describedby"?: string;
    children?: React.ReactNode;
    className?: string;
    tabIndex?: number;
};

/** Keeps add actions visually consistent while allowing links and buttons to retain their semantics. */
export function AddButton(props: {
    children: React.ReactElement<AddButtonChildProps>;
    tooltip: string;
}) {
    const child = React.cloneElement(props.children, {
        children: <Plus className="h-4 w-4" aria-hidden="true" />,
        className:
            "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100",
    });

    return <Tooltip content={props.tooltip}>{child}</Tooltip>;
}
