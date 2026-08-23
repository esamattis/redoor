import React from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { FilePlus, FolderPlus } from "lucide-react";
import type { Agent } from "#ui/api-client";
import { BrowserViewCard } from "#ui/components/browser-view-card";
import { Button } from "#ui/components/button";
import { TextField } from "#ui/components/text-field";
import {
    getErrorMessage,
    getImmediateParentPath,
    joinBrowserPath,
} from "#ui/components/browser/utils";

type EntryType = "file" | "directory";

/** Lets a missing browser location become a file or directory without leaving its path context. */
export function MissingPathCreationForm(props: { agent: Agent; path: string }) {
    const navigate = useNavigate();
    const router = useRouter();
    const initialName = props.path.split("/").filter(Boolean).pop() ?? "";
    const [fileName, setFileName] = React.useState(initialName);
    const [validationError, setValidationError] = React.useState<string | null>(
        null,
    );
    const parentPath = getImmediateParentPath(props.path) ?? "/";
    const trimmedFileName = fileName.trim();
    const createdPath = trimmedFileName
        ? joinBrowserPath(parentPath, trimmedFileName)
        : null;
    const createMutation = useMutation({
        mutationFn: async (entry: { type: EntryType; path: string }) => {
            if (entry.type === "directory") {
                return props.agent.createDirectory(entry.path);
            }

            return props.agent.upload(
                entry.path,
                new globalThis.File([""], trimmedFileName, {
                    type: "text/plain",
                }),
            );
        },
        onSuccess: async (_, entry) => {
            if (entry.path === props.path) {
                await router.invalidate();
                return;
            }

            await navigate({
                to: props.agent.getBrowserUrl(entry.path),
                search: {},
            });
        },
    });

    /** Validates the filename before choosing the corresponding remote creation API. */
    const createEntry = (type: EntryType) => {
        if (!createdPath) {
            setValidationError("File name is required");
            return;
        }
        if (trimmedFileName.includes("/")) {
            setValidationError("File name cannot contain a slash");
            return;
        }

        setValidationError(null);
        createMutation.mutate({ type, path: createdPath });
    };

    const errorMessage =
        validationError ??
        (createMutation.isError
            ? getErrorMessage(createMutation.error, "Creation failed")
            : null);

    return (
        <BrowserViewCard>
            <section className="p-6 lg:p-8">
                <h1 className="text-xl font-semibold text-slate-100">
                    File or directory does not exist
                </h1>
                <p className="mt-2 text-sm text-slate-400">
                    Create a new file or directory at this location.
                </p>
                <form
                    className="mt-6 max-w-2xl"
                    onSubmit={(event) => {
                        event.preventDefault();
                        createEntry("file");
                    }}
                >
                    <TextField
                        label="File name"
                        value={fileName}
                        placeholder="notes.txt"
                        description={`Name to create in ${parentPath}.`}
                        required
                        autoFocus
                        onChange={(value) => {
                            setFileName(value);
                            setValidationError(null);
                            createMutation.reset();
                        }}
                        disabled={createMutation.isPending}
                    />
                    {errorMessage ? (
                        <p role="alert" className="mt-3 text-sm text-red-300">
                            {errorMessage}
                        </p>
                    ) : null}
                    <div className="mt-5 flex flex-wrap gap-3">
                        <Button
                            type="submit"
                            isLoading={createMutation.isPending}
                        >
                            <FilePlus className="h-4 w-4" aria-hidden="true" />
                            File
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => createEntry("directory")}
                            isLoading={createMutation.isPending}
                        >
                            <FolderPlus
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                            Directory
                        </Button>
                    </div>
                </form>
            </section>
        </BrowserViewCard>
    );
}
