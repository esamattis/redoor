import type { ChangedFilesOutlineFile } from "#ui/components/browser/changed-files-outline";

/** One row of the changed files tree, in the order the side menu shows them. */
export type ChangedFilesTreeRow =
    | {
          kind: "directory";
          /** The repository-relative path, which identifies the directory when folding it. */
          path: string;
          /**
           * The path from the parent row, which spans several directories where they hold
           * nothing but one another, so deep single-directory chains cost a single row.
           */
          label: string;
          /**
           * Every directory the row stands for, outermost first. A filter can merge a folded
           * directory into a longer chain, and the row must stay folded when any of them is.
           */
          chainPaths: string[];
          depth: number;
          isFolded: boolean;
      }
    | {
          kind: "file";
          file: ChangedFilesOutlineFile;
          /** The file name, since the directory rows above already say where it is. */
          label: string;
          depth: number;
      };

/** A directory while the tree is built, keeping children in the order they first appear. */
type DirectoryNode = {
    directories: Map<string, DirectoryNode>;
    files: Array<{ name: string; file: ChangedFilesOutlineFile }>;
};

/** Creates an empty directory node. */
function createDirectory(): DirectoryNode {
    return { directories: new Map(), files: [] };
}

/**
 * Turns the flat file list of a diff into tree rows, so a change set spread over many
 * directories reads by where the files are instead of repeating each path. The rows of a
 * folded directory are left out. Directories come before the files beside them, like in file
 * browsers, and otherwise keep the diff's order so the tree follows the patches on screen.
 */
export function buildChangedFilesTree(
    files: ReadonlyArray<ChangedFilesOutlineFile>,
    foldedPaths: ReadonlySet<string>,
): ChangedFilesTreeRow[] {
    const root = createDirectory();

    for (const file of files) {
        const parts = file.relativePath.split("/");
        const name = parts.pop() ?? file.relativePath;
        let directory = root;

        for (const part of parts) {
            let child = directory.directories.get(part);

            if (child === undefined) {
                child = createDirectory();
                directory.directories.set(part, child);
            }

            directory = child;
        }

        directory.files.push({ name, file });
    }

    const rows: ChangedFilesTreeRow[] = [];

    const visit = (
        directory: DirectoryNode,
        parentPath: string,
        depth: number,
    ) => {
        for (const [name, child] of directory.directories) {
            /** Prefixes a directory name with the parent row's path. */
            const pathOf = (relative: string) =>
                parentPath === "" ? relative : `${parentPath}/${relative}`;

            let label = name;
            let node = child;
            const chainPaths = [pathOf(label)];

            // Directories that only hold one directory merge into one row.
            while (node.files.length === 0 && node.directories.size === 1) {
                const only = node.directories.entries().next();

                if (only.done === true) {
                    break;
                }

                label = `${label}/${only.value[0]}`;
                node = only.value[1];
                chainPaths.push(pathOf(label));
            }

            const path = pathOf(label);

            const isFolded = chainPaths.some((chainPath) =>
                foldedPaths.has(chainPath),
            );

            rows.push({
                kind: "directory",
                path,
                label,
                chainPaths,
                depth,
                isFolded,
            });

            if (!isFolded) {
                visit(node, path, depth + 1);
            }
        }

        for (const entry of directory.files) {
            rows.push({
                kind: "file",
                file: entry.file,
                label: entry.name,
                depth,
            });
        }
    };

    visit(root, "", 0);

    return rows;
}
