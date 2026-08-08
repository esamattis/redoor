import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/** Keeps persistent activity visible without letting its controls dominate the page. */
export function CollapsibleBottomPanel(props: {
    title: string;
    description: string;
    badge: React.ReactNode;
    actions?: React.ReactNode;
    icon?: React.ReactNode;
    children: React.ReactNode;
    defaultCollapsed?: boolean;
    isCollapsed?: boolean;
    onCollapsedChange?: (isCollapsed: boolean) => void;
    keepChildrenMounted?: boolean;
}) {
    const [uncontrolledCollapsed, setUncontrolledCollapsed] = React.useState(
        props.defaultCollapsed ?? false,
    );
    const isCollapsed = props.isCollapsed ?? uncontrolledCollapsed;
    const toggleLabel = `${isCollapsed ? "Expand" : "Minimize"} ${props.title}`;

    /** Updates either the controlled owner or this panel's local collapse state. */
    const setIsCollapsed = (nextCollapsed: boolean) => {
        if (props.isCollapsed === undefined) {
            setUncontrolledCollapsed(nextCollapsed);
        }
        props.onCollapsedChange?.(nextCollapsed);
    };

    return (
        <section className="sticky bottom-0 z-10 border-t border-slate-800 bg-[#11141b]/95 shadow-[0_-10px_30px_-12px_rgba(0,0,0,0.6)] backdrop-blur supports-backdrop-filter:bg-[#11141b]/80">
            <div className="max-w-full px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                        {props.icon ? (
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-800 text-slate-300">
                                {props.icon}
                            </div>
                        ) : null}
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-sm font-semibold text-slate-100">
                                    {props.title}
                                </h2>
                                {props.badge}
                            </div>
                            <p className="truncate text-xs text-slate-500">
                                {props.description}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        {props.actions}
                        <div className="mx-1 h-5 w-px bg-slate-800" />
                        <button
                            type="button"
                            aria-label={toggleLabel}
                            title={toggleLabel}
                            aria-expanded={!isCollapsed}
                            onClick={() => setIsCollapsed(!isCollapsed)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-100"
                        >
                            {isCollapsed ? (
                                <ChevronUp className="h-4 w-4" />
                            ) : (
                                <ChevronDown className="h-4 w-4" />
                            )}
                        </button>
                    </div>
                </div>

                {props.keepChildrenMounted ? (
                    <div
                        hidden={isCollapsed}
                        aria-hidden={isCollapsed}
                        className="mt-3 border-t border-slate-800 pt-3"
                    >
                        {props.children}
                    </div>
                ) : isCollapsed ? null : (
                    <div className="mt-3 border-t border-slate-800 pt-3">
                        {props.children}
                    </div>
                )}
            </div>
        </section>
    );
}
