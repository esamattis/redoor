import type { ServerInfoResponse } from "#ui/api-client";

/** Supplies loader-compatible metadata when the unauthenticated route skips the server query. */
export const emptyServerInfo: ServerInfoResponse = {
    app_name: "",
    agent_token: "",
    config_path: "",
    exe_path: "",
    auth_mode: "toml",
    external_ip: null,
    os: "",
    arch: "",
    version: "",
    git_rev: "",
    git_dirty: false,
    version_dirty: false,
    build_mode: "debug",
    build_date: "",
};
