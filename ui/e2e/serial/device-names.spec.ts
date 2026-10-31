// Serial: renames devices and creates local agents in the shared device list.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { AgentConnectionStatus } from "#bindings/AgentConnectionStatus";
import type { AgentListResponse } from "#bindings/AgentListResponse";
import { ApiClient } from "#ui/api-client";
import {
    API_BASE_URL,
    deleteAllTerminalSessions,
    deviceBrowserUrl,
    simulateTabRefocus,
    WEB_BASE_URL,
} from "../helpers";

const HOME_ROOT = path.resolve(".test-playwright-home/device-names");

const RENAME_FROM = `pw-rename-${process.pid}`;

const RENAME_TO = `pw-renamed-${process.pid}`;

const STALE_NAME = `pw-stale-${process.pid}`;

const STALE_RENAMED = `pw-stale-renamed-${process.pid}`;

const CHOSEN_NAME = `pw-chosen-${process.pid}`;

const CHOSEN_RENAMED = `pw-chosen-renamed-${process.pid}`;

// Every character that a hand-built URL would break: a space, the fragment and query
// delimiters, the escape character itself and non-ASCII text.
const SPECIAL_NAME = `pw dev #1 ?50% ä ${process.pid}`;

/** Starting a local agent spawns a process and waits for its registration. */
const CONNECT_TIMEOUT = 30_000;

/** Logs in the API client the fixtures use to create, rename and remove devices. */
async function loginApi(): Promise<ApiClient> {
    const api = new ApiClient(API_BASE_URL);
    await api.login("test-user", "test-password");

    return api;
}

/** Reads one device's lifecycle state by id, the identity that survives renames. */
async function deviceStatus(
    api: ApiClient,
    id: string,
): Promise<AgentConnectionStatus | undefined> {
    const infos = await api.listAgentInfos();

    return infos.find((info) => info.id === id)?.status;
}

/** Waits until the device reaches a lifecycle state, polling instead of sleeping. */
async function waitForStatus(
    api: ApiClient,
    id: string,
    status: AgentConnectionStatus,
): Promise<void> {
    await expect
        .poll(() => deviceStatus(api, id), { timeout: CONNECT_TIMEOUT })
        .toBe(status);
}

/** Starts a stopped managed device and waits for its agent to register. */
async function startDevice(api: ApiClient, id: string): Promise<void> {
    const info = (await api.listAgentInfos()).find((entry) => entry.id === id);

    if (!info) throw new Error(`Device ${id} missing from inventory`);

    await api.agentFor(info).start();
    await waitForStatus(api, id, "connected");
}

/** Stops a managed device so its configuration can be edited or removed. */
async function stopDevice(api: ApiClient, id: string): Promise<void> {
    const info = (await api.listAgentInfos()).find((entry) => entry.id === id);

    if (!info || info.status === "stopped") return;

    await api.agentFor(info).shutdown();
    await waitForStatus(api, id, "stopped");
}

/**
 * Adds a managed local device whose home holds one marker file, so a page can prove which
 * device it is showing, and connects it.
 */
async function createConnectedDevice(
    api: ApiClient,
    device: { name: string; home: string; marker: string },
): Promise<string> {
    const { name, home, marker } = device;
    await fs.rm(home, { recursive: true, force: true });
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, marker), marker);

    const response = await api.createLocalAgent({
        name,
        home,
        log: `log/playwright-device-names-${path.basename(home)}.log`,
    });

    await startDevice(api, response.agent.id);

    return response.agent.id;
}

/** Collects the REST and websocket URLs a page requests for later assertions. */
function recordApiUrls(page: Page): string[] {
    const urls: string[] = [];
    page.on("request", (request) => {
        if (request.url().includes("/api/v1/agents/")) {
            urls.push(request.url());
        }
    });
    page.on("websocket", (socket) => {
        urls.push(socket.url());
    });

    return urls;
}

