import { Play } from "lucide-react";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { getImmediateParentPath } from "#ui/components/browser/utils";
import { useTerminals } from "#ui/use-terminals";
import { getBaseName } from "#ui/utils/path";
import { buildRunFileCommand } from "#ui/utils/run-file";

/**
 * Runs an executable file in a new terminal opened in its directory, so running a script
 * does not take opening a terminal, changing directory and typing its name. A fresh terminal
 * keeps the run's output apart from other shells. Renders nothing for names the shell input
 * cannot carry safely.
 */
export function RunInTerminalButton(props: {
    agent: Agent;
    filePath: string;
    /** Why running is not possible right now, shown instead of the action's tooltip. */
    disabledReason?: string | null;
    className?: string;
}) {
    const terminals = useTerminals();
    const directory = getImmediateParentPath(props.filePath);
    const command = buildRunFileCommand(getBaseName(props.filePath));

    if (directory === null || command === null) {
        return null;
    }

    const disabledReason = props.disabledReason ?? null;

    return (
        <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Run in terminal"
            tooltip={
                disabledReason ??
                `Run ${command} in a new terminal in the file's directory`
            }
            disabled={disabledReason !== null}
            className={props.className}
            onClick={() =>
                terminals.create({
                    agent: props.agent,
                    cwd: directory,
                    startupCommand: command,
                    // The run may write files next to it, so the directory listing refreshes.
                    refreshTarget: { agentId: props.agent.id, path: directory },
                })
            }
        >
            <Play className="h-4 w-4" aria-hidden="true" />
        </Button>
    );
}
