import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One managed local agent record written into `<user_dir>/agents.json`. */
export type SeededLocalAgent = {
    kind: "local";
    id: string;
    name?: string | null;
    home?: string | null;
    terminal_env?: Record<string, string>;
};

/** One managed SSH agent record written into `<user_dir>/agents.json`. */
export type SeededSshAgent = {
    kind: "ssh_backed";
    id: string;
    username?: string | null;
    ssh_port?: number | null;
    target: string;
    name?: string | null;
    install_dir?: string | null;
    log?: string | null;
    password?: string | null;
    managed_ssh_key?: boolean;
    terminal_env?: Record<string, string>;
};

/** Typed managed device entry for seeding `<user_dir>/agents.json` in tests. */
export type SeededAgentEntry = SeededLocalAgent | SeededSshAgent;

/** Returns the server's XDG data directory for a given test HOME and app name. */
export function serverDataDir(home: string, appName: string): string {
    return join(home, ".local", "share", appName);
}

/**
 * Seeds a layout-version 2 user workspace (`layout-version`, `account.json`, and optional
 * `agents.json`) under `home` so test servers start without entering the legacy migration gate.
 */
export function seedUserWorkspace(options: {
    home: string;
    appName: string;
    username: string;
    agentToken: string;
    agents?: SeededAgentEntry[];
}): string {
    const dataDir = serverDataDir(options.home, options.appName);
    const usersDir = join(dataDir, "users");
    const userDir = join(usersDir, options.username);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(usersDir, { recursive: true, mode: 0o700 });
    mkdirSync(userDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "layout-version"), "2\n", { mode: 0o600 });
    writeFileSync(
        join(userDir, "account.json"),
        JSON.stringify(
            {
                version: 1,
                username: options.username,
                agent_token: options.agentToken,
            },
            null,
            2,
        ),
        { mode: 0o600 },
    );

    if (options.agents !== undefined) {
        writeFileSync(
            join(userDir, "agents.json"),
            JSON.stringify({ version: 1, agents: options.agents }, null, 2),
            { mode: 0o600 },
        );
    }

    return userDir;
}
