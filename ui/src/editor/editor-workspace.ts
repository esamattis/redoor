import { historyField } from "@codemirror/commands";
import { isVaultPath } from "#ui/vault/vault-path";
import {
    EditorSelection,
    EditorState,
    Text,
    Transaction,
    type StateEffect,
} from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { MutationObserver, type QueryClient } from "@tanstack/react-query";
import type { DeleteEditorBufferResponse } from "#bindings/DeleteEditorBufferResponse";
import type { PutEditorBufferRequest } from "#bindings/PutEditorBufferRequest";
import type { PutEditorBufferResponse } from "#bindings/PutEditorBufferResponse";
import type { ApiClient } from "#ui/api-client";
import { ExternalStore } from "#ui/utils/external-store";
import {
    baseFromText,
    isDirtyAgainst,
    reconcileDeviceContent,
    textFromString,
    type BufferBase,
} from "./buffer-sync";
import { EditorConfiguration, type EditorSettings } from "./editor-extensions";
import { GIT_GUTTER_HIDDEN, type GitGutterSource } from "./git-gutter";
import {
    MAX_STORED_BUFFER_CHARS,
    type StoredBuffer,
    type StoredBufferData,
    type StoredScroll,
} from "./stored-buffer";

/** What the editor chrome shows about one buffer. */
export type BufferStatus = {
    isDirty: boolean;
    /** Device text that changed under unsaved edits, or null without a conflict. */
    conflict: string | null;
};

/** Callbacks of the editor component currently showing the shared view. */
export type EditorHandlers = {
    onUpdate: (update: ViewUpdate) => void;
    onFocus: () => void;
    onSave: () => void;
    /** The first edit that makes a clean buffer dirty, which opens the file. */
    onBecameDirty: () => void;
    /**
     * The shown state was swapped without a view update (discard or an adopted server copy),
     * so chrome mirroring the selection must re-read it instead of keeping the old one.
     */
    onStateReplaced: (state: EditorState) => void;
};

/** Where `?line=` asks to go, and the history entry that asked, so it applies only once. */
export type LineTarget = { line: number; entry: string };

/**
 * The lines a shown file is asked to go to. `link` comes from a `?line=` URL and `reveal`
 * from the open files list, when the file was opened from a diff or search result without
 * going to it. Each is applied once, remembered by its own entry in the buffer, and a link
 * wins over a reveal because following a link is the newer, explicit choice.
 */
export type LineTargets = {
    link: LineTarget | null;
    reveal: LineTarget | null;
};

/**
 * Where an open file's caret was when its buffer was written. `appliedReveal` is the line
 * request the buffer has already shown, so a caret written before a newer request is shown
 * cannot replace that request in the open files list.
 */
export type CaretReport = {
    key: string;
    line: number;
    appliedReveal: string | null;
};

/** Everything needed to show one file in the shared view. */
export type ActivateRequest = {
    container: HTMLElement;
    key: string;
    fileName: string;
    deviceContent: string;
    stored: StoredBuffer | null;
    settings: EditorSettings;
    lineTargets: LineTargets;
    handlers: { readonly current: EditorHandlers };
};

/** The server calls the workspace makes, so tests can stand in for the API. */
export type EditorBufferApi = Pick<
    ApiClient,
    "putEditorBuffer" | "deleteEditorBuffer"
>;

/**
 * Debounce before a changed buffer is written, so typing sends one request per pause
 * instead of one per keystroke.
 */
const WRITE_DELAY_MS = 1000;

/** Delay before retrying a failed write, longer so an outage is not hammered. */
const RETRY_DELAY_MS = 5000;

/**
 * A browser `fetch` with `keepalive` may carry at most 64 KiB, so only smaller final writes
 * can be promised to outlive a closing page. The limit is in bytes, not characters.
 */
const KEEPALIVE_LIMIT_BYTES = 60 * 1024;

/** One buffer write, as the mutation that sends it sees it. */
type BufferWrite = {
    key: string;
    request: PutEditorBufferRequest;
    keepalive: boolean;
};

