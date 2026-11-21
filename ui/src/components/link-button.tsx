import * as React from "react";
import { createLink } from "@tanstack/react-router";

import { getButtonClassName } from "#ui/components/button";
import type { ButtonSize, ButtonVariant } from "#ui/components/button";

type ButtonAnchorProps = React.ComponentPropsWithRef<"a"> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
};

/** Renders an anchor with the button look, leaving navigation to the router link around it. */
function ButtonAnchor(props: ButtonAnchorProps) {
    const anchorProps: Partial<ButtonAnchorProps> = { ...props };
    delete anchorProps.variant;
    delete anchorProps.size;

    return <a {...anchorProps} className={getButtonClassName(props)} />;
}

/**
 * A router link that looks like a `Button`. Unlike `Button as="a"` it keeps the router's
 * typed `to`, `params` and `search`, client-side navigation and preloading, so use it for any
 * in-app destination that deserves a button's weight. Plain downloads use `Button as="a"`.
 */
export const LinkButton = createLink(ButtonAnchor);
