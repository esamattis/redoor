import React from "react";
import { Dialog, type DialogProps } from "#ui/components/dialog";
import { useIsBelowBreakpoint } from "#ui/utils/use-breakpoint";

type ResponsiveAnchoredDialogProps = Omit<
    DialogProps,
    "anchorRef" | "anchorPoint"
> & {
    desktopAnchorRef: React.RefObject<HTMLElement | null>;
};

/** Anchors compact desktop workflows to their opener while retaining a mobile modal. */
export function ResponsiveAnchoredDialog(props: ResponsiveAnchoredDialogProps) {
    const isMobile = useIsBelowBreakpoint("sm");

    return (
        <Dialog
            isOpen={props.isOpen}
            title={props.title}
            hideTitle={props.hideTitle}
            description={props.description}
            closeAriaLabel={props.closeAriaLabel}
            isBusy={props.isBusy}
            errorMessage={props.errorMessage}
            role={props.role}
            size={props.size}
            anchorRef={isMobile ? undefined : props.desktopAnchorRef}
            initialFocus={props.initialFocus ?? "panel"}
            onClose={props.onClose}
        >
            {props.children}
        </Dialog>
    );
}
