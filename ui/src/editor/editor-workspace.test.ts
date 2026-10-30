// @vitest-environment jsdom

import {
    afterEach,
    beforeEach,
    expect,
    onTestFinished,
    test,
    vi,
} from "vitest";
import { redo, undo, undoDepth } from "@codemirror/commands";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { QueryClient } from "@tanstack/react-query";
import type { DeleteEditorBufferResponse } from "#bindings/DeleteEditorBufferResponse";
import type { EditorBufferResponse } from "#bindings/EditorBufferResponse";
import type { PutEditorBufferRequest } from "#bindings/PutEditorBufferRequest";
import type { PutEditorBufferResponse } from "#bindings/PutEditorBufferResponse";

import {
    EditorWorkspace,
    type ActivateRequest,
    type CaretReport,
    type EditorBufferApi,
} from "./editor-workspace";
import {
    GIT_GUTTER_HIDDEN,
    gitGutterField,
    gitGutterSource,
} from "./git-gutter";
import { parseStoredBuffer, type StoredBuffer } from "./stored-buffer";

// JSDOM does not measure text ranges, while CodeMirror only needs stable stubs here.
Range.prototype.getClientRects = () => document.body.getClientRects();

Range.prototype.getBoundingClientRect = () => new DOMRect();

/** Keeps buffers like the server does: last writer wins, every write a new version. */
class FakeBufferApi implements EditorBufferApi {
    readonly stored = new Map<string, { version: number; data: unknown }>();
    readonly writes: { key: string; request: PutEditorBufferRequest }[] = [];
    readonly deletes: string[] = [];
    private nextVersion = 1;

    /** Answers like `PUT /api/v1/user/editor-buffers/{key}`. */
    async putEditorBuffer(
        key: string,
        request: PutEditorBufferRequest,
    ): Promise<PutEditorBufferResponse> {
        this.writes.push({ key, request });

        return { key, version: this.store(key, request.data) };
    }

    /** Answers like `DELETE`. */
    async deleteEditorBuffer(key: string): Promise<DeleteEditorBufferResponse> {
        this.deletes.push(key);

        return { key, deleted: this.stored.delete(key) };
    }

    /** Stores data under a new version, as a write from any computer would. */
    store(key: string, data: PutEditorBufferRequest["data"]) {
        const version = this.nextVersion;
        this.nextVersion += 1;
        this.stored.set(key, { version, data });

        return version;
    }

    /** Reads a stored buffer through the same parser the editor uses. */
    read(key: string): StoredBuffer | null {
        const stored = this.stored.get(key);

        const response: EditorBufferResponse = {
            key,
            buffer: stored === undefined ? null : stored,
        };

        return parseStoredBuffer(response);
    }
}

const settings = {
    vimMode: false,
    wrapLines: false,
    theme: "dark",
    editable: true,
} as const;

const noHandlers = {
    current: {
        onUpdate: () => undefined,
        onFocus: () => undefined,
        onSave: () => undefined,
        onBecameDirty: () => undefined,
        onStateReplaced: () => undefined,
    },
} satisfies ActivateRequest["handlers"];

let container: HTMLElement;

beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
});

afterEach(() => {
    vi.useRealTimers();
    container.remove();
});

/** Creates a workspace over a fake server, dropped with its view after the test. */
function createWorkspace(api = new FakeBufferApi()) {
    const caretLines: CaretReport[] = [];

    const workspace = new EditorWorkspace(api, new QueryClient(), (caret) =>
        caretLines.push(caret),
    );

    onTestFinished(() => workspace.deactivate(container));

    return { workspace, api, caretLines };
}

/** Shows a file the way the editor component does. */
function show(
    workspace: EditorWorkspace,
    request: Partial<ActivateRequest> & { key: string; deviceContent: string },
) {
    return workspace.activate({
        container,
        fileName: `${request.key}.txt`,
        stored: null,
        settings,
        lineTargets: { link: null, reveal: null },
        handlers: noHandlers,
        ...request,
    });
}

