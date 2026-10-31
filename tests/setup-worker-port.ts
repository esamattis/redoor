import { VITEST_SERVER_PORT } from "./test-utils";

// Servers prefer `REDOOR_PORT` over the port in their config file, and the remote CLI reads it
// too. Pointing it at this worker's own port keeps every process a test file spawns away
// from the servers of test files running in other workers at the same time.
process.env.REDOOR_PORT = VITEST_SERVER_PORT.toString();
