import { execFile } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { onTestFinished, describe, expect, test, vi } from "vitest";
import { getAvailablePort, SERVER_PATH } from "./test-utils";

const execFileAsync = promisify(execFile);

/** Creates an isolated application namespace and guarantees daemon cleanup after a test. */
function isolatedProcess(role: "agent" | "server") {
    const home = mkdtempSync(join(tmpdir(), `redoor-${role}-lifecycle-`));
    const appName = `redoor-${role}-${process.pid}-${Date.now()}`;
    const env = {
        ...process.env,
        HOME: home,
        REDOOR_APP_NAME: appName,
        REDOOR_AGENT_NOTIFICATION: "off",
    };
    const pidFile = join(home, ".local", "share", appName, `${role}.pid`);

    onTestFinished(async () => {
        try {
            await execFileAsync(SERVER_PATH, [role, "stop"], { env });
        } catch {
            // The tested stop command may already have removed the process.
        }
        rmSync(home, { recursive: true, force: true });
    });

    return { env, pidFile };
}

/** Waits for a daemon to atomically publish its numeric PID without relying on fixed delays. */
async function waitForPid(pidFile: string, stalePid?: number): Promise<number> {
    let pid = 0;
    await vi.waitFor(() => {
        pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        // A numeric PID proves the daemon completed the process-lock startup phase.
        expect(pid).toBeGreaterThan(0);
        if (stalePid !== undefined) {
            // A changed PID proves startup replaced the unlocked stale record.
            expect(pid).not.toBe(stalePid);
        }
    });
    return pid;
}

describe("process lifecycle commands", () => {
    test("server daemon writes a PID, rejects duplicates, and stops", async () => {
        const isolated = isolatedProcess("server");
        const port = await getAvailablePort();
        const configDirectory = join(
            isolated.env.HOME,
            ".config",
            isolated.env.REDOOR_APP_NAME,
        );
        const configPath = join(configDirectory, "config.toml");
        mkdirSync(configDirectory, { recursive: true });
        writeFileSync(
            configPath,
            `agent_token = "lifecycle-token"

[server]
username = "lifecycle-user"
password = "lifecycle-password"
port = ${port}
`,
        );
        mkdirSync(dirname(isolated.pidFile), { recursive: true });
        writeFileSync(isolated.pidFile, `${process.pid}\n`);

        await execFileAsync(
            SERVER_PATH,
            ["server", "--config", configPath, "--daemon"],
            {
                env: isolated.env,
            },
        );
        const pid = await waitForPid(isolated.pidFile, process.pid);
        // An unlocked stale file must not make an unrelated live PID look like the server.
        expect(pid).not.toBe(process.pid);

        await expect(
            execFileAsync(SERVER_PATH, ["server", "--config", configPath], {
                env: isolated.env,
            }),
        ).rejects.toMatchObject({
            stderr: expect.stringContaining(
                "run `redoor server stop` to stop it",
            ),
        });

        const stopped = await execFileAsync(SERVER_PATH, ["server", "stop"], {
            env: isolated.env,
        });
        // Reporting the daemon PID confirms the stop command targeted the PID-file owner.
        expect(stopped.stdout).toContain(`Stopped server process ${pid}`);
        await vi.waitFor(() => {
            // Signal 0 failing proves stop waited for process termination rather than only deleting the file.
            expect(() => process.kill(pid, 0)).toThrow();
        });
    });

    test("agent daemon writes a PID, rejects duplicates, and stops", async () => {
        const isolated = isolatedProcess("agent");
        const port = await getAvailablePort();
        const agentArgs = [
            "agent",
            `ws://127.0.0.1:${port}/ws`,
            "--token",
            "lifecycle-token",
            "--name",
            "lifecycle-agent",
        ];

        await execFileAsync(SERVER_PATH, [...agentArgs, "--daemon"], {
            env: isolated.env,
        });
        const pid = await waitForPid(isolated.pidFile);

        await expect(
            execFileAsync(SERVER_PATH, agentArgs, { env: isolated.env }),
        ).rejects.toMatchObject({
            stderr: expect.stringContaining(
                "run `redoor agent stop` to stop it",
            ),
        });

        const stopped = await execFileAsync(SERVER_PATH, ["agent", "stop"], {
            env: isolated.env,
        });
        // Reporting the daemon PID confirms agent stop used the isolated application namespace.
        expect(stopped.stdout).toContain(`Stopped agent process ${pid}`);
        await vi.waitFor(() => {
            // The agent must be gone even though its WebSocket reconnect loop was active.
            expect(() => process.kill(pid, 0)).toThrow();
        });
    });
});
