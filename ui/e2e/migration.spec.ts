import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "zx";
import { expect, test } from "./fixtures";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY_PATH =
    process.env.REDOOR_TEST_BINARY ??
    join(PROJECT_ROOT, "target", "debug", "redoor");

/** Picks an unused localhost TCP port for an isolated migration server. */
async function getEphemeralPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            if (addr === null || typeof addr === "string") {
                reject(new Error("failed to allocate port"));

                return;
            }
            const { port } = addr;
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });
}

/** Polls the isolated server's login-methods endpoint until it accepts HTTP requests. */
async function waitForServer(baseUrl: string): Promise<void> {
    await expect
        .poll(async () => {
            try {
                const res = await fetch(`${baseUrl}/api/v1/auth/methods`);

                return res.ok;
            } catch {
                return false;
            }
        })
        .toBe(true);
}

test.describe("Workspace migration UI", () => {
    // Starts its own isolated server so no shared Playwright fixture state is touched.
    test.use({ storageState: { cookies: [], origins: [] } });

    test("guides the operator through switching accounts and confirming workspace migration", async ({
        page,
    }) => {
        const port = await getEphemeralPort();
        const baseUrl = `http://127.0.0.1:${port}`;
        const home = mkdtempSync(join(tmpdir(), "redoor-e2e-migrate-"));
        const appName = `redoor-e2e-migrate-${port}`;
        const dataDir = join(home, ".local", "share", appName);
        const configPath = join(home, "config.toml");

        mkdirSync(join(dataDir, "ssh", "dev_e2elegacykeyaaaaaaaa"), {
            recursive: true,
        });
        writeFileSync(join(dataDir, "vault.json"), "{}");
        writeFileSync(
            configPath,
            `agent_token = "e2e-legacy-token"

[server]
port = ${port}

[[server.users]]
name = "alice"
password = "alice-password"

[[server.users]]
name = "bob"
password = "bob-password"

[[agents]]
local = true
name = "legacy_laptop"
home = "${home}"
`,
        );

        const serverProc = $({
            cwd: PROJECT_ROOT,
            stdio: "ignore",
            env: {
                ...process.env,
                HOME: home,
                REDOOR_APP_NAME: appName,
                REDOOR_PORT: String(port),
                REDOOR_AGENT_NOTIFICATION: "off",
            },
        })`${BINARY_PATH} server --config ${configPath} --port ${String(port)}`.nothrow();

        try {
            await waitForServer(baseUrl);

            // Signing in as Alice lands on the full-page migration confirmation screen.
            await page.goto(`${baseUrl}/login`);
            await page.getByLabel("Username").fill("alice");
            await page.getByLabel("Password").fill("alice-password");
            await page.getByRole("button", { name: "Sign in" }).click();

            await expect(page).toHaveURL(`${baseUrl}/migrate?redirect=%2F`);
            await expect(
                page.getByRole("heading", {
                    name: "Migrate existing workspace",
                }),
            ).toBeVisible();
            // The summary shows the legacy managed device name and signed-in user.
            await expect(page.getByText("legacy_laptop")).toBeVisible();
            await expect(
                page.getByRole("button", { name: "Migrate to alice" }),
            ).toBeVisible();

            // Operator realizes they want Bob to own the legacy workspace and switches accounts.
            await page.getByRole("button", { name: "Switch account" }).click();
            await expect(page).toHaveURL(/\/login/);

            await page.getByLabel("Username").fill("bob");
            await page.getByLabel("Password").fill("bob-password");
            await page.getByRole("button", { name: "Sign in" }).click();

            await expect(page).toHaveURL(/\/migrate/);
            await expect(
                page.getByRole("button", { name: "Migrate to bob" }),
            ).toBeVisible();

            // Confirming migration moves the workspace to Bob and enters the main app.
            await page.getByRole("button", { name: "Migrate to bob" }).click();
            await expect(page).toHaveURL(`${baseUrl}/`);
            await expect(
                page.getByRole("heading", { name: "Server" }),
            ).toBeVisible();
            // Bob now sees the migrated managed device in the navigation.
            await expect(
                page.getByRole("link", { name: "legacy_laptop", exact: true }),
            ).toBeVisible();
        } finally {
            await serverProc.kill("SIGTERM").catch(() => undefined);
            await serverProc.catch(() => undefined);
            rmSync(home, { recursive: true, force: true });
        }
    });
});
