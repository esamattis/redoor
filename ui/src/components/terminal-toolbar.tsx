import * as React from "react";
import { FullWindowToggle } from "#ui/components/full-window-toggle";

/** Keeps scrolling terminal tabs separate from the always-available size control. */
export function TerminalToolbar(props: {
    isFullWindow: boolean;
    onFullWindowChange: (isFullWindow: boolean) => void;
    children: React.ReactNode;
}) {
    return (
        <div
            className={`flex shrink-0 items-center gap-1 ${props.isFullWindow ? "p-2 sm:px-4" : "pb-2"}`}
        >
            <div className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain">
                {props.children}
            </div>
            <FullWindowToggle
                targetName="terminal"
                isFullWindow={props.isFullWindow}
                onToggle={() => props.onFullWindowChange(!props.isFullWindow)}
            />
        </div>
    );
}