/** One file's editor state while it is open or previewed. */
type FileBuffer = {
    key: string;
    fileName: string;
    /** The latest state; the shared view's state is newer while the buffer is shown. */
    state: EditorState;
    base: BufferBase;
    /** The device text last seen, which a discard or close restores. */
    device: Text;
    conflict: string | null;
    isDirty: boolean;
    /** The exact in-memory scroll position, restored when switching back. */
    scroll: StateEffect<unknown> | null;
    /** The serializable scroll position, for the server copy. */
    storedScroll: StoredScroll | null;
    /** The scroll position the last write carried, so leaving only rewrites a moved one. */
    writtenScroll: StoredScroll | null;
    lineEntry: string | null;
    /** The open files list's line request already applied. */
    revealEntry: string | null;
    /** The server version this tab last wrote or adopted, or null if it has none. */
    lastSeenVersion: number | null;
    /** Document or selection changes the server has not been sent yet. */
    unsynced: boolean;
    /**
     * What the Git gutter shows. Kept beside the state because a discard or an adopted server
     * copy builds a new state, which must get the gutter back.
     */
    gitGutter: GitGutterSource;
};

/**
 * Owns the single CodeMirror view of the page and the buffers of open files.
 *
 * Only one `EditorView` ever exists. Switching files saves the outgoing state and scroll
 * snapshot in its buffer and swaps the incoming buffer's state in with `setState`, so each
 * open file keeps its own caret, selection, scroll position and undo history without
 * several CodeMirror instances. The view's DOM moves to whichever editor component is
 * mounted; it outlives routes like the terminal sessions do.
 *
 * Open files' buffers are written to the server, so a user can leave one computer and
 * continue on another exactly where they were. The server copy is last-writer-wins, since one
 * user works from one computer at a time. Reading it is the only thing that may move the
 * caret, and only when the copy is newer than anything this tab wrote or adopted and this tab
 * has no unwritten changes, so the caret never jumps under the user.
 */
export class EditorWorkspace extends ExternalStore<
    ReadonlyMap<string, BufferStatus>
