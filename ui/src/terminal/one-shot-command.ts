/** Describes the minimal live socket surface needed for delayed terminal input. */
type CommandSocket = {
    readonly readyState: number;
    send: (payload: ArrayBuffer) => void;
};

/** Reserves and sends startup input at most once across duplicate ready frames and restarts. */
export class OneShotTerminalCommand {
    private readonly payload: ArrayBuffer;
    private readonly onSent: () => void;
    private consumed = false;
    private pendingTimer: ReturnType<typeof setTimeout> | null = null;

    /** Captures immutable command input and the notification earned only by a successful send. */
    constructor(command: string, onSent: () => void) {
        this.payload = new Uint8Array(
            new TextEncoder().encode(`${command}\r`),
        ).buffer;
        this.onSent = onSent;
    }

    /** Lets the first valid ready frame reserve delayed execution while later frames do nothing. */
    reserve(socket: CommandSocket, isCurrent: () => boolean): boolean {
        if (this.consumed) {
            return false;
        }
        this.consumed = true;
        this.pendingTimer = setTimeout(() => {
            this.pendingTimer = null;
            if (!isCurrent() || socket.readyState !== 1) {
                return;
            }
            try {
                socket.send(this.payload);
            } catch {
                return;
            }
            this.onSent();
        }, 200);
        return true;
    }

    /** Cancels session-owned delayed work without making a consumed command replayable. */
    cancelPending() {
        if (this.pendingTimer === null) {
            return;
        }
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
    }
}
