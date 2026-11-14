import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import type { Agent } from "#ui/api-client";
import { Button } from "#ui/components/button";
import { Dialog } from "#ui/components/dialog";
import { DialogActions } from "#ui/components/dialog-actions";
import { RadioCardGroup, RadioCardOption } from "#ui/components/radio-card";
import { TextField } from "#ui/components/text-field";
import { browserListingQueryOptions } from "#ui/queries";
import { isLsDirectoryResponse } from "#ui/ls-response";
import {
    archiveCreateFormats,
    buildCreateArchiveCommand,
    getArchiveNameError,
    getDefaultArchiveName,
    type ArchiveCreateFormat,
    type ArchiveSource,
} from "#ui/utils/archive";
import { useTerminals } from "#ui/use-terminals";

/**
 * Picks the name and format for a new archive in the viewed directory and starts a fresh
 * terminal that writes it. A terminal is used, like for Unarchive, so the user sees tool
 * output and errors such as a missing zstd or zip binary.
 */
export function CreateArchiveDialog(props: {
    agent: Agent;
    directoryPath: string;
    sources: ReadonlyArray<ArchiveSource>;
    onClose: () => void;
}) {
    const [format, setFormat] = React.useState<ArchiveCreateFormat>(
        archiveCreateFormats[0]?.format ?? "tar-zstd",
    );

    const [name, setName] = React.useState(() =>
        getDefaultArchiveName(props.sources),
    );

    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
    const terminals = useTerminals();

    // The listing is already cached by the browser route, so this only reads it for conflicts.
    const listing = useQuery(
        browserListingQueryOptions(props.agent, props.directoryPath),
    );

    const extension =
        archiveCreateFormats.find((entry) => entry.format === format)
            ?.extension ?? "";

    const archiveName = `${name.trim()}${extension}`;

    /** Validates before opening so an overwrite or invalid shell input never reaches the terminal. */
    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const nameError = getArchiveNameError(name);

        if (nameError) {
            setErrorMessage(nameError);

            return;
        }

        // tar would silently overwrite and zip would append, so an existing entry is refused.
        if (
            listing.data &&
            isLsDirectoryResponse(listing.data) &&
            listing.data.files.some((entry) => entry.name === archiveName)
        ) {
            setErrorMessage(`${archiveName} already exists in this directory`);

            return;
        }

        const command = buildCreateArchiveCommand({
            sources: props.sources,
            agentId: props.agent.id,
            directoryPath: props.directoryPath,
            archiveName,
            format,
        });

        if (!command) {
            setErrorMessage("Unable to create a safe archive command");

            return;
        }

        props.onClose();
        terminals.create({
            agent: props.agent,
            cwd: props.directoryPath,
            startupCommand: command,
            refreshTarget: {
                agentId: props.agent.id,
                path: props.directoryPath,
            },
        });
    };

    const itemCount = props.sources.length;

    return (
        <Dialog
            isOpen={true}
            title="Create archive"
            description={`Archive ${itemCount} ${itemCount === 1 ? "item" : "items"} into ${props.directoryPath}. A new terminal will run the archive command.`}
            closeAriaLabel="Close create archive dialog"
            errorMessage={errorMessage}
            onClose={props.onClose}
        >
            <form noValidate onSubmit={handleSubmit}>
                <TextField
                    label="Archive name"
                    codeMode
                    value={name}
                    placeholder="archive"
                    description={`Saved as ${archiveName}`}
                    required
                    autoFocus
                    className="mt-4"
                    disabled={false}
                    onChange={(value) => {
                        setName(value);
                        setErrorMessage(null);
                    }}
                />
                <RadioCardGroup
                    legend="Archive format"
                    className="mt-6"
                    legendClassName="text-sm font-medium text-slate-200"
                    optionsClassName="mt-2"
                >
                    {archiveCreateFormats.map((entry) => (
                        <RadioCardOption
                            key={entry.format}
                            name="create-archive-format"
                            value={entry.format}
                            label={entry.extension}
                            description={entry.description}
                            checked={format === entry.format}
                            layout="descriptive"
                            onChange={() => {
                                setFormat(entry.format);
                                setErrorMessage(null);
                            }}
                        />
                    ))}
                </RadioCardGroup>
                <DialogActions>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={props.onClose}
                    >
                        Cancel
                    </Button>
                    <Button type="submit">
                        <Archive className="h-4 w-4" aria-hidden="true" />
                        Create archive
                    </Button>
                </DialogActions>
            </form>
        </Dialog>
    );
}
