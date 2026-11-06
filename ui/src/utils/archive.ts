import {
    getImmediateParentPath,
    isBrowserPathInside,
    joinBrowserPath,
} from "#ui/components/browser/utils";

/** Names the archive formats whose command-line extractors are supported by the file list. */
export type ArchiveFormat =
    | "zip"
    | "tar"
    | "tar-gzip"
    | "tar-bzip2"
    | "tar-xz"
    | "tar-zstd"
    | "rar"
    | "7z";

/** Describes the format and destination name derived from one recognized archive filename. */
export type ArchiveInfo = {
    format: ArchiveFormat;
    suffix: string;
    directoryName: string;
};

/** Names the extraction location policy selected in the unarchive dialog. */
export type UnarchiveDestination = "current" | "subdirectory" | "custom";

/** Longest suffixes come first so compound tar extensions retain their compression format. */
const archiveSuffixes: ReadonlyArray<{
    suffix: string;
    format: ArchiveFormat;
}> = [
    { suffix: ".tar.bz2", format: "tar-bzip2" },
    { suffix: ".tar.gz", format: "tar-gzip" },
    { suffix: ".tar.xz", format: "tar-xz" },
    { suffix: ".tar.zst", format: "tar-zstd" },
    { suffix: ".tbz2", format: "tar-bzip2" },
    { suffix: ".tgz", format: "tar-gzip" },
    { suffix: ".tbz", format: "tar-bzip2" },
    { suffix: ".tzst", format: "tar-zstd" },
    { suffix: ".txz", format: "tar-xz" },
    { suffix: ".zip", format: "zip" },
    { suffix: ".tar", format: "tar" },
    { suffix: ".rar", format: "rar" },
    { suffix: ".7z", format: "7z" },
];

/** Avoids sending terminal control bytes that bypass shell argument quoting. */
export function isTerminalSafeFileName(fileName: string): boolean {
    return !Array.from(fileName).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;

        return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    });
}

/** Keeps unusual suffix-only archive names away from the current and parent directories. */
function getArchiveDirectoryName(stem: string): string {
    return stem === "" || stem === "." || stem === ".." ? "archive" : stem;
}

/** Recognizes archive suffixes without changing the filename's original casing. */
export function getArchiveInfo(fileName: string): ArchiveInfo | null {
    if (!isTerminalSafeFileName(fileName)) {
        return null;
    }

    const lowerName = fileName.toLocaleLowerCase("en-US");

    const match = archiveSuffixes.find((entry) =>
        lowerName.endsWith(entry.suffix),
    );

    if (!match) {
        return null;
    }

    return {
        format: match.format,
        suffix: fileName.slice(fileName.length - match.suffix.length),
        directoryName: getArchiveDirectoryName(
            fileName.slice(0, fileName.length - match.suffix.length),
        ),
    };
}

