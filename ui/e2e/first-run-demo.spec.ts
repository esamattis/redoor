import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const SERVER_PATH = path.join(PROJECT_ROOT, "target/debug/redoor");

/** Linux first-run browser hint from `desktop::first_run_login_message`. */
const LINUX_LOGIN_MESSAGE = "Log in with PAM (your Linux account credentials)";
/** macOS first-run browser hint from `desktop::first_run_login_message`. */
const MACOS_LOGIN_MESSAGE = "Log in with username redoor and password changeme";
const tcpAddressSchema = z.object({ port: z.number().int().positive() });

const FIRST_RUN_MESSAGE =
    process.platform === "darwin" ? MACOS_LOGIN_MESSAGE : LINUX_LOGIN_MESSAGE;

/** Reserves an ephemeral loopback port so this suite never collides with playwright-dev. */
async function getAvailablePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const address = tcpAddressSchema.safeParse(server.address());
            if (!address.success) {
                reject(new Error("Failed to allocate ephemeral port"));
                return;
            }
            server.close(() => resolve(address.data.port));
        });
        server.on("error", reject);
    });
}

/** Waits until the dedicated demo server answers unauthenticated API probes. */
async function waitForPort(port: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            const response = await fetch(
                `http://127.0.0.1:${port}/api/v1/agents`,
            );
            if (response.ok || response.status === 401) {
                return;
            }
        } catch {
            // Server has not bound yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Demo server on port ${port} did not become ready`);
}

/** Starts `redoor server` without `--config` so conventional first-run bootstrap runs. */
function spawnBootstrapServer(options: {
    home: string;
    appName: string;
    port: number;
    logPath: string;
}): ChildProcess {
    return spawn(
        SERVER_PATH,
        ["server", "--port", String(options.port), "--log", options.logPath],
        {
            cwd: PROJECT_ROOT,
            env: {
                ...process.env,
                HOME: options.home,
                REDOOR_APP_NAME: options.appName,
                // Keep the developer's desktop free of accidental browser opens during CI.
                DISPLAY: "",
                WAYLAND_DISPLAY: "",
                REDOOR_AGENT_NOTIFICATION: "off",
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
}

/** Stops a child server process without failing if it already exited. */
async function stopServer(child: ChildProcess | undefined): Promise<void> {
    if (!child?.pid) {
        return;
    }
    try {
        process.kill(child.pid, "SIGTERM");
    } catch {
        return;
    }
    await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
            try {
                if (child.pid) {
                    process.kill(child.pid, "SIGKILL");
                }
            } catch {
                // Already gone.
            }
            resolve();
        }, 5_000);
        child.once("exit", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/**
 * Automated Linux login cannot supply the operator's PAM password, so after the
 * starter file is verified the suite pins disposable TOML credentials for the
 * remainder of the browser flow. macOS already ships demo credentials.
 */
async function ensureBrowserLoginCredentials(configPath: string): Promise<{
    username: string;
    password: string;
}> {
    if (process.platform === "darwin") {
        return { username: "redoor", password: "changeme" };
    }

    let content = await fs.readFile(configPath, "utf8");
    // Prove the bootstrap still ships the PAM-oriented starter before the test pin.
    expect(content).toContain("# username =");
    expect(content).toContain("# password =");
    expect(content).toContain("PAM");
    content = content.replace(
        "[server]\n",
        `[server]
username = "demo-user"
password = "demo-password"
`,
    );
    await fs.writeFile(configPath, content);
    return { username: "demo-user", password: "demo-password" };
}

test.describe("First-run demo", () => {
    // Fresh app namespace must not inherit the shared playwright-dev cookie jar.
    test.use({ storageState: { cookies: [], origins: [] } });

    test("bootstraps config, shows the login hint, and uses the local agent", async ({
        page,
    }) => {
        const port = await getAvailablePort();
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), "redoor-first-run-"),
        );
        const appName = `redoor-pw-demo-${port}`;
        const configPath = path.join(home, ".config", appName, "config.toml");
        const logPath = path.join(home, "server.log");

        let child: ChildProcess | undefined = spawnBootstrapServer({
            home,
            appName,
            port,
            logPath,
        });

        try {
            await waitForPort(port);
            const generated = await fs.readFile(configPath, "utf8");
            // Minimal starter config must match the README-shaped first-run template.
            expect(generated).toContain('name = "local"');
            expect(generated).toContain("local = true");
            expect(generated).toContain(
                '# bind = "0.0.0.0" # default 127.0.0.1',
            );
            expect(generated).toContain("# port = 7666");
            expect(generated).not.toContain("[agent]");

            const credentials = await ensureBrowserLoginCredentials(configPath);
            if (process.platform !== "darwin") {
                // Restart so the injected TOML credentials take effect for the browser flow.
                await stopServer(child);
                child = spawnBootstrapServer({
                    home,
                    appName,
                    port,
                    logPath,
                });
                await waitForPort(port);
            }

            const baseUrl = `http://127.0.0.1:${port}`;
            const loginUrl = `${baseUrl}/login#message=${encodeURIComponent(FIRST_RUN_MESSAGE)}`;
            // The suite starts where first-run `xdg-open`/`open` would land.
            await page.goto(loginUrl);

            const hint = page.getByRole("status");
            // Fragment message must render above the form so first-run credentials are obvious.
            await expect(hint).toBeVisible();
            await expect(hint).toContainText(FIRST_RUN_MESSAGE);
            await expect(
                page.getByRole("heading", { name: "Sign in to Redoor" }),
            ).toBeVisible();

            await page.getByLabel("Username").fill(credentials.username);
            await page.getByLabel("Password").fill(credentials.password);
            await page.getByRole("button", { name: "Sign in" }).click();
            await expect(
                page.getByRole("heading", { name: "Server", exact: true }),
            ).toBeVisible();

            // Clicking the stopped local tab triggers lazy start and opens its browser root.
            await page.getByRole("link", { name: "local, stopped" }).click();
            await expect(
                page.getByRole("heading", { name: "Starting local" }),
            ).toBeVisible();
            await expect(
                page.getByRole("link", { name: "local, connected" }),
            ).toBeVisible({ timeout: 30_000 });
            // The server log lives in the process user's home, proving the local agent uses the new default.
            await expect(
                page.getByRole("link", { name: "server.log", exact: true }),
            ).toBeVisible({ timeout: 30_000 });
        } finally {
            await stopServer(child);
            await fs.rm(home, { recursive: true, force: true });
        }
    });
});
