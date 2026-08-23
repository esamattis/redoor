// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    invalidateQueries: vi.fn(async () => undefined),
    invalidateRoute: vi.fn(async () => undefined),
    refetchQueries: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-query", () => ({
    useQueryClient: () => ({
        invalidateQueries: mocks.invalidateQueries,
        refetchQueries: mocks.refetchQueries,
    }),
}));

vi.mock("@tanstack/react-router", () => ({
    useRouter: () => ({ invalidate: mocks.invalidateRoute }),
}));

import {
    useBrowserRefreshTriggers,
    useEditorRefreshRegistration,
} from "./refresh";

function RefreshHarness(props: { isDirty: boolean }) {
    useEditorRefreshRegistration({
        agentId: "agent-1",
        path: "/workspace/file.txt",
        isDirty: props.isDirty,
    });
    useBrowserRefreshTriggers();

    return (
        <>
            <div data-terminal-input>
                <textarea aria-label="Terminal input" />
                <button type="button">Terminal control</button>
            </div>
            <button type="button">Editor</button>
        </>
    );
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

test("refreshes the listing and a clean editor when terminal focus leaves", async () => {
    const view = render(<RefreshHarness isDirty={false} />);
    const terminalInput = view.getByRole("textbox", {
        name: "Terminal input",
    });
    const editor = view.getByRole("button", { name: "Editor" });

    fireEvent.focusOut(terminalInput, { relatedTarget: editor });

    await waitFor(() => expect(mocks.invalidateRoute).toHaveBeenCalledOnce());
    // A clean editor must pull new bytes before route invalidation reloads the listing.
    expect(mocks.refetchQueries).toHaveBeenCalledWith({
        queryKey: [
            "server-state",
            "file-content",
            "agent-1",
            "/workspace/file.txt",
        ],
        type: "all",
    });
});

test("keeps an unsaved editor while refreshing the listing", async () => {
    const view = render(<RefreshHarness isDirty />);
    const terminalInput = view.getByRole("textbox", {
        name: "Terminal input",
    });
    const editor = view.getByRole("button", { name: "Editor" });

    fireEvent.focusOut(terminalInput, { relatedTarget: editor });

    await waitFor(() => expect(mocks.invalidateRoute).toHaveBeenCalledOnce());
    // Unsaved text must never be replaced by the automatic terminal-blur refresh.
    expect(mocks.refetchQueries).not.toHaveBeenCalled();
});

test("ignores focus movement within the terminal", () => {
    const view = render(<RefreshHarness isDirty={false} />);
    const terminalInput = view.getByRole("textbox", {
        name: "Terminal input",
    });
    const terminalControl = view.getByRole("button", {
        name: "Terminal control",
    });

    fireEvent.focusOut(terminalInput, { relatedTarget: terminalControl });

    // Internal Ghostty focus changes must not cause browser network traffic.
    expect(mocks.invalidateRoute).not.toHaveBeenCalled();
    expect(mocks.refetchQueries).not.toHaveBeenCalled();
});