/** Opens one file whose buffer has been written once, as after editing on this computer. */
async function syncedFile(api: FakeBufferApi) {
    const { workspace } = createWorkspace(api);
    workspace.setOpenKeys(["a"]);
    const view = show(workspace, { key: "a", deviceContent: "base text" });
    view.dispatch({ selection: { anchor: 2 } });
    await vi.advanceTimersByTimeAsync(1000);

    return { workspace, view };
}

test("switching files keeps each file's text, selection and undo history in one view", () => {
    const { workspace } = createWorkspace();
    // Only open files keep their buffers when another file is shown.
    workspace.setOpenKeys(["a", "b"]);
    const view = show(workspace, { key: "a", deviceContent: "alpha" });

    view.dispatch({
        changes: { from: 5, insert: " one" },
        selection: { anchor: 2 },
    });

    const sameView = show(workspace, { key: "b", deviceContent: "beta" });
    // One CodeMirror view serves every file instead of one instance per file.
    expect(sameView).toBe(view);
    view.dispatch({ changes: { from: 0, insert: "B:" } });

    show(workspace, { key: "a", deviceContent: "alpha" });
    // File a comes back with its own edit and caret, untouched by edits to b.
    expect(view.state.doc.toString()).toBe("alpha one");
    expect(view.state.selection.main.head).toBe(2);

    undo(view);
    // Undo walks a's own history, not the edit made in b.
    expect(view.state.doc.toString()).toBe("alpha");
    redo(view);
    // Redo is kept per file as well.
    expect(view.state.doc.toString()).toBe("alpha one");
});

test("the first edit of a clean buffer reports it once, and dirtiness follows the text", () => {
    const { workspace } = createWorkspace();
    const onBecameDirty = vi.fn();

    const view = show(workspace, {
        key: "a",
        deviceContent: "text",
        handlers: { current: { ...noHandlers.current, onBecameDirty } },
    });

    view.dispatch({ changes: { from: 4, insert: "!" } });
    view.dispatch({ changes: { from: 5, insert: "!" } });
    // Only the change away from the device text opens the file.
    expect(onBecameDirty).toHaveBeenCalledOnce();
    // The buffer's own document drives the dirty status.
    expect(workspace.getSnapshot().get("a")?.isDirty).toBe(true);

    undo(view);
    // Undoing back to the device text makes the buffer clean again.
    expect(workspace.getSnapshot().get("a")?.isDirty).toBe(false);
});

test("device changes reach clean buffers outside history and only warn for dirty ones", () => {
    const { workspace } = createWorkspace();

    const view = show(workspace, {
        key: "a",
        deviceContent: "line one\nline two",
    });

    view.dispatch({ selection: { anchor: 3 } });

    workspace.applyDeviceContent("a", "line one\nline 2");
    // A clean buffer shows the new device text.
    expect(view.state.doc.toString()).toBe("line one\nline 2");
    // The caret before the external edit stays where it was.
    expect(view.state.selection.main.head).toBe(3);
    // The device change is not something the user can undo.
    expect(undoDepth(view.state)).toBe(0);

    view.dispatch({ changes: { from: 0, insert: "mine " } });
    workspace.applyDeviceContent("a", "device rewrote it");
    // A dirty buffer keeps the browser text, whatever the device holds.
    expect(view.state.doc.toString()).toBe("mine line one\nline 2");
    // The user is told that the device changed under the edits.
    expect(workspace.getSnapshot().get("a")).toEqual({
        isDirty: true,
        conflict: "device rewrote it",
    });

    workspace.discard("a", "device rewrote it");
    // Discarding loads the device text and clears the warning.
    expect(view.state.doc.toString()).toBe("device rewrote it");
    expect(workspace.getSnapshot().get("a")).toEqual({
        isDirty: false,
        conflict: null,
    });
    // Discarded edits cannot come back through undo.
    expect(undoDepth(view.state)).toBe(0);
});

