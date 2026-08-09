#!/usr/bin/env node

import { z } from "zod";

const toxicSchema = z.object({
    name: z.string(),
    type: z.string(),
    stream: z.enum(["upstream", "downstream"]),
    toxicity: z.number(),
    attributes: z.record(z.string(), z.unknown()),
});

const proxySchema = z.object({
    name: z.string(),
    listen: z.string(),
    upstream: z.string(),
    enabled: z.boolean(),
    toxics: z.array(toxicSchema),
});

const positiveIntegerSchema = z.coerce.number().int().positive();

const apiBaseUrl = (
    process.env.TOXIPROXY_API_URL ?? "http://127.0.0.1:8474"
).replace(/\/$/, "");
const proxyName = process.env.PROXY_NAME ?? "slow";
const listenAddress = process.env.LISTEN_ADDR ?? "127.0.0.1:3001";
const upstreamAddress = process.env.UPSTREAM_ADDR ?? "127.0.0.1:3000";
const downstreamRateKbps = positiveIntegerSchema.parse(
    process.env.DOWNSTREAM_RATE_KBPS ?? "500",
);
const upstreamRateKbps = positiveIntegerSchema.parse(
    process.env.UPSTREAM_RATE_KBPS ?? "500",
);
const proxyPath = `/proxies/${encodeURIComponent(proxyName)}`;

/**
 * Reads and validates API JSON so changes or errors in Toxiproxy's response shape fail loudly.
 */
async function requestJson<TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    init?: RequestInit,
): Promise<z.output<TSchema>> {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
    }
    const response = await fetch(`${apiBaseUrl}${path}`, {
        ...init,
        headers,
    });

    if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(
            `Toxiproxy request ${init?.method ?? "GET"} ${path} failed with ${response.status}: ${responseBody}`,
        );
    }

    return schema.parse(await response.json());
}

/**
 * Removes a previous proxy while allowing the script to initialize a fresh Toxiproxy instance.
 */
async function deleteProxyIfPresent(): Promise<void> {
    const response = await fetch(`${apiBaseUrl}${proxyPath}`, {
        method: "DELETE",
    });

    if (response.ok || response.status === 404) {
        return;
    }

    const responseBody = await response.text();
    throw new Error(
        `Toxiproxy request DELETE ${proxyPath} failed with ${response.status}: ${responseBody}`,
    );
}

/**
 * Adds one directional bandwidth toxic so upload and download limits can differ.
 */
async function addBandwidthToxic(
    stream: "upstream" | "downstream",
    rateKbps: number,
): Promise<void> {
    await requestJson(`${proxyPath}/toxics`, toxicSchema, {
        method: "POST",
        body: JSON.stringify({
            name: `bandwidth_${stream}`,
            type: "bandwidth",
            stream,
            toxicity: 1,
            attributes: { rate: rateKbps },
        }),
    });
}

await deleteProxyIfPresent();
await requestJson("/proxies", proxySchema, {
    method: "POST",
    body: JSON.stringify({
        name: proxyName,
        listen: listenAddress,
        upstream: upstreamAddress,
        enabled: true,
    }),
});
await addBandwidthToxic("downstream", downstreamRateKbps);
await addBandwidthToxic("upstream", upstreamRateKbps);

const proxy = await requestJson(proxyPath, proxySchema);
console.log(JSON.stringify(proxy, null, 2));
console.log(
    `Recreated proxy '${proxyName}' with downstream bandwidth limit ${downstreamRateKbps}KB/s and upstream bandwidth limit ${upstreamRateKbps}KB/s from ${listenAddress} to ${upstreamAddress}`,
);
