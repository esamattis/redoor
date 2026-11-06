import type * as React from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import {
    AlertCircle,
    CircleCheck,
    CircleX,
    HardDrive,
    ServerOff,
} from "lucide-react";

import type { Agent } from "#ui/api-client";
import { deviceRoute } from "#ui/browser-route";
import { Button } from "#ui/components/button";
import { LinkButton } from "#ui/components/link-button";
import { RouteError } from "#ui/components/route-error";
import { Toast } from "#ui/components/toast";
import { getErrorMessage } from "#ui/utils/error";
import { isSystemdUnsupportedError } from "#ui/systemd-queries";

/** Why the systemd pages cannot talk to a device, each explained in its own words. */
export type SystemdBlock =
    | { kind: "unavailable"; reason: string }
    | { kind: "disconnected" }
    | { kind: "unknown" };

/**
 * Decides whether the systemd pages can ask the device anything. A device known not to run
 * systemd says so even while disconnected, because the server keeps the last report and
 * reconnecting would not change the answer.
 */
export function systemdBlock(agent: Agent): SystemdBlock | null {
    if (agent.systemd?.status === "unavailable") {
        return { kind: "unavailable", reason: agent.systemd.reason };
    }

    if (agent.status !== "connected") {
        return { kind: "disconnected" };
    }

    if (agent.systemd === null) {
        return { kind: "unknown" };
    }

    return null;
}

/** Centres one explanation in the page, the way the other device pages explain a dead end. */
function CenteredNotice(props: {
    icon: React.ReactNode;
    title: string;
    children: React.ReactNode;
    action?: React.ReactNode;
}) {
    return (
        <div className="flex h-full items-center justify-center p-8">
            <section className="max-w-lg text-center">
                {props.icon}
                <h1 className="mt-4 text-2xl font-semibold text-slate-100">
                    {props.title}
                </h1>
                <div className="mt-2 text-slate-400">{props.children}</div>
                {props.action ? (
                    <div className="mt-6">{props.action}</div>
                ) : null}
            </section>
        </div>
    );
}

/** A way back to the device page, so a dead end never strands the reader. */
function DeviceLink(props: { agent: Agent }) {
    return (
        <LinkButton {...deviceRoute(props.agent, "/agents/$deviceName")}>
            <HardDrive className="h-4 w-4" aria-hidden="true" />
            Device
        </LinkButton>
    );
}

/** Says the device does not run systemd, with the agent's reason, instead of failing requests. */
export function SystemdUnsupportedNotice(props: {
    agent: Agent;
    reason: string;
}) {
    return (
        <CenteredNotice
            icon={
                <ServerOff
                    className="mx-auto h-12 w-12 text-slate-500"
                    aria-hidden="true"
                />
            }
            title="This device does not use systemd"
            action={<DeviceLink agent={props.agent} />}
        >
            <p>{props.reason}</p>
        </CenteredNotice>
    );
}

/** Explains why the systemd pages of a device cannot be shown right now. */
export function SystemdBlockedState(props: {
    agent: Agent;
    block: SystemdBlock;
}) {
    switch (props.block.kind) {
        case "unavailable":
            return (
                <SystemdUnsupportedNotice
                    agent={props.agent}
                    reason={props.block.reason}
                />
            );
        case "disconnected":
            return (
                <CenteredNotice
                    icon={
                        <AlertCircle
                            className="mx-auto h-12 w-12 text-amber-400"
                            aria-hidden="true"
                        />
                    }
                    title={`${props.agent.name} is disconnected`}
                    action={<DeviceLink agent={props.agent} />}
                >
                    <p>
                        Start the Redoor agent on this device to manage its
                        systemd units.
                    </p>
                </CenteredNotice>
            );
        case "unknown":
            return (
                <CenteredNotice
                    icon={
                        <AlertCircle
                            className="mx-auto h-12 w-12 text-slate-500"
                            aria-hidden="true"
                        />
                    }
                    title="Systemd support is unknown"
                    action={<DeviceLink agent={props.agent} />}
                >
                    <p>
                        The agent has not told this server whether the device
                        runs systemd. Connect the agent to find out.
                    </p>
                </CenteredNotice>
            );
    }
}

/**
 * Shows a failed systemd load. A device that turns out not to run systemd (its tools went
 * missing, or the server never got a report) gets the same explanation as a device that
 * reported it, instead of a generic error page.
 */
export function SystemdRouteError(props: ErrorComponentProps) {
    if (
        props.error instanceof Error &&
        isSystemdUnsupportedError(props.error)
    ) {
        return (
            <CenteredNotice
                icon={
                    <ServerOff
                        className="mx-auto h-12 w-12 text-slate-500"
                        aria-hidden="true"
                    />
                }
                title="This device does not use systemd"
            >
                <p>
                    {getErrorMessage(
                        props.error,
                        "The device reported that it does not run systemd.",
                    )}
                </p>
            </CenteredNotice>
        );
    }

    return (
        <RouteError error={props.error} info={props.info} reset={props.reset} />
    );
}

/** Inline failure of a systemd read, with a retry for failures that may be transient. */
export function SystemdLoadError(props: {
    error: Error;
    fallback: string;
    onRetry: () => void;
}) {
    return (
        <section
            role="alert"
            className="rounded-lg border border-red-900/60 bg-red-950/20 px-4 py-4 text-sm"
        >
            <p className="font-medium text-red-200">{props.fallback}</p>
            <p className="mt-1 wrap-break-word text-red-300/80">
                {getErrorMessage(props.error, props.fallback)}
            </p>
            <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-3"
                tooltip="Ask the device again"
                onClick={props.onRetry}
            >
                Retry
            </Button>
        </section>
    );
}

/** Feedback of a finished systemd change; `id` restarts the toast for repeated messages. */
export type SystemdFeedback = {
    id: number;
    tone: "success" | "error";
    message: string;
};

/** Builds feedback with a fresh id, so the same message twice still restarts the toast. */
export function systemdFeedback(
    tone: SystemdFeedback["tone"],
    message: string,
): SystemdFeedback {
    return { id: Date.now(), tone, message };
}

/** Shows the latest systemd change result as a non-modal toast. */
export function SystemdFeedbackToast(props: {
    feedback: SystemdFeedback | null;
    onDismiss: () => void;
}) {
    if (props.feedback === null) {
        return null;
    }

    return (
        <Toast
            key={props.feedback.id}
            tone={props.feedback.tone}
            icon={
                props.feedback.tone === "error" ? (
                    <CircleX className="h-4 w-4" />
                ) : (
                    <CircleCheck className="h-4 w-4" />
                )
            }
            onDismiss={props.onDismiss}
        >
            <span className="wrap-break-word">{props.feedback.message}</span>
        </Toast>
    );
}
