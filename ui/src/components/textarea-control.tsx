import * as React from "react";
import { cn } from "#ui/utils/cn";

/** Keeps multiline text entry consistent with the other native form controls. */
export function TextareaControl(
    props: React.ComponentPropsWithRef<"textarea">,
) {
    return (
        <textarea
            {...props}
            className={cn(
                "min-w-0 resize-y rounded-md border border-slate-700 bg-canvas px-3 py-2 text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20",
                props.className,
            )}
        />
    );
}