> {
    private readonly buffers = new Map<string, FileBuffer>();
    private readonly configuration: EditorConfiguration;
    private readonly timers = new Map<string, number>();
    /** The server request chain of each key, so its writes and its delete never overlap. */
    private readonly requests = new Map<string, Promise<void>>();
    private readonly documentListeners = new Set<() => void>();
    private openKeys = new Set<string>();
    private view: EditorView | null = null;
    private activeKey: string | null = null;
    private handlers: { readonly current: EditorHandlers } | null = null;
    private settings: EditorSettings | null = null;
    /** A scroll requested on activation that the view has not applied yet. */
    private pendingScroll: StateEffect<unknown> | null = null;
    /** Sends buffer writes as query mutations, so they show up like every other write. */
    private readonly writes: MutationObserver<
        PutEditorBufferResponse,
        Error,
        BufferWrite
    >;

    private readonly deletes: MutationObserver<
        DeleteEditorBufferResponse,
        Error,
        string
    >;

    /**
     * Wires CodeMirror callbacks to whichever editor component is mounted at call time.
     * `onCaretLine` hears an open file's caret line whenever its buffer is written, so the
     * open files list can show where each file was left without loading the buffers.
     */
    constructor(
        api: EditorBufferApi,
        queryClient: QueryClient,
        private readonly onCaretLine: (caret: CaretReport) => void = () =>
            undefined,
    ) {
        super(new Map());

        this.writes = new MutationObserver(queryClient, {
            mutationFn: (write: BufferWrite) =>
                api.putEditorBuffer(write.key, write.request, write.keepalive),
        });

        this.deletes = new MutationObserver(queryClient, {
            mutationFn: (key: string) => api.deleteEditorBuffer(key),
        });

        this.configuration = new EditorConfiguration({
            onUpdate: (update) => this.onViewUpdate(update),
            onFocus: () => this.handlers?.current.onFocus(),
            onSave: () => {
                this.handlers?.current.onSave();
                this.view?.focus();
            },
        });
    }

    /**
     * Writes pending buffers and moved scroll positions when the page is hidden or closed:
     * that is the moment the user may walk to another computer.
     */
    start(target: Window) {
        target.addEventListener("pagehide", () => this.flush());

        target.document.addEventListener("visibilitychange", () => {
            if (target.document.visibilityState === "hidden") {
                this.flush();
            }
        });
    }

    /** Subscribes to document changes, for views that render the text (markdown preview). */
    readonly subscribeDocument = (listener: () => void) => {
        this.documentListeners.add(listener);

        return () => {
            this.documentListeners.delete(listener);
        };
    };

    /** The current text of a buffer, or an empty string if it is not loaded. */
    text(key: string): string {
        const buffer = this.buffers.get(key);

        return buffer === undefined
            ? ""
            : this.currentState(buffer).doc.toString();
    }

    /** Whether a loaded buffer has unsaved edits; undefined when it is not in memory. */
    isDirty(key: string): boolean | undefined {
        return this.buffers.get(key)?.isDirty;
    }

    /**
     * Records which files are open. Buffers of closed files are dropped (except the one on
     * screen, which becomes a preview), and a file opened by its first edit gets written.
     */
    setOpenKeys(keys: readonly string[]) {
        this.openKeys = new Set(keys);

        for (const buffer of this.buffers.values()) {
            if (this.openKeys.has(buffer.key)) {
                if (buffer.unsynced) {
                    this.schedule(buffer.key, WRITE_DELAY_MS);
                }
            } else {
                window.clearTimeout(this.timers.get(buffer.key));
                this.timers.delete(buffer.key);

                if (buffer.key !== this.activeKey) {
                    this.buffers.delete(buffer.key);
                }
            }
        }

        this.publishStatuses();
    }

    /**
     * Shows a file in the shared view, creating its buffer from memory, the server copy or the
     * device text, and restoring its scroll position or applying a new line target.
     */
    activate(request: ActivateRequest): EditorView {
        const view = this.ensureView(request.settings);

        if (view.dom.parentElement !== request.container) {
            request.container.append(view.dom);
        }

        if (this.activeKey !== null && this.activeKey !== request.key) {
            this.stashActive();
        }

        this.handlers = request.handlers;
        this.settings = request.settings;

        const buffer =
            this.buffers.get(request.key) ?? this.createBuffer(request);

        this.buffers.set(request.key, buffer);
        this.dropPreviews(request.key);
        this.activeKey = request.key;
        view.setState(buffer.state);
        this.reconfigure();
        this.receiveStored(request.key, request.stored);
        this.applyDeviceContent(request.key, request.deviceContent);
        this.restoreScroll(buffer, request.lineTargets);
        this.publishStatuses();
        this.notifyDocument();

        return view;
    }

    /** Detaches the view from a component that unmounts, keeping the buffer for later. */
    deactivate(container: HTMLElement) {
        const view = this.view;

        if (view === null || view.dom.parentElement !== container) {
            return;
        }

        this.stashActive();
        view.dom.remove();
        this.activeKey = null;
        this.handlers = null;
    }

    /**
     * Follows a `?line=` link or a line request of the open files list to the file already on
     * screen. A target is applied once per entry, so re-rendering or coming back to the same
     * history entry keeps the user's place.
     */
    goToLine(key: string, lineTargets: LineTargets) {
        const buffer = this.buffers.get(key);

        if (
            buffer !== undefined &&
            this.isShown(key) &&
            pendingLineTarget(buffer, lineTargets) !== null
        ) {
            this.restoreScroll(buffer, lineTargets);
        }
    }

    /**
     * Shows, hides or fills a buffer's Git gutter. A buffer that is not on screen gets it when
     * it is activated next.
     */
    setGitGutter(key: string, source: GitGutterSource) {
        const buffer = this.buffers.get(key);

        if (buffer === undefined || buffer.gitGutter === source) {
            return;
        }

        buffer.gitGutter = source;

        if (this.isShown(key)) {
            this.reconfigure();
        }
    }

    /** Brings the shown buffer up to date with changed preferences. */
    applySettings(settings: EditorSettings) {
        this.settings = settings;
        this.reconfigure();
    }

    /**
     * Applies device text to a buffer under the conflict rule: a clean buffer takes it as a
     * minimal change outside the undo history, a dirty one keeps its text and records a
     * conflict when the device moved away from the text the edits are based on.
     */
    applyDeviceContent(key: string, content: string) {
        const buffer = this.buffers.get(key);

        if (buffer === undefined) {
            return;
        }

        const device = textFromString(content);
        buffer.device = device;

        const action = reconcileDeviceContent(
            this.currentState(buffer).doc,
            buffer.base,
            device,
        );

        if (action.kind === "unchanged" || action.kind === "conflict") {
            // A base known only by hash after a reload becomes known text once it matches.
            if (action.kind === "unchanged") {
                buffer.base = { text: device, hash: buffer.base.hash };
            }

            // Edits stay based on the old text, so a conflict holds until saved or discarded.
            this.setConflict(
                buffer,
                action.kind === "conflict" ? content : null,
            );
            this.refreshDirty(buffer);

            return;
        }

        buffer.base = baseFromText(device);
        this.setConflict(buffer, null);

        if (action.kind === "apply") {
            const spec = {
                changes: action.changes,
                annotations: Transaction.addToHistory.of(false),
            };

            if (this.isShown(key) && this.view !== null) {
                this.view.dispatch(spec);
            } else {
                buffer.state = buffer.state.update(spec).state;
                this.markChanged(buffer);
            }
        }

        this.refreshDirty(buffer);
    }

    /**
     * Adopts the server copy when another computer wrote it: its version is newer than any
     * this tab wrote or adopted, and this tab has nothing unwritten. Local changes win over
     * a copy that arrives after them; their next write replaces it. Versions only grow, so a
     * slow read that returns after this tab's own newer write is ignored too.
     */
    receiveStored(key: string, stored: StoredBuffer | null) {
        const buffer = this.buffers.get(key);

        if (
            buffer === undefined ||
            stored === null ||
            buffer.unsynced ||
            this.requests.has(key) ||
            (buffer.lastSeenVersion !== null &&
                stored.version <= buffer.lastSeenVersion)
        ) {
            return;
        }

        const state = this.stateFromStored(stored.data, buffer.fileName);

        if (state === null) {
            return;
        }

        buffer.state = state;
        buffer.lastSeenVersion = stored.version;
        buffer.storedScroll = stored.data.scroll;
        buffer.writtenScroll = stored.data.scroll;
        buffer.scroll = null;
        buffer.lineEntry = stored.data.lineEntry;
        buffer.revealEntry = stored.data.revealEntry;
        buffer.base = { text: null, hash: stored.data.baseHash };

        if (this.isShown(key) && this.view !== null) {
            this.replaceShownState(this.view, state);
            this.restoreScroll(buffer, NO_LINE_TARGETS);
        }

        // The copy may be based on other device text than this tab last saw.
        this.applyDeviceContent(key, buffer.device.toString());
        this.notifyDocument();
    }

    /**
     * Makes device text the base the buffer's edits are compared against: after a save the
     * buffer is clean again, and after "Keep my changes" the edits stay dirty but no longer
     * conflict, so the warning returns only if the device changes once more.
     */
    rebase(key: string, content: string) {
        const buffer = this.buffers.get(key);

        if (buffer === undefined) {
            return;
        }

        buffer.device = textFromString(content);
        buffer.base = baseFromText(buffer.device);
        this.setConflict(buffer, null);
        this.refreshDirty(buffer);
        this.markChanged(buffer);
    }

    /**
     * Throws away unsaved edits for the given device text. The undo history starts over,
     * since undoing into text that was explicitly discarded would bring it back by accident.
     */
    discard(key: string, content: string) {
        const buffer = this.buffers.get(key);

        if (buffer === undefined) {
            return;
        }

        const previous = this.currentState(buffer).selection.main.head;
        const state = this.createState(buffer.fileName, content, previous);
        buffer.state = state;
        buffer.device = state.doc;
        buffer.base = baseFromText(state.doc);
        this.setConflict(buffer, null);

        if (this.isShown(key) && this.view !== null) {
            const scroll = this.view.scrollSnapshot();
            this.replaceShownState(this.view, state);
            this.view.dispatch({ effects: scroll });
        }

        this.refreshDirty(buffer);
        this.markChanged(buffer);
        this.notifyDocument();
    }

    /**
     * Closes a file: its stored copy is deleted (after any write still in flight), its edits
     * are discarded, and a buffer on screen stays as a clean preview while others are
     * dropped. The server also deletes copies of files missing from the open files list.
     */
    close(key: string) {
        const buffer = this.buffers.get(key);
        this.openKeys.delete(key);
        window.clearTimeout(this.timers.get(key));
        this.timers.delete(key);

        this.enqueue(key, async () => {
            await this.deletes.mutate(key).catch(() => undefined);
        });

        if (buffer !== undefined) {
            buffer.lastSeenVersion = null;

            if (this.isShown(key)) {
                this.discard(key, buffer.device.toString());
            } else {
                this.buffers.delete(key);
            }

            buffer.unsynced = false;
        }

        this.publishStatuses();
    }

    /**
     * Writes every open buffer with unwritten changes now, also when only its scroll position
     * moved, for a page that is hidden or going away.
     */
    flush() {
        const shown =
            this.activeKey === null
                ? undefined
                : this.buffers.get(this.activeKey);

        if (shown !== undefined) {
            this.stashScroll(shown);
        }

        for (const buffer of this.buffers.values()) {
            // Buffers switched away from stashed their scroll at that moment, so they count too.
            const scrolled = !sameScroll(
                buffer.storedScroll,
                buffer.writtenScroll,
            );

            if (
                this.openKeys.has(buffer.key) &&
                (buffer.unsynced || scrolled)
            ) {
                window.clearTimeout(this.timers.get(buffer.key));
                this.timers.delete(buffer.key);
                this.enqueue(buffer.key, () => this.write(buffer.key, true));
            }
        }
    }

    /** Creates the one view lazily, so pages without an editor never build it. */
    private ensureView(settings: EditorSettings) {
        if (this.view === null) {
            this.settings = settings;
            this.view = new EditorView({ state: this.createState("", "", 0) });
        }

        return this.view;
    }

    /** Builds a fresh state for a file with the shared extensions. */
    private createState(fileName: string, content: string, head: number) {
        return EditorState.create({
            doc: content,
            selection: EditorSelection.cursor(Math.min(head, content.length)),
            extensions: this.configuration.forFile(
                fileName,
                content,
                this.requireSettings(),
            ),
        });
    }

    /** The settings are known once anything was activated, which precedes every use. */
    private requireSettings(): EditorSettings {
        if (this.settings === null) {
            throw new Error("Editor settings are not known before activation");
        }

        return this.settings;
    }

    /** Restores CodeMirror JSON, or null if it does not fit the current editor. */
    private stateFromStored(data: StoredBufferData, fileName: string) {
        try {
            return EditorState.fromJSON(
                data.state,
                {
                    extensions: this.configuration.forFile(
                        fileName,
                        "",
                        this.requireSettings(),
                    ),
                },
                { history: historyField },
            );
        } catch {
            return null;
        }
    }

    /** Creates the buffer of a file shown for the first time in this tab. */
    private createBuffer(request: ActivateRequest): FileBuffer {
        const device = textFromString(request.deviceContent);

        const restored =
            request.stored === null
                ? null
                : this.stateFromStored(request.stored.data, request.fileName);

        const buffer: FileBuffer = {
            key: request.key,
            fileName: request.fileName,
            state:
                restored ??
                this.createState(request.fileName, request.deviceContent, 0),
            base: baseFromText(device),
            device,
            conflict: null,
            isDirty: false,
            scroll: null,
            storedScroll: null,
            writtenScroll: null,
            lineEntry: null,
            revealEntry: null,
            lastSeenVersion: null,
            unsynced: false,
            gitGutter: GIT_GUTTER_HIDDEN,
        };

        if (request.stored !== null && restored !== null) {
            const data = request.stored.data;
            buffer.base = { text: null, hash: data.baseHash };
            buffer.isDirty = data.dirty;
            buffer.storedScroll = data.scroll;
            buffer.writtenScroll = data.scroll;
            buffer.lineEntry = data.lineEntry;
            buffer.revealEntry = data.revealEntry;
            buffer.lastSeenVersion = request.stored.version;
        }

        return buffer;
    }

    /** Drops the previous preview, since only open files keep their buffers. */
    private dropPreviews(activeKey: string) {
        for (const key of this.buffers.keys()) {
            if (key !== activeKey && !this.openKeys.has(key)) {
                this.buffers.delete(key);
            }
        }
    }

    /** Saves the shown buffer's state and scroll position before it leaves the view. */
    private stashActive() {
        const buffer =
            this.activeKey === null
                ? undefined
                : this.buffers.get(this.activeKey);

        if (buffer !== undefined && this.view !== null) {
            buffer.state = this.view.state;
            this.stashScroll(buffer);
        }
    }

    /**
     * Captures the shown buffer's scroll position without writing it; leaving the page writes
     * it. A scroll requested on activation but not applied yet (the component unmounted
     * before the view measured) is kept instead of the top.
     */
    private stashScroll(buffer: FileBuffer) {
        const view = this.view;

        if (
            view === null ||
            !this.isShown(buffer.key) ||
            !view.dom.isConnected
        ) {
            return;
        }

        buffer.scroll = this.pendingScroll ?? view.scrollSnapshot();

        if (this.pendingScroll === null) {
            buffer.storedScroll = storedScrollOf(view);
        }
    }

    /**
     * Applies a new line target once per entry, and otherwise brings back where the buffer
     * was scrolled, so returning to a file never jumps away from the user's place.
     */
    private restoreScroll(buffer: FileBuffer, lineTargets: LineTargets) {
        const view = this.view;

        if (view === null) {
            return;
        }

        let effect: StateEffect<unknown> | null = null;
        const target = pendingLineTarget(buffer, lineTargets);

        if (target !== null) {
            // A link supersedes a pending reveal, so both count as applied. The caret move
            // marks the buffer changed, so the applied entries are written too.
            if (lineTargets.link !== null) {
                buffer.lineEntry = lineTargets.link.entry;
            }

            if (lineTargets.reveal !== null) {
                buffer.revealEntry = lineTargets.reveal.entry;
            }

            effect = moveCaretToLine(view, target.line);
        } else if (buffer.scroll !== null) {
            effect = buffer.scroll;
            view.dispatch({ effects: effect });
        } else if (buffer.storedScroll !== null) {
            effect = EditorView.scrollIntoView(
                Math.min(buffer.storedScroll.anchor, view.state.doc.length),
                { y: "start", yMargin: buffer.storedScroll.yMargin },
            );
            view.dispatch({ effects: effect });
        }

        this.pendingScroll = effect;

        if (effect !== null) {
            view.requestMeasure({
                read: () => null,
                write: () => {
                    this.pendingScroll = null;
                },
            });
        }
    }

    /**
     * Swaps a new state into the shown view. `setState` emits no view update, so the chrome
     * is told directly, or it would keep offering the replaced selection.
     */
    private replaceShownState(view: EditorView, state: EditorState) {
        view.setState(state);
        this.reconfigure();
        this.handlers?.current.onStateReplaced(view.state);
    }

    /**
     * Matches the shown state's compartments to the current preferences and its buffer's Git
     * gutter, which every state swapped into the view passes through.
     */
    private reconfigure() {
        if (this.view === null || this.settings === null) {
            return;
        }

        const shown =
            this.activeKey === null
                ? undefined
                : this.buffers.get(this.activeKey);

        const effects = [
            ...this.configuration.settingsEffects(
                this.view.state,
                this.settings,
            ),
            ...(shown === undefined
                ? []
                : this.configuration.gitGutterEffects(
                      this.view.state,
                      shown.gitGutter,
                  )),
        ];

        if (effects.length > 0) {
            this.view.dispatch({ effects });
        }
    }

    /** Keeps the shown buffer current and decides what a change means for saving and syncing. */
    private onViewUpdate(update: ViewUpdate) {
        const buffer =
            this.activeKey === null
                ? undefined
                : this.buffers.get(this.activeKey);

        if (buffer === undefined || update.view !== this.view) {
            return;
        }

        buffer.state = update.state;

        if (update.docChanged) {
            const wasDirty = buffer.isDirty;
            this.refreshDirty(buffer);
            this.notifyDocument();

            if (!wasDirty && buffer.isDirty) {
                this.handlers?.current.onBecameDirty();
            }
        }

        // Scrolling alone never writes; leaving the page carries the scroll position.
        if (update.docChanged || update.selectionSet) {
            this.markChanged(buffer);
        }

        this.handlers?.current.onUpdate(update);
    }

    /** Notes a change the server has not seen and debounces its write. */
    private markChanged(buffer: FileBuffer) {
        buffer.unsynced = true;
        this.schedule(buffer.key, WRITE_DELAY_MS);
    }

    /** Recomputes the dirty flag and announces it when it flips. */
    private refreshDirty(buffer: FileBuffer) {
        const isDirty = isDirtyAgainst(
            this.currentState(buffer).doc,
            buffer.base,
        );

        if (isDirty !== buffer.isDirty) {
            buffer.isDirty = isDirty;
            this.publishStatuses();
        }
    }

    /** Updates the conflict text and announces a change. */
    private setConflict(buffer: FileBuffer, conflict: string | null) {
        if (buffer.conflict !== conflict) {
            buffer.conflict = conflict;
            this.publishStatuses();
        }
    }

    /** Whether a buffer is the one in the view right now. */
    private isShown(key: string) {
        return this.activeKey === key;
    }

    /** The newest state of a buffer, which is the view's while it is shown. */
    private currentState(buffer: FileBuffer) {
        return this.isShown(buffer.key) && this.view !== null
            ? this.view.state
            : buffer.state;
    }

    /**
     * Debounces a write of an open file's buffer. Vault files are never written (see
     * `write`), so they are not scheduled either.
     */
    private schedule(key: string, delay: number) {
        if (!this.openKeys.has(key) || isVaultPath(key)) {
            return;
        }

        window.clearTimeout(this.timers.get(key));

        this.timers.set(
            key,
            window.setTimeout(() => {
                this.timers.delete(key);
                this.enqueue(key, () => this.write(key, false));
            }, delay),
        );
    }

    /**
     * Runs one server request of a key after the previous one, so a second write waits for
     * the first instead of racing it, and a delete lands after any write still in flight.
     */
    private enqueue(key: string, request: () => Promise<void>) {
        const next = (this.requests.get(key) ?? Promise.resolve()).then(
            request,
        );

        this.requests.set(key, next);

        void next.finally(() => {
            if (this.requests.get(key) === next) {
                this.requests.delete(key);
            }
        });
    }

    /**
     * Writes one buffer as it is now and remembers the version the server gave it, so this
     * tab never adopts its own write. A failed write is retried later.
     */
    private async write(key: string, keepalive: boolean) {
        const buffer = this.buffers.get(key);

        // Every write path ends here, so this is the one check that keeps a vault file's
        // plaintext draft in the browser.
        if (
            buffer === undefined ||
            !this.openKeys.has(key) ||
            isVaultPath(key)
        ) {
            return;
        }

        const state = this.currentState(buffer);
        this.onCaretLine({
            key,
            line: state.doc.lineAt(state.selection.main.head).number,
            appliedReveal: buffer.revealEntry,
        });
        const data = this.serialize(buffer);
        buffer.unsynced = false;

        if (data === null) {
            return;
        }

        const bodyBytes = new TextEncoder().encode(JSON.stringify(data)).length;

        try {
            const response = await this.writes.mutate({
                key,
                request: { data },
                keepalive: keepalive && bodyBytes < KEEPALIVE_LIMIT_BYTES,
            });

            if (this.buffers.get(key) === buffer && this.openKeys.has(key)) {
                buffer.lastSeenVersion = response.version;
                buffer.writtenScroll = data.scroll;
            }
        } catch {
            if (this.buffers.get(key) === buffer && this.openKeys.has(key)) {
                buffer.unsynced = true;
                this.schedule(key, RETRY_DELAY_MS);
            }
        }
    }

    /**
     * Turns a buffer into its stored form, with the scroll position read from the view when
     * it is shown. Oversized buffers drop their undo history first and are skipped if even
     * the document is too large.
     */
    private serialize(buffer: FileBuffer): StoredBufferData | null {
        const state = this.currentState(buffer);
        this.stashScroll(buffer);

        const data: StoredBufferData = {
            version: 1,
            state: state.toJSON({ history: historyField }),
            baseHash: buffer.base.hash,
            scroll: buffer.storedScroll,
            lineEntry: buffer.lineEntry,
            revealEntry: buffer.revealEntry,
            dirty: buffer.isDirty,
        };

        if (JSON.stringify(data).length <= MAX_STORED_BUFFER_CHARS) {
            return data;
        }

        const withoutHistory = { ...data, state: state.toJSON() };

        return JSON.stringify(withoutHistory).length <= MAX_STORED_BUFFER_CHARS
            ? withoutHistory
            : null;
    }

    /** Publishes every loaded buffer's status for the editor chrome. */
    private publishStatuses() {
        const statuses = new Map<string, BufferStatus>();

        for (const buffer of this.buffers.values()) {
            statuses.set(buffer.key, {
                isDirty: buffer.isDirty,
                conflict: buffer.conflict,
            });
        }

        this.publish(statuses);
    }

    /** Wakes views that render a buffer's text. */
    private notifyDocument() {
        for (const listener of this.documentListeners) {
            listener();
        }
    }
}

