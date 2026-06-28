#!/usr/bin/env bun
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@hasna/actions";
import { AutomationsStore, type WebhookRoute } from "../index.js";
import { daemonPidFilePath, ensureAutomationsDataDir } from "../lib/paths.js";

interface ParsedArgs {
  json: boolean;
  dir?: string;
  rest: string[];
}

interface DaemonRunOptions {
  once: boolean;
  intervalMs: number;
  ttlMs: number;
}

interface DaemonServeOptions {
  host: string;
  port: number;
  intervalMs: number;
  ttlMs: number;
  maxBodyBytes: number;
}

export interface WebhookServerOptions {
  store: AutomationsStore;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  resolveSecret?: WebhookSecretResolver;
}

export type WebhookSecretResolver = (route: WebhookRoute) => string | undefined;

export async function runAutomationsDaemonCli(argv = Bun.argv.slice(2)): Promise<number> {
  const parsed = parseGlobalArgs(argv);
  if (parsed.dir) process.env.HASNA_AUTOMATIONS_DIR = parsed.dir;
  const command = parsed.rest[0];

  try {
    if (!command || command === "--help" || command === "-h" || command === "help") {
      printHelp();
      return 0;
    }
    if (command === "--version" || command === "-v" || command === "version") {
      output(parsed, { version: packageVersion() }, () => console.log(packageVersion()));
      return 0;
    }
    if (command === "status") {
      const store = new AutomationsStore();
      try {
        output(parsed, store.status(), () => console.log(JSON.stringify(store.status(), null, 2)));
      } finally {
        store.close();
      }
      return 0;
    }
    if (command === "run") {
      return runDaemon(parsed);
    }
    if (command === "serve") {
      return runWebhookServe(parsed);
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (parsed.json) {
      console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`automations-daemon: ${message}`);
    }
    return 1;
  }
}

export async function runWebhookServe(parsed: ParsedArgs): Promise<number> {
  ensureAutomationsDataDir();
  writeFileSync(daemonPidFilePath(), `${process.pid}\n`, { mode: 0o600 });
  const options = parseServeOptions(parsed.rest.slice(1));
  const store = new AutomationsStore();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    server = startWebhookServer({
      store,
      host: options.host,
      port: options.port,
      maxBodyBytes: options.maxBodyBytes,
    });
    const leaseMetadata: JsonObject = {
      mode: "serve",
      webhooks: {
        host: server.hostname ?? options.host,
        port: server.port ?? options.port,
        maxBodyBytes: options.maxBodyBytes,
        routes: store.listWebhookRoutes().length,
      },
    };
    const lease = store.heartbeatDaemon({ ttlMs: options.ttlMs, metadata: leaseMetadata });
    output(parsed, {
      ok: true,
      mode: "serve",
      leaseId: lease.id,
      pid: lease.pid,
      heartbeatAt: lease.heartbeat_at,
      host: server.hostname,
      port: server.port,
      maxBodyBytes: options.maxBodyBytes,
      routes: store.listWebhookRoutes().length,
    }, () => {
      console.log(`automations-daemon serving webhooks on http://${server!.hostname}:${server!.port}`);
    });
    while (!stopping) {
      store.heartbeatDaemon({ leaseId: lease.id, ttlMs: options.ttlMs, metadata: leaseMetadata });
      await Bun.sleep(options.intervalMs);
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    server?.stop(true);
    store.close();
  }
}

export function startWebhookServer(options: WebhookServerOptions): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: options.host ?? "127.0.0.1",
    port: options.port ?? 7391,
    fetch: (request) => handleWebhookRequest(request, options),
  });
}

