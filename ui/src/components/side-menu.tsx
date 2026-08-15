import * as React from "react";
import { X } from "lucide-react";

import { Tooltip } from "#ui/components/tooltip";

const focusableSelector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Provides the shared wide-screen sidebar and responsive drawer behavior for either edge. */
export function SideMenu(props: {
    placement: "left" | "right";
    label: string;
    drawerId: string;
    isOpen: boolean;
    triggerRef: React.RefObject<HTMLButtonElement | null>;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const drawerRef = React.useRef<HTMLElement>(null);

    React.useEffect(() => {
        if (!props.isOpen) {
            return;
        }

        const drawer = drawerRef.current;
        const focusable =
            drawer?.querySelectorAll<HTMLElement>(focusableSelector);
        focusable?.item(0).focus();

        /** Keeps keyboard interaction inside the modal drawer and supports conventional dismissal. */
        const handleDrawerKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                props.onClose();
                return;
            }
            if (event.key !== "Tab" || !drawer) {
                return;
            }

            const entries = [
                ...drawer.querySelectorAll<HTMLElement>(focusableSelector),
            ];
            const first = entries[0];
            const last = entries.at(-1);
            if (!first || !last) {
                event.preventDefault();
                drawer.focus();
                return;
            }
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener("keydown", handleDrawerKeyDown);
        return () => {
            document.removeEventListener("keydown", handleDrawerKeyDown);
            props.triggerRef.current?.focus();
        };
    }, [props.isOpen, props.onClose, props.triggerRef]);

    const borderClass = props.placement === "left" ? "border-r" : "border-l";
    const edgeClass = props.placement === "left" ? "left-0" : "right-0";

    return (
        <>
            <aside
                aria-label={props.label}
                className={`hidden w-56 shrink-0 flex-col ${borderClass} border-slate-800 bg-[#0f1218] p-3 xl:flex`}
            >
                {props.children}
            </aside>
            {props.isOpen ? (
                <div
                    className="fixed inset-0 z-50 bg-black/60 xl:hidden"
                    role="dialog"
                    aria-modal="true"
                    aria-label={props.label}
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                            props.onClose();
                        }
                    }}
                >
                    <aside
                        ref={drawerRef}
                        id={props.drawerId}
                        tabIndex={-1}
                        className={`absolute ${edgeClass} flex h-full w-72 max-w-[85vw] flex-col overflow-y-auto ${borderClass} border-slate-700 bg-[#11141b] p-3 shadow-2xl shadow-black/50`}
                    >
                        <div
                            className={`mb-2 flex ${props.placement === "left" ? "justify-end" : "justify-start"}`}
                        >
                            <Tooltip
                                content={`Close ${props.label.toLowerCase()}`}
                            >
                                <button
                                    type="button"
                                    aria-label={`Close ${props.label.toLowerCase()}`}
                                    onClick={props.onClose}
                                    className="rounded p-2 text-slate-400 hover:bg-white/10 hover:text-slate-100"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </Tooltip>
                        </div>
                        {props.children}
                    </aside>
                </div>
            ) : null}
        </>
    );
}