/** Shows a file where it was, for a state swapped in without any line to go to. */
const NO_LINE_TARGETS: LineTargets = { link: null, reveal: null };

/**
 * The line a buffer should go to now: a `?line=` link not applied yet, otherwise a line
 * request of the open files list not applied yet, otherwise none.
 */
function pendingLineTarget(
    buffer: FileBuffer,
    lineTargets: LineTargets,
): LineTarget | null {
    if (
        lineTargets.link !== null &&
        lineTargets.link.entry !== buffer.lineEntry
    ) {
        return lineTargets.link;
    }

    if (
        lineTargets.reveal !== null &&
        lineTargets.reveal.entry !== buffer.revealEntry
    ) {
        return lineTargets.reveal;
    }

    return null;
}

/** Reads the view's scroll position in the form stored on the server. */
function storedScrollOf(view: EditorView): StoredScroll {
    const target = view.scrollSnapshot().value;

    return { anchor: target.range.head, yMargin: target.yMargin };
}

/** Whether two stored scroll positions are the same place. */
function sameScroll(a: StoredScroll | null, b: StoredScroll | null) {
    return a?.anchor === b?.anchor && a?.yMargin === b?.yMargin;
}

/**
 * Selects the inbound `?line=` target and centers it so the opened location is obvious in a
 * tall buffer. Returns the scroll effect so a later stash can keep it if it is not applied.
 */
function moveCaretToLine(
    view: EditorView,
    line: number,
): StateEffect<unknown> | null {
    const lineCount = view.state.doc.lines;

    // Empty documents have no real line to reveal.
    if (view.state.doc.length === 0 || lineCount < 1) {
        return null;
    }

    const clamped = Math.min(Math.max(line, 1), lineCount);
    const docLine = view.state.doc.line(clamped);
    const effect = EditorView.scrollIntoView(docLine.from, { y: "center" });

    view.dispatch({
        selection: { anchor: docLine.from, head: docLine.to },
        effects: effect,
    });

    return effect;
}