test("open buffers are written debounced and restored with their history on another computer", async () => {
    const api = new FakeBufferApi();
    const first = createWorkspace(api).workspace;
    first.setOpenKeys(["a"]);
    const view = show(first, { key: "a", deviceContent: "saved" });

    view.dispatch({
        changes: { from: 5, insert: " draft" },
        selection: { anchor: 2 },
    });

    // Typing does not write on every keystroke.
    expect(api.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    // One write follows the pause.
    expect(api.writes).toHaveLength(1);

    view.dispatch({ changes: { from: 0, insert: ">" } });
    await vi.advanceTimersByTimeAsync(1000);
    // Each pause writes the buffer again, without any revision bookkeeping.
    expect(api.writes).toHaveLength(2);

    first.deactivate(container);
    const second = createWorkspace(api).workspace;
    second.setOpenKeys(["a"]);

    const restored = show(second, {
        key: "a",
        deviceContent: "saved",
        stored: api.read("a"),
    });

    // The unsaved text continues on the other computer.
    expect(restored.state.doc.toString()).toBe(">saved draft");
    // It is still unsaved relative to the device.
    expect(second.getSnapshot().get("a")?.isDirty).toBe(true);
    undo(restored);
    // The undo history came along.
    expect(restored.state.doc.toString()).toBe("saved draft");
});

test("each buffer write reports the caret line for the open files list", async () => {
    const { workspace, caretLines } = createWorkspace();
    workspace.setOpenKeys(["a"]);

    const view = show(workspace, {
        key: "a",
        deviceContent: "one\ntwo\nthree",
    });

    view.dispatch({ selection: { anchor: 4 } });
    // The line is reported with the debounced write, not on every caret move.
    expect(caretLines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    // The write carries the line the caret is on.
    expect(caretLines).toEqual([{ key: "a", line: 2, appliedReveal: null }]);
});

test("scrolling alone never writes, and hiding the page only writes what changed", async () => {
    const api = new FakeBufferApi();
    const { workspace, view } = await syncedFile(api);
    const writesAfterSync = api.writes.length;

    await vi.advanceTimersByTimeAsync(5000);
    // Without a document or selection change nothing is written.
    expect(api.writes).toHaveLength(writesAfterSync);

    workspace.flush();
    await vi.advanceTimersByTimeAsync(0);
    // Leaving the page with nothing new (and no scroll movement) writes nothing either.
    expect(api.writes).toHaveLength(writesAfterSync);

    view.dispatch({ selection: { anchor: 4 } });
    workspace.flush();
    await vi.advanceTimersByTimeAsync(0);
    // Leaving the page writes a pending change at once instead of after the debounce.
    expect(api.writes).toHaveLength(writesAfterSync + 1);
});

test("a restored dirty buffer warns when the device changed while the page was closed", async () => {
    const api = new FakeBufferApi();
    const first = createWorkspace(api).workspace;
    first.setOpenKeys(["a"]);
    const view = show(first, { key: "a", deviceContent: "base" });
    view.dispatch({ changes: { from: 4, insert: " edit" } });
    await vi.advanceTimersByTimeAsync(1000);
    first.deactivate(container);

    const reloaded = createWorkspace(api).workspace;
    reloaded.setOpenKeys(["a"]);

    const restored = show(reloaded, {
        key: "a",
        deviceContent: "changed on device",
        stored: api.read("a"),
    });

    // The browser version wins over the device text.
    expect(restored.state.doc.toString()).toBe("base edit");
    // The change on the device is reported against the stored base.
    expect(reloaded.getSnapshot().get("a")?.conflict).toBe("changed on device");
});

test("a newer copy from another computer is adopted on focus when nothing is unwritten", async () => {
    const api = new FakeBufferApi();
    const { workspace, view } = await syncedFile(api);
    const ownCopy = api.read("a");

    workspace.receiveStored("a", ownCopy);
    // Refocusing the window returns this tab's own write, which must not move anything.
    expect(view.state.selection.main.head).toBe(2);

    // Another computer continues the file: its edit and caret are stored under a new version.
    const elsewhere = view.state.update({
        changes: { from: 9, insert: " more" },
        selection: { anchor: 14 },
    }).state;

    api.store("a", { ...ownCopy?.data, state: elsewhere.toJSON() });
    workspace.receiveStored("a", api.read("a"));
    // Coming back to this computer continues exactly where the other one stopped.
    expect(view.state.doc.toString()).toBe("base text more");
    expect(view.state.selection.main.head).toBe(14);
});

test("a fetch arriving after a local edit or move never moves the cursor", async () => {
    const api = new FakeBufferApi();
    const { workspace, view } = await syncedFile(api);
    const ownCopy = api.read("a");

    const elsewhere = view.state.update({
        changes: { from: 0, insert: "remote " },
        selection: { anchor: 0 },
    }).state;

    api.store("a", { ...ownCopy?.data, state: elsewhere.toJSON() });
    const newerCopy = api.read("a");

    // The user moves the caret before the focus read returns.
    view.dispatch({ selection: { anchor: 5 } });
    workspace.receiveStored("a", newerCopy);
    // Local changes the server has not seen win over the copy that arrived after them.
    expect(view.state.doc.toString()).toBe("base text");
    expect(view.state.selection.main.head).toBe(5);

    await vi.advanceTimersByTimeAsync(1000);
    // This tab's write is now the newest (last writer wins).
    expect(api.read("a")?.version).toBeGreaterThan(newerCopy?.version ?? 0);

    workspace.receiveStored("a", newerCopy);
    // The same slow read landing after the write is older than it, so nothing moves.
    expect(view.state.doc.toString()).toBe("base text");
    expect(view.state.selection.main.head).toBe(5);
});

test("closing a file discards its edits and deletes its stored copy", async () => {
    const api = new FakeBufferApi();
    const { workspace, view } = await syncedFile(api);
    view.dispatch({ changes: { from: 0, insert: "draft " } });

    workspace.close("a");
    await vi.advanceTimersByTimeAsync(5000);
    // The shown file falls back to the device text.
    expect(view.state.doc.toString()).toBe("base text");
    // The stored copy is deleted, so the draft cannot come back on another computer.
    expect(api.deletes).toEqual(["a"]);
    expect(api.read("a")).toBeNull();
    // No write follows for a closed file.
    expect(api.writes).toHaveLength(1);
});

test("discarding tells the chrome about the replaced state, since setState emits no update", () => {
    const { workspace } = createWorkspace();
    const replaced: EditorState[] = [];

    const view = show(workspace, {
        key: "a",
        deviceContent: "base text",
        handlers: {
            current: {
                ...noHandlers.current,
                onStateReplaced: (state) => replaced.push(state),
            },
        },
    });

    view.dispatch({
        changes: { from: 0, insert: "draft " },
        selection: { anchor: 0, head: 5 },
    });
    workspace.discard("a", "base text");
    // Without this the Copy selection action would still offer the discarded "draft".
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.selection.main.empty).toBe(true);
});

test("a line request of the open files list is shown once, also after moving to another computer", async () => {
    const api = new FakeBufferApi();
    const first = createWorkspace(api).workspace;
    first.setOpenKeys(["a"]);
    const content = "one\ntwo\nthree\nfour";
    const reveal = { line: 3, entry: "r1" };

    const view = show(first, {
        key: "a",
        deviceContent: content,
        lineTargets: { link: null, reveal },
    });

    // The requested line is selected when the file is first shown.
    expect(
        view.state.sliceDoc(
            view.state.selection.main.from,
            view.state.selection.main.to,
        ),
    ).toBe("three");

    view.dispatch({ selection: { anchor: 0 } });
    first.goToLine("a", { link: null, reveal });
    // The same request does not pull the caret back once it was applied.
    expect(view.state.selection.main.head).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    first.deactivate(container);
    const second = createWorkspace(api).workspace;
    second.setOpenKeys(["a"]);

    const restored = show(second, {
        key: "a",
        deviceContent: content,
        stored: api.read("a"),
        lineTargets: { link: null, reveal },
    });

    // The applied request is stored with the buffer, so another computer keeps the caret.
    expect(restored.state.selection.main.head).toBe(0);

    second.goToLine("a", { link: null, reveal: { line: 2, entry: "r2" } });
    // A new request for the file on screen moves to its line right away.
    expect(
        restored.state.sliceDoc(
            restored.state.selection.main.from,
            restored.state.selection.main.to,
        ),
    ).toBe("two");
});

test("following a link to a file supersedes its pending line request", () => {
    const { workspace } = createWorkspace();
    workspace.setOpenKeys(["a"]);
    const content = "one\ntwo\nthree\nfour";
    const reveal = { line: 3, entry: "r1" };

    const view = show(workspace, {
        key: "a",
        deviceContent: content,
        lineTargets: { link: { line: 4, entry: "history-1" }, reveal },
    });

    // The link is the newer, explicit choice, so its line wins.
    expect(
        view.state.sliceDoc(
            view.state.selection.main.from,
            view.state.selection.main.to,
        ),
    ).toBe("four");

    workspace.goToLine("a", { link: null, reveal });
    // The request counts as applied, so it does not move the caret later.
    expect(
        view.state.sliceDoc(
            view.state.selection.main.from,
            view.state.selection.main.to,
        ),
    ).toBe("four");
});

/** The Git gutter marks of the shown state, as `line:change:staged` for compact asserts. */
function gitMarks(view: EditorView) {
    const marks: string[] = [];
    const cursor = view.state.field(gitGutterField).markers.iter();

    while (cursor.value !== null) {
        const element = cursor.value.toDOM?.(view);
        const line = view.state.doc.lineAt(cursor.from).number;
        const data = element instanceof HTMLElement ? element.dataset : {};
        marks.push(
            `${String(line)}:${data.gitLineChange ?? "?"}:${data.gitLineStaged ?? "?"}`,
        );
        cursor.next();
    }

    return marks;
}

test("the Git gutter follows typing after a pause and survives a discard", async () => {
    const { workspace } = createWorkspace();
    const view = show(workspace, { key: "a", deviceContent: "one\ntwo\n" });
    // Outside a repository the gutter is not part of the editor at all.
    expect(view.dom.querySelector(".cm-gitGutter")).toBeNull();

    const source = gitGutterSource({
        status: "bases",
        index: "one\ntwo\n",
        head: { type: "same_as_index" },
    });

    workspace.setGitGutter("a", source);
    // Inside one it appears, with no marks while the buffer equals the index.
    expect(view.dom.querySelector(".cm-gitGutter")).not.toBeNull();
    expect(gitMarks(view)).toEqual([]);

    view.dispatch({ changes: { from: 0, insert: "zero\n" } });
    // The diff waits for a pause in typing instead of running per keystroke.
    expect(gitMarks(view)).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    // The inserted line is compared with the index once typing paused.
    expect(gitMarks(view)).toEqual(["1:added:false"]);

    workspace.discard("a", "ONE\ntwo\n");
    // A discard builds a new state, which must keep the gutter and mark the new text.
    expect(gitMarks(view)).toEqual(["1:modified:false"]);

    workspace.setGitGutter("a", GIT_GUTTER_HIDDEN);
    // Leaving the repository removes the gutter again.
    expect(view.dom.querySelector(".cm-gitGutter")).toBeNull();
});
