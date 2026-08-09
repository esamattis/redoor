import type {
    Agent,
    FileSearchEntry,
    FileSearchResponse,
} from "#ui/api-client";

export const FILE_SEARCH_RESULT_EVENT = "searchresult";

export type FileSearchState =
    | { status: "idle" }
    | {
          status: "searching";
          query: string;
          results: Array<FileSearchEntry>;
          timedOut: boolean;
      }
    | {
          status: "success";
          query: string;
          results: Array<FileSearchEntry>;
          timedOut: boolean;
      }
    | { status: "error"; query: string; message: string };

/** Owns delayed recursive searches so React only needs to render emitted state. */
export class FileSearcher extends EventTarget {
    private readonly agent: Agent;
    private readonly directoryPath: string;
    private inputElement: HTMLInputElement | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pendingQuery: string | null = null;
    private controller: AbortController | null = null;
    private lastResponse: FileSearchResponse | null = null;
    private disposed = false;

    constructor(agent: Agent, directoryPath: string) {
        super();
        this.agent = agent;
        this.directoryPath = directoryPath;
    }

    /** Starts observing one input and includes its current value in the search lifecycle. */
    listenTo(inputElement: HTMLInputElement): void {
        if (this.disposed) {
            throw new Error("Cannot reuse a disposed file searcher");
        }
        this.inputElement?.removeEventListener("input", this.handleInput);
        this.inputElement = inputElement;
        this.inputElement.addEventListener("input", this.handleInput, {
            passive: true,
        });
        this.schedule(inputElement.value);
    }

    /** Releases DOM listeners, pending timers, and in-flight network work on unmount. */
    dispose(): void {
        this.disposed = true;
        this.inputElement?.removeEventListener("input", this.handleInput);
        this.inputElement = null;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.pendingQuery = null;
        this.controller?.abort();
        this.controller = null;
        this.lastResponse = null;
    }

    /** Runs at most once per interval while retaining the newest trailing input value. */
    private schedule(query: string): void {
        if (query.trim() === "") {
            if (this.timer !== null) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            this.pendingQuery = null;
            this.controller?.abort();
            this.controller = null;
            this.lastResponse = null;
            this.emit({ status: "idle" });
            return;
        }
        this.pendingQuery = query;
        if (this.timer !== null) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            const pendingQuery = this.pendingQuery;
            this.pendingQuery = null;
            if (pendingQuery !== null) {
                void this.search(pendingQuery);
            }
        }, 200);
    }

    /** Replaces older requests and ignores their abort failures and late responses. */
    private async search(query: string): Promise<void> {
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        this.emit({
            status: "searching",
            query,
            results: this.lastResponse?.results ?? [],
            timedOut: this.lastResponse?.timed_out ?? false,
        });

        try {
            const response: FileSearchResponse = await this.agent.searchFiles(
                this.directoryPath,
                query,
                controller.signal,
            );
            if (this.controller !== controller || this.disposed) {
                return;
            }
            this.lastResponse = response;
            this.emit({
                status: "success",
                query,
                results: response.results,
                timedOut: response.timed_out,
            });
        } catch (error) {
            if (controller.signal.aborted || this.disposed) {
                return;
            }
            this.emit({
                status: "error",
                query,
                message:
                    error instanceof Error
                        ? error.message
                        : "File search failed",
            });
        } finally {
            if (this.controller === controller) {
                this.controller = null;
            }
        }
    }

    /** Converts native input events into a trailing search without retaining event objects. */
    private handleInput = (event: Event): void => {
        if (event.currentTarget instanceof HTMLInputElement) {
            this.schedule(event.currentTarget.value);
        }
    };

    /** Publishes one immutable state transition for the consuming component. */
    private emit(state: FileSearchState): void {
        this.dispatchEvent(
            new CustomEvent<FileSearchState>(FILE_SEARCH_RESULT_EVENT, {
                detail: state,
            }),
        );
    }
}