export async function handleWebhookRequest(request: Request, options: WebhookServerOptions): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz" && request.method === "GET") {
    return jsonResponse(200, { ok: true, service: "automations", mode: "webhooks" });
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
  }
  let route: WebhookRoute;
  try {
    route = options.store.requireWebhookRoute(url.pathname);
  } catch {
    return jsonResponse(404, { ok: false, error: "webhook_route_not_found" });
  }
  if (route.status !== "active") {
    return jsonResponse(403, { ok: false, error: "webhook_route_inactive", routeId: route.id });
  }
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const bodyResult = await readLimitedRequestBody(request, maxBodyBytes);
  if (!bodyResult.ok) {
    return jsonResponse(bodyResult.status, { ok: false, error: bodyResult.error, maxBodyBytes });
  }
  const rawBody = bodyResult.body;
  if (route.signature) {
    const verified = verifyWebhookSignature(route, rawBody, request.headers, options.resolveSecret ?? defaultWebhookSecretResolver);
    if (!verified.ok) {
      return jsonResponse(verified.status, { ok: false, error: verified.error, routeId: route.id });
    }
  }
  try {
    const result = options.store.materializeWebhookRequest({
      route,
      rawBody,
      headers: Object.fromEntries(request.headers.entries()),
      receivedAt: new Date(),
    });
    return jsonResponse(202, {
      ok: true,
      routeId: route.id,
      automationId: route.automationId,
      eventId: result.event.id,
      dedupeKey: result.event.dedupeKey,
      materialized: result.materialized.map((entry) => ({
        automationId: entry.automation.id,
        runId: entry.run.id,
        actionIds: entry.actions.map((action) => action.id),
      })),
    });
  } catch (error) {
    const message = error instanceof SyntaxError ? "malformed_json" : "webhook_materialization_failed";
    return jsonResponse(error instanceof SyntaxError ? 400 : 422, { ok: false, error: message, routeId: route.id });
  }
}

export function verifyWebhookSignature(
  route: WebhookRoute,
  rawBody: Uint8Array,
  headers: Headers,
  resolveSecret: WebhookSecretResolver = defaultWebhookSecretResolver,
): { ok: true } | { ok: false; status: number; error: string } {
  const signature = route.signature;
  if (!signature) return { ok: true };
  const headerName = signature.header ?? "x-hasna-signature";
  const observedHeader = headers.get(headerName);
  if (!observedHeader) return { ok: false, status: 401, error: "webhook_signature_missing" };
  const secret = resolveSecret(route);
  if (!secret) return { ok: false, status: 503, error: "webhook_secret_unavailable" };
  const observed = signature.prefix
    ? observedHeader.startsWith(signature.prefix) ? observedHeader.slice(signature.prefix.length) : ""
    : observedHeader;
  const encoding = signature.encoding ?? "hex";
  const expected = createHmac("sha256", secret).update(rawBody).digest(encoding);
  if (!timingSafeStringEqual(observed, expected, encoding)) {
    return { ok: false, status: 401, error: "webhook_signature_invalid" };
  }
  return { ok: true };
}

export async function runDaemon(parsed: ParsedArgs): Promise<number> {
  ensureAutomationsDataDir();
  writeFileSync(daemonPidFilePath(), `${process.pid}\n`, { mode: 0o600 });
  const options = parseRunOptions(parsed.rest.slice(1));
  const store = new AutomationsStore();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    let first = true;
    while (!stopping) {
      const lease = store.heartbeatDaemon({ ttlMs: options.ttlMs, metadata: { mode: "run" } });
      if (first || options.once) {
        output(parsed, { ok: true, leaseId: lease.id, pid: lease.pid, heartbeatAt: lease.heartbeat_at, once: options.once }, () => {
          console.log(`automations-daemon heartbeat ${lease.id}`);
        });
      }
      if (options.once) return 0;
      first = false;
      await Bun.sleep(options.intervalMs);
    }
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    store.close();
  }
}

function parseRunOptions(args: string[]): DaemonRunOptions {
  const options: DaemonRunOptions = {
    once: false,
    intervalMs: 5000,
    ttlMs: 15000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--once") {
      options.once = true;
    } else if (arg.startsWith("--interval-ms=")) {
      options.intervalMs = Number(arg.slice("--interval-ms=".length));
    } else if (arg === "--interval-ms") {
      options.intervalMs = Number(args[++index]);
    } else if (arg.startsWith("--ttl-ms=")) {
      options.ttlMs = Number(arg.slice("--ttl-ms=".length));
    } else if (arg === "--ttl-ms") {
      options.ttlMs = Number(args[++index]);
    } else {
      throw new Error(`Unknown run option: ${arg}`);
    }
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 100) {
    throw new Error("--interval-ms must be at least 100");
  }
  if (!Number.isFinite(options.ttlMs) || options.ttlMs < options.intervalMs) {
    throw new Error("--ttl-ms must be greater than or equal to --interval-ms");
  }
  return options;
}

