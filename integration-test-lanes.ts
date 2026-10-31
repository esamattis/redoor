/**
 * How the Vitest integration suite splits its test files between concurrent workers.
 *
 * Every integration test file starts its own real server, so files can only run at the same
 * time when each worker listens on a port of its own. This module has no side effects so the
 * port setup script can read the layout before `test_ports.json` exists.
 */

/**
 * Test files that share the one remote SSH test host. They enroll and remove keys in the
 * remote account's `authorized_keys` and provision agents into its home, so two of them
 * running at once would see each other's keys and processes. They run one at a time in their
 * own lane, next to the parallel lane rather than after it, because they take about as long
 * as all the other files together. `tests/ssh-test-utils.ts` refuses to load outside this
 * lane, so a new SSH test file cannot silently join the parallel lane.
 */
export const SERIAL_INTEGRATION_TEST_FILES = [
    "tests/real-ssh.test.ts",
    "tests/ssh-debug-provisioning.test.ts",
    "tests/ssh-device-ids.test.ts",
    "tests/ssh-key-vault.test.ts",
    "tests/ssh-keys.test.ts",
];

/**
 * Integration test files that may run at the same time, the serial lane included. The suite
 * runs next to Playwright during `pn test` on an 8-core, 8 GB machine, and the serial SSH
 * lane takes about as long as two parallel workers need for everything else, so more
 * workers would mostly add load without shortening the run.
 */
export const INTEGRATION_TEST_WORKERS = 3;

/** Lanes the integration suite runs, each as its own Vitest project. */
export type IntegrationLane = "parallel" | "serial";

/** Settings of one lane that the Vitest config, port setup and test runner must agree on. */
type LaneLayout = {
    /** Files of this lane that may run at the same time. */
    workers: number;
    /** Offset from the reserved base port of this lane's first worker port. */
    firstPortOffset: number;
};

/**
 * Port layout of the lanes. The serial lane owns the base port and the parallel workers the
 * ports right after it, so each worker's server port only depends on its lane and pool id.
 */
export const INTEGRATION_LANES: Record<IntegrationLane, LaneLayout> = {
    serial: { workers: 1, firstPortOffset: 0 },
    parallel: {
        workers: Math.max(1, INTEGRATION_TEST_WORKERS - 1),
        firstPortOffset: 1,
    },
};

/** Number of consecutive ports, starting at the reserved Vitest port, the workers listen on. */
export const VITEST_PORT_COUNT =
    INTEGRATION_LANES.parallel.firstPortOffset +
    INTEGRATION_LANES.parallel.workers;
