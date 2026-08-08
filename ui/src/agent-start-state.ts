import { atom } from "jotai";

/** Tracks optimistic starts and request failures independently for each managed agent. */
export type AgentStartState = {
    starting: boolean;
    error: string | null;
    autoRedirect: boolean;
};

/** Keeps fast local registrations from skipping the visible starting boundary. */
export const agentStartStatesAtom = atom<Record<string, AgentStartState>>({});

/** Converts unknown request failures into user-facing retry text. */
export function getStartErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Failed to start agent";
}