test.describe.serial("Device names in URLs", () => {
    const createdIds: string[] = [];

    test.afterEach(async () => {
        // Sessions outlive the page; the next test must not restore this test's shells.
        await deleteAllTerminalSessions();
    });

    test.beforeAll(async () => {
        // Managed agents inherit the server's HOME, the fixture home. Without a startup file
        // zsh opens its first-run wizard there, which would swallow the typed command.
        await fs
            .writeFile(
                path.resolve(".test-playwright-home/.zshrc"),
                "# Playwright fixture\n",
                { flag: "wx" },
            )
            .catch(() => undefined);
    });

    test.afterAll(async () => {
        const api = await loginApi();

        // Later suites assert the inventory, so every device added here must be removed.
        for (const id of createdIds) {
            await stopDevice(api, id);
            await api.deleteManagedAgent(id, "local");
        }

        await fs.rm(HOME_ROOT, { recursive: true, force: true });
    });

    test("renaming a device from its page moves the tab to the new name and keeps terminals working", async ({
        page,
    }) => {
        const api = await loginApi();
        const home = path.join(HOME_ROOT, "rename");

        const id = await createConnectedDevice(api, {
            name: RENAME_FROM,
            home,
            marker: "rename-marker.txt",
        });

        createdIds.push(id);

        let terminalOutput = "";
        const apiUrls = recordApiUrls(page);
        page.on("websocket", (socket) => {
            socket.on("framereceived", (event) => {
                terminalOutput += String(event.payload);
            });
        });

        await page.goto(deviceBrowserUrl(RENAME_FROM, home));
        await expect(
            page.getByText("rename-marker.txt", { exact: true }).first(),
        ).toBeVisible();
        await page.getByRole("tab", { name: "Terminal" }).click();
        await page
            .getByRole("button", { name: "New terminal", exact: true })
            .click();
        await expect(
            page.getByRole("status", { name: `${RENAME_FROM} 1: Connected` }),
        ).toBeVisible();

        const terminalInput = page
            .getByLabel(`${RENAME_FROM} 1 for ${RENAME_FROM}`)
            .locator("textarea");

        await page
            .getByRole("link", { name: `Edit ${RENAME_FROM}` })
            .first()
            .click();
        await expect(page.getByLabel("Device name")).toHaveValue(RENAME_FROM);
        await page.getByLabel("Device name").fill(RENAME_TO);

        const historyLength = await page.evaluate(() => history.length);

        await page.getByRole("button", { name: "Stop agent and save" }).click();

        // The tab follows the rename, because the old name no longer addresses anything.
        await expect(page).toHaveURL(
            `${WEB_BASE_URL}/agents/${RENAME_TO}/edit`,
        );
        // The new URL replaces the old entry, so Back cannot return to a dead name.
        expect(await page.evaluate(() => history.length)).toBe(historyLength);
        await expect(page.getByLabel("Device name")).toHaveValue(RENAME_TO);

        // Saving stopped the agent; reconnecting it is the same device under the new name.
        await startDevice(api, id);

        const restart = page.getByRole("button", {
            name: `Restart ${RENAME_FROM} 1`,
        });

        await expect(restart).toBeVisible({ timeout: CONNECT_TIMEOUT });
        await restart.click();
        await expect(
            page.getByRole("status", { name: `${RENAME_FROM} 1: Connected` }),
        ).toBeVisible({ timeout: CONNECT_TIMEOUT });
        await terminalInput.focus();
        // Octal escapes print the marker without putting it in the echoed command.
        await terminalInput.pressSequentially(
            "printf '\\162\\145\\156\\141\\155\\145\\144\\055\\157\\153\\n'",
        );
        await terminalInput.press("Enter");

        // Only a shell on the renamed device can execute the command after the rename.
        await expect.poll(() => terminalOutput).toContain("renamed-ok");

        // Terminal sessions are created on the device by id, which the rename kept.
        const terminalCreations = apiUrls.filter((url) =>
            new URL(url).pathname.endsWith("/terminals"),
        );

        expect(terminalCreations).not.toHaveLength(0);
        expect(
            terminalCreations.every((url) =>
                url.includes(`/api/v1/agents/${id}/`),
            ),
        ).toBe(true);
    });

    test("a page opened before a rename keeps acting on the same device", async ({
        page,
    }) => {
        const api = await loginApi();
        const homeA = path.join(HOME_ROOT, "stale-a");
        const homeB = path.join(HOME_ROOT, "stale-b");

        const idA = await createConnectedDevice(api, {
            name: STALE_NAME,
            home: homeA,
            marker: "marker-a.txt",
        });

        createdIds.push(idA);

        await page.goto(deviceBrowserUrl(STALE_NAME, homeA));
        await expect(
            page.getByText("marker-a.txt", { exact: true }).first(),
        ).toBeVisible();

        // Rename elsewhere and give the old name to a different device while the page stays
        // open, the case where acting on the URL name would switch devices under the user.
        await stopDevice(api, idA);
        await api.updateLocalAgent(idA, {
            name: STALE_RENAMED,
            home: homeA,
            log: `log/playwright-device-names-${path.basename(homeA)}.log`,
        });

        const idB = await createConnectedDevice(api, {
            name: STALE_NAME,
            home: homeB,
            marker: "marker-b.txt",
        });

        createdIds.push(idB);
        await startDevice(api, idA);

        const apiUrls = recordApiUrls(page);
        await fs.writeFile(path.join(homeA, "marker-a2.txt"), "after rename");
        await simulateTabRefocus(page);

        // The refresh lists the device the page was opened for, not the new owner of the name.
        await expect(
            page.getByText("marker-a2.txt", { exact: true }).first(),
        ).toBeVisible({ timeout: CONNECT_TIMEOUT });
        await expect(
            page.getByText("marker-b.txt", { exact: true }),
        ).toHaveCount(0);
        // Its requests carry the id it resolved when it opened.
        expect(
            apiUrls.some((url) => url.includes(`/api/v1/agents/${idA}/`)),
        ).toBe(true);
        expect(
            apiUrls.filter(
                (url) =>
                    url.includes(`/api/v1/agents/${idB}`) ||
                    url.includes(encodeURIComponent(STALE_NAME)),
            ),
        ).toEqual([]);

        // A fresh visit to the old name opens whichever device holds the name now.
        await page.goto(deviceBrowserUrl(STALE_NAME, homeB));
        await expect(
            page.getByText("marker-b.txt", { exact: true }).first(),
        ).toBeVisible();
    });

    test("choosing the device that took an open page's name opens that device", async ({
        page,
    }) => {
        const api = await loginApi();
        const homeA = path.join(HOME_ROOT, "chosen-a");
        const homeB = path.join(HOME_ROOT, "chosen-b");

        const idA = await createConnectedDevice(api, {
            name: CHOSEN_NAME,
            home: homeA,
            marker: "chosen-a.txt",
        });

        createdIds.push(idA);

        await page.goto(deviceBrowserUrl(CHOSEN_NAME, homeA));
        await expect(
            page.getByText("chosen-a.txt", { exact: true }).first(),
        ).toBeVisible();

        // Rename the open device elsewhere and give its name to another device, so the page
        // and the device the user is about to choose share one URL name.
        await stopDevice(api, idA);
        await api.updateLocalAgent(idA, {
            name: CHOSEN_RENAMED,
            home: homeA,
            log: `log/playwright-device-names-${path.basename(homeA)}.log`,
        });

        const idB = await createConnectedDevice(api, {
            name: CHOSEN_NAME,
            home: homeB,
            marker: "chosen-b.txt",
        });

        createdIds.push(idB);

        // The sidebar lists the new owner of the name once the inventory refresh arrives.
        const editB = page.getByRole("link", {
            name: `Edit ${CHOSEN_NAME}`,
            exact: true,
        });

        await expect(editB).toBeVisible({ timeout: CONNECT_TIMEOUT });
        await editB.click();

        // The edit form belongs to the chosen device, not to the one the page was opened
        // for; editing or removing the wrong device here is what the selection must prevent.
        await expect(page).toHaveURL(/\/edit$/);
        await expect(page.getByLabel("Home directory")).toHaveValue(homeB);
    });

    test("a name with spaces, #, ? and % works in links and the address bar", async ({
        page,
    }) => {
        const api = await loginApi();
        const home = path.join(HOME_ROOT, "special");

        const id = await createConnectedDevice(api, {
            name: SPECIAL_NAME,
            home,
            marker: "special-marker.txt",
        });

        createdIds.push(id);

        await page.goto(`${WEB_BASE_URL}/agents`);
        await page
            .getByRole("row", { name: `Device ${SPECIAL_NAME}` })
            .getByRole("link", { name: SPECIAL_NAME, exact: true })
            .click();

        await expect(page.getByLabel("Device name")).toHaveText(SPECIAL_NAME);

        const deviceUrl = new URL(page.url());

        // The router encodes the name, so `#` and `?` stay in the path instead of starting a
        // fragment or a query.
        expect(deviceUrl.hash).toBe("");
        expect(deviceUrl.search).toBe("");
        expect(decodeURIComponent(deviceUrl.pathname)).toBe(
            `/agents/${SPECIAL_NAME}`,
        );
        // Scripts that must survive renames need the id, so the details page offers it.
        await expect(page.getByLabel("Device ID contents")).toHaveText(id);

        await page.getByRole("link", { name: "Browse Files" }).click();
        await expect(
            page.getByText("special-marker.txt", { exact: true }).first(),
        ).toBeVisible();

        // A reload goes through the address bar, which must decode back to the same device.
        await page.reload();
        await expect(
            page.getByText("special-marker.txt", { exact: true }).first(),
        ).toBeVisible();

        // A URL typed by hand with the name percent-encoded opens the device too.
        await page.goto(deviceBrowserUrl(SPECIAL_NAME, home));
        await expect(
            page.getByText("special-marker.txt", { exact: true }).first(),
        ).toBeVisible();
        await expect(
            page.getByRole("link", { name: `${SPECIAL_NAME}, connected` }),
        ).toHaveAttribute("aria-current", "page");
    });

    test("an unknown device name shows the device-not-found page", async ({
        page,
    }) => {
        const unknown = `no such device ${process.pid}`;

        await page.goto(
            `${WEB_BASE_URL}/agents/${encodeURIComponent(unknown)}`,
        );

        // An unknown name is explained instead of surfacing a raw error.
        await expect(
            page.getByRole("heading", { name: "Device not found" }),
        ).toBeVisible();
        await expect(page.getByText(unknown)).toBeVisible();

        // Child routes of an unknown name get the same page.
        await page.goto(deviceBrowserUrl(unknown, "/tmp"));
        await expect(
            page.getByRole("heading", { name: "Device not found" }),
        ).toBeVisible();

        await page.getByRole("link", { name: "All devices" }).click();
        // The page offers the way back to every known device.
        await expect(page).toHaveURL(`${WEB_BASE_URL}/agents`);
        await expect(
            page.getByRole("heading", { level: 1, name: "Devices" }),
        ).toBeVisible();
    });

    test("warns on a device whose id several machines are using", async ({
        page,
    }) => {
        // Real clones need two machines with one id file, so the inventory is patched to the
        // state the router reports for them.
        await page.route("**/api/v1/agents", async (route) => {
            const response = await route.fetch();
            const body: AgentListResponse = await response.json();

            await route.fulfill({
                response,
                json: {
                    agents: body.agents.map((agent) =>
                        agent.name === "agent2_custom"
                            ? {
                                  ...agent,
                                  duplicate_id: {
                                      hostnames: ["clone-one", "clone-two"],
                                      since: 1,
                                  },
                              }
                            : agent,
                    ),
                } satisfies AgentListResponse,
            });
        });

        await page.goto(`${WEB_BASE_URL}/agents`);

        const row = page.getByRole("row", { name: "Device agent2_custom" });

        const rowWarning = row.getByRole("alert", {
            name: "Duplicate device id",
        });

        // The list explains why one of the clones keeps being refused.
        await expect(rowWarning).toContainText(
            "Several machines are using this device's id",
        );
        await expect(rowWarning).toContainText("clone-one, clone-two");
        await expect(
            page
                .getByRole("row", { name: "Device agent1_src" })
                .getByRole("alert", { name: "Duplicate device id" }),
        ).toHaveCount(0);

        await row.getByRole("link", { name: "agent2_custom" }).click();

        const detailsWarning = page.getByRole("alert", {
            name: "Duplicate device id",
        });

        // The device page names the file that gives a clone its own id.
        await expect(detailsWarning).toContainText("clone-one, clone-two");
        await expect(detailsWarning).toContainText("<data_dir>/agent-id");
    });
});