function parseServeOptions(args: string[]): DaemonServeOptions {
  const options: DaemonServeOptions = {
    host: "127.0.0.1",
    port: 7391,
    intervalMs: 5000,
    ttlMs: 15000,
    maxBodyBytes: 1024 * 1024,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--host") {
      options.host = args[++index];
    } else if (arg.startsWith("--port=")) {
      options.port = Number(arg.slice("--port=".length));
    } else if (arg === "--port") {
      options.port = Number(args[++index]);
    } else if (arg.startsWith("--interval-ms=")) {
      options.intervalMs = Number(arg.slice("--interval-ms=".length));
    } else if (arg === "--interval-ms") {
      options.intervalMs = Number(args[++index]);
    } else if (arg.startsWith("--ttl-ms=")) {
      options.ttlMs = Number(arg.slice("--ttl-ms=".length));
    } else if (arg === "--ttl-ms") {
      options.ttlMs = Number(args[++index]);
    } else if (arg.startsWith("--max-body-bytes=")) {
      options.maxBodyBytes = Number(arg.slice("--max-body-bytes=".length));
    } else if (arg === "--max-body-bytes") {
      options.maxBodyBytes = Number(args[++index]);
    } else {
      throw new Error(`Unknown serve option: ${arg}`);
    }
  }
  if (!options.host) throw new Error("--host is required");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 100) {
    throw new Error("--interval-ms must be at least 100");
  }
  if (!Number.isFinite(options.ttlMs) || options.ttlMs < options.intervalMs) {
    throw new Error("--ttl-ms must be greater than or equal to --interval-ms");
  }
  if (!Number.isInteger(options.maxBodyBytes) || options.maxBodyBytes < 1) {
    throw new Error("--max-body-bytes must be a positive integer");
  }
  return options;
}

function defaultWebhookSecretResolver(route: WebhookRoute): string | undefined {
  const envKeys = [
    `HASNA_AUTOMATIONS_WEBHOOK_SECRET_${envKey(route.id)}`,
    `AUTOMATIONS_WEBHOOK_SECRET_${envKey(route.id)}`,
    route.signature ? `HASNA_AUTOMATIONS_SECRET_${envKey(route.signature.secretRef.replace(/^secret:\/\//, ""))}` : undefined,
  ].filter((key): key is string => Boolean(key));
  for (const key of envKeys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

function envKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function readLimitedRequestBody(
  request: Request,
  maxBodyBytes: number,
): Promise<{ ok: true; body: Uint8Array } | { ok: false; status: number; error: string }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^[0-9]+$/.test(contentLength)) return { ok: false, status: 400, error: "invalid_content_length" };
    if (Number(contentLength) > maxBodyBytes) return { ok: false, status: 413, error: "webhook_payload_too_large" };
  }
  if (!request.body) return { ok: true, body: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel();
      return { ok: false, status: 413, error: "webhook_payload_too_large" };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

function timingSafeStringEqual(observed: string, expected: string, encoding: "hex" | "base64"): boolean {
  const canonicalObserved = canonicalDigest(observed, encoding);
  if (!canonicalObserved) return false;
  const observedBuffer = Buffer.from(canonicalObserved, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (observedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(observedBuffer, expectedBuffer);
}

function canonicalDigest(value: string, encoding: "hex" | "base64"): string | undefined {
  if (encoding === "hex") {
    if (!/^[0-9a-fA-F]{64}$/.test(value)) return undefined;
    return value.toLowerCase();
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
  return value;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function parseGlobalArgs(argv: string[]): ParsedArgs {
  const rest: string[] = [];
  let json = false;
  let dir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      rest.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--json" || arg === "-j") {
      json = true;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
      continue;
    }
    if (arg === "--dir") {
      dir = argv[++index];
      continue;
    }
    rest.push(...argv.slice(index));
    break;
  }
  return { json, dir, rest };
}

function output(parsed: ParsedArgs, value: unknown, human: () => void): void {
  if (parsed.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  human();
}

function printHelp(): void {
  console.log(`automations-daemon ${packageVersion()}

Usage:
  automations-daemon [--dir <path>] [--json] status
  automations-daemon [--dir <path>] [--json] run [--once] [--interval-ms <ms>] [--ttl-ms <ms>]
  automations-daemon [--dir <path>] [--json] serve [--host <host>] [--port <port>] [--max-body-bytes <bytes>]`);
}

function packageVersion(): string {
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync(packagePath, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

if (import.meta.main) {
  process.exit(await runAutomationsDaemonCli());
}