/** Uses POSIX single-quote escaping so every filename remains one literal shell argument. */
export function quoteShellArgument(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Prefixes row-local paths so leading dashes cannot be interpreted as command options. */
function quoteLocalPath(name: string, trailingSlash = false): string {
    return quoteShellArgument(`./${name}${trailingSlash ? "/" : ""}`);
}

/**
 * Explains why a typed name cannot be used as one safe entry in the current directory. Both
 * archive dialogs paste the name into terminal input, so the rules are shared.
 */
function getSafeChildNameError(value: string, kind: string): string | null {
    if (!isTerminalSafeFileName(value)) {
        return `${kind} cannot contain terminal control characters`;
    }

    const name = value.trim();

    if (name === "") {
        return `${kind} is required`;
    }

    if (name === "." || name === "..") {
        return `${kind} must not be . or ..`;
    }

    if (name.includes("/") || name.includes("\\")) {
        return `${kind} must be a single path component without path separators`;
    }

    return null;
}

/** Explains why a custom target cannot be used as one safe child directory. */
export function getCustomArchiveDirectoryError(value: string): string | null {
    return getSafeChildNameError(value, "Directory name");
}

/** Chooses extraction flags explicitly so compressed tar aliases do not depend on inference. */
function getTarCommand(format: ArchiveFormat, archive: string): string {
    if (format === "tar-gzip") return `tar -xzf ${archive}`;

    if (format === "tar-bzip2") return `tar -xjf ${archive}`;

    if (format === "tar-xz") return `tar -xJf ${archive}`;

    if (format === "tar-zstd") return `tar --zstd -xf ${archive}`;

    return `tar -xf ${archive}`;
}

/** Builds the one-shot command run by a fresh terminal for the selected destination policy. */
export function buildUnarchiveCommand(
    fileName: string,
    destination: UnarchiveDestination,
    customDirectoryName = "",
): string | null {
    const archive = getArchiveInfo(fileName);

    if (!archive) {
        return null;
    }

    const archivePath = quoteLocalPath(fileName);

    if (destination === "current") {
        if (archive.format === "zip") return `unzip ${archivePath}`;

        if (archive.format.startsWith("tar")) {
            return getTarCommand(archive.format, archivePath);
        }

        if (archive.format === "rar") return `unrar x ${archivePath}`;

        return `7z x ${archivePath}`;
    }

    const directoryName =
        destination === "custom"
            ? customDirectoryName.trim()
            : archive.directoryName;

    if (
        destination === "custom" &&
        getCustomArchiveDirectoryError(customDirectoryName)
    ) {
        return null;
    }

    const destinationPath = quoteLocalPath(directoryName);
    const mkdir = `mkdir -- ${destinationPath}`;

    if (archive.format === "zip") {
        return `${mkdir} && unzip ${archivePath} -d ${destinationPath}`;
    }

    if (archive.format.startsWith("tar")) {
        return `${mkdir} && ${getTarCommand(archive.format, archivePath)} -C ${destinationPath}`;
    }

    if (archive.format === "rar") {
        return `${mkdir} && unrar x ${archivePath} ${quoteLocalPath(directoryName, true)}`;
    }

    return `${mkdir} && 7z x ${archivePath} ${quoteShellArgument(`-o./${directoryName}`)}`;
}

/**
 * Names the tarball a directory downloads as. The filesystem root has no name of its own, so
 * it becomes "archive" instead of an unnamed ".tar.gz".
 */
export function getDirectoryArchiveName(directoryName: string): string {
    return `${directoryName === "/" ? "archive" : directoryName}.tar.gz`;
}

/** Names the formats offered when creating an archive. */
export type ArchiveCreateFormat = "tar-zstd" | "tar-xz" | "tar-gzip" | "zip";

/** Describes one creatable format so the dialog can explain what choosing it trades away. */
export type ArchiveCreateFormatInfo = {
    format: ArchiveCreateFormat;
    extension: string;
    description: string;
};

/**
 * Lists the creatable formats in the order the dialog offers them. The first one is the
 * default because zstd gives the best balance of speed and size on modern systems.
 */
export const archiveCreateFormats: ReadonlyArray<ArchiveCreateFormatInfo> = [
    {
        format: "tar-zstd",
        extension: ".tar.zst",
        description:
            "Very fast with a good compression ratio. Needs zstd on the device, and older systems may not open it.",
    },
    {
        format: "tar-xz",
        extension: ".tar.xz",
        description:
            "Smallest archives but slow to create. Opens on most Linux and macOS systems.",
    },
    {
        format: "tar-gzip",
        extension: ".tar.gz",
        description:
            "Fast with a moderate compression ratio. Opens almost anywhere tar is available.",
    },
    {
        format: "zip",
        extension: ".zip",
        description:
            "Fast with the weakest compression ratio, but opens natively on Windows and macOS. Needs zip on the device.",
    },
];

/** One selected path that should be stored in a new archive. */
export type ArchiveSource = {
    agentId: string;
    path: string;
};

/** Returns the last path component, which is the name a source is stored under in the archive. */
function getSourceName(path: string): string {
    const normalizedPath = path.replace(/\/+$/, "");

    return normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
}

/**
 * Explains why the selection cannot be archived into the viewed directory, or returns null
 * when it can. The archive is written by a terminal on the viewed device, so every source
 * must live on that same device.
 */
export function getCreateArchiveSelectionError(props: {
    sources: ReadonlyArray<ArchiveSource>;
    agentId: string;
    directoryPath: string;
}): string | null {
    if (props.sources.length === 0) {
        return "Select items to archive";
    }

    const agentIds = new Set(props.sources.map((source) => source.agentId));

    if (agentIds.size > 1) {
        return "Archives cannot be created when items are selected from multiple devices";
    }

    if (!agentIds.has(props.agentId)) {
        return "Archives are created in the current directory, so the selected items must be on this device";
    }

    if (
        props.sources.some(
            (source) => getImmediateParentPath(source.path) === null,
        )
    ) {
        return "The filesystem root cannot be archived";
    }

    if (
        props.sources.some(
            (source) =>
                !isTerminalSafeFileName(source.path) ||
                !isTerminalSafeFileName(props.directoryPath),
        )
    ) {
        return "Archived paths cannot contain terminal control characters";
    }

    // Writing the archive into a directory it is reading would make it archive itself.
    if (
        props.sources.some((source) =>
            isBrowserPathInside(source.path, props.directoryPath),
        )
    ) {
        return "Archives cannot be created inside a selected directory";
    }

    const names = props.sources.map((source) => getSourceName(source.path));

    const duplicate = names.find(
        (name, index) => names.indexOf(name) !== index,
    );

    // Items are stored side by side, so two equal names would overwrite each other on extraction.
    if (duplicate !== undefined) {
        return `Several selected items are named ${duplicate}, so they cannot be stored side by side`;
    }

    return null;
}

/** Suggests an archive name: one item keeps its own name, several share a generic one. */
export function getDefaultArchiveName(
    sources: ReadonlyArray<ArchiveSource>,
): string {
    const [first] = sources;

    if (sources.length !== 1 || first === undefined) {
        return "archive";
    }

    return getSourceName(first.path);
}

/** Explains why a typed archive name cannot be created as one entry in the current directory. */
export function getArchiveNameError(value: string): string | null {
    return getSafeChildNameError(value, "Archive name");
}

/** Groups sources by containing directory so each group can be added from that directory. */
function groupSourcesByParent(
    sources: ReadonlyArray<ArchiveSource>,
): Map<string, string[]> | null {
    const groups = new Map<string, string[]>();

    for (const source of sources) {
        const parent = getImmediateParentPath(source.path);

        if (parent === null) {
            return null;
        }

        const names = groups.get(parent) ?? [];
        names.push(getSourceName(source.path));
        groups.set(parent, names);
    }

    return groups;
}

/** Chooses creation flags explicitly so every tar implementation compresses the same way. */
function getTarCreateFlags(format: Exclude<ArchiveCreateFormat, "zip">) {
    if (format === "tar-zstd") return "--zstd -cf";

    if (format === "tar-xz") return "-cJf";

    return "-czf";
}

/**
 * Builds the one-shot command that writes the archive into `directoryPath`, which is also the
 * terminal's working directory. Sources keep only their own names inside the archive, even
 * when they come from different directories.
 */
export function buildCreateArchiveCommand(props: {
    sources: ReadonlyArray<ArchiveSource>;
    /** The device whose terminal runs the command and receives the archive. */
    agentId: string;
    directoryPath: string;
    archiveName: string;
    format: ArchiveCreateFormat;
}): string | null {
    if (
        getArchiveNameError(props.archiveName) ||
        getCreateArchiveSelectionError(props)
    ) {
        return null;
    }

    const groups = groupSourcesByParent(props.sources);

    if (!groups) {
        return null;
    }

    const archiveName = props.archiveName.trim();

    const sameDirectoryOnly = [...groups.keys()].every(
        (parent) => parent === props.directoryPath,
    );

    if (props.format !== "zip") {
        // tar switches directories between operands with -C, so one invocation covers all groups.
        const operands: string[] = [];
        let currentDirectory = props.directoryPath;

        for (const [parent, names] of groups) {
            if (parent !== currentDirectory) {
                operands.push(`-C ${quoteShellArgument(parent)}`);
                currentDirectory = parent;
            }

            operands.push(...names.map((name) => quoteLocalPath(name)));
        }

        return `tar ${getTarCreateFlags(props.format)} ${quoteLocalPath(archiveName)} ${operands.join(" ")}`;
    }

    // zip has no -C, so it changes into each directory and appends to an absolute archive path.
    const archivePath = sameDirectoryOnly
        ? quoteLocalPath(archiveName)
        : quoteShellArgument(joinBrowserPath(props.directoryPath, archiveName));

    const steps: string[] = [];
    let currentDirectory = props.directoryPath;

    for (const [parent, names] of groups) {
        if (parent !== currentDirectory) {
            steps.push(`cd ${quoteShellArgument(parent)}`);
            currentDirectory = parent;
        }

        steps.push(
            `zip -r ${archivePath} ${names.map((name) => quoteLocalPath(name)).join(" ")}`,
        );
    }

    if (currentDirectory !== props.directoryPath) {
        steps.push(`cd ${quoteShellArgument(props.directoryPath)}`);
    }

    return steps.join(" && ");
}
